// Motor de confluência (regras explicáveis, sem "caixa preta"): junta Heatmap + Order Flow em todos os
// timeframes e devolve zonas de compra/venda com entrada, stop, alvos e os motivos de cada uma.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnalysisCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TFS = ['1m', '5m', '15m', '1h', '4h'];
  const TF_W = { '1m': 0.4, '5m': 0.6, '15m': 0.8, '1h': 1.0, '4h': 1.2 };           // peso do timeframe
  const HEAT_RANGES = ['1h', '4h', '12h', '24h'];
  const HEAT_W = { '1h': 0.6, '4h': 0.8, '12h': 1.0, '24h': 1.1 };                    // peso da janela do heatmap
  const CVD_WINDOW = { '1m': 60, '5m': 48, '15m': 40, '1h': 30, '4h': 20 };           // barras olhadas no CVD
  const KIND_LABEL = { fvg: 'FVG', ce: 'Linha de 50%', liq: 'Cluster de liquidação', wall: 'Parede do livro', big: 'Grandes trades', fp: 'Footprint', cvd: 'CVD' };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sum = a => a.reduce((x, y) => x + y, 0);

  function fmtUsd(v) {
    const t = Math.abs(v);
    return '$' + (t >= 1e9 ? (v / 1e9).toFixed(1) + 'B' : t >= 1e6 ? (v / 1e6).toFixed(t >= 1e7 ? 0 : 1) + 'M' : t >= 1e3 ? (v / 1e3).toFixed(t >= 1e4 ? 0 : 1) + 'k' : v.toFixed(0));
  }

  // ---------- leitura de CVD por timeframe ----------
  function readCvd(tf, bars, atr) {
    const n = Math.min(CVD_WINDOW[tf], bars.length);
    if (n < 8) return null;
    const w = bars.slice(-n);
    const dSum = sum(w.map(b => b.delta)), vSum = sum(w.map(b => b.vol));
    const pct = vSum > 0 ? dSum / vSum : 0, move = w[w.length - 1].close - w[0].open, moveAtr = atr > 0 ? move / atr : 0;
    const trend = pct > 0.04 ? 'up' : pct < -0.04 ? 'down' : 'flat';
    let div = null;
    if (moveAtr < -1 && pct > 0.06) div = 'bull';        // preço caiu, mas o agressor foi comprador (absorção)
    else if (moveAtr > 1 && pct < -0.06) div = 'bear';   // preço subiu, mas o agressor foi vendedor (exaustão)
    return { trend, div, pct, moveAtr, strength: clamp(Math.abs(pct) / 0.2, 0, 1), bars: n };
  }

  // ---------- paredes do livro (snapshot) ----------
  function findWalls(book, price, tick) {
    if (!book) return [];
    const size = Math.max(tick, Math.round(price * 0.00025 / tick) * tick);
    const agg = (list, side) => {
      const m = new Map();
      for (const [p, q] of list) {
        if (Math.abs(p - price) / price > 0.01) continue;
        if (side === 'bid' ? p > price : p < price) continue;
        const k = Math.floor(p / size);
        m.set(k, (m.get(k) || 0) + q);
      }
      return m;
    };
    const out = [];
    for (const [side, list] of [['bid', book.bids], ['ask', book.asks]]) {
      const m = agg(list, side), vals = [...m.values()].sort((a, b) => a - b);
      if (vals.length < 6) continue;
      const med = vals[Math.floor(vals.length / 2)] || 0;
      if (med <= 0) continue;
      [...m.entries()].filter(([, q]) => q >= 3 * med).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .forEach(([k, q]) => out.push({ side: side === 'bid' ? 'long' : 'short', lo: k * size, hi: (k + 1) * size, qty: q, rel: q / med }));
    }
    return out;
  }

  // ---------- grandes trades por preço ----------
  function bigTradeLevels(bt, price) {
    if (!bt || !bt.buckets || !bt.threshold) return [];
    const rows = new Map(), size = price * 0.0004;
    for (const b of bt.buckets) {
      const tot = b.buy + b.sell;
      if (tot < bt.threshold) continue;
      const k = Math.floor((b.pv / tot) / size), r = rows.get(k) || { buy: 0, sell: 0 };
      r.buy += b.buy; r.sell += b.sell; rows.set(k, r);
    }
    const out = [];
    for (const [k, r] of rows) {
      const tot = r.buy + r.sell, share = r.buy / tot, lo = k * size, hi = lo + size;
      if (share >= 0.65 && hi <= price * 1.0005) out.push({ side: 'long', lo, hi, tot, share, rel: tot / (bt.threshold * 3) });
      else if (share <= 0.35 && lo >= price * 0.9995) out.push({ side: 'short', lo, hi, tot, share: 1 - share, rel: tot / (bt.threshold * 3) });
    }
    return out;
  }

  // ---------- viés geral (−100 vendedor … +100 comprador) ----------
  function computeBias(inp, cvdRead) {
    const parts = [];
    const add = (name, value, note) => parts.push({ name, value: Math.round(value * 10) / 10, note });
    let wsum = 0, cv = 0, dv = 0;
    for (const tf of TFS) { const c = cvdRead[tf]; if (!c) continue; wsum += TF_W[tf]; cv += TF_W[tf] * (c.trend === 'up' ? 1 : c.trend === 'down' ? -1 : 0) * c.strength; dv += TF_W[tf] * (c.div === 'bull' ? 1 : c.div === 'bear' ? -1 : 0); }
    if (wsum) {
      add('CVD (todos os timeframes)', 30 * cv / wsum, 'quem está agredindo mais, ponderado pelo timeframe');
      add('Divergências de CVD', 15 * dv / wsum, 'preço contra o fluxo agressivo (absorção/exaustão)');
    }
    let ls = 0, ll = 0, hw = 0;
    for (const r of HEAT_RANGES) { const h = inp.heat && inp.heat[r]; if (!h) continue; ls += HEAT_W[r] * h.totals.short; ll += HEAT_W[r] * h.totals.long; hw += HEAT_W[r]; }
    if (hw && ls + ll > 0) add('Liquidações (heatmap)', 20 * (ls - ll) / (ls + ll), 'o lado com mais liquidação acumulada tende a atrair o preço');
    if (inp.book) {
      const near = (list, f) => sum(list.filter(([p]) => Math.abs(p - inp.price) / inp.price <= 0.005 && f(p)).map(([, q]) => q));
      const b = near(inp.book.bids, p => p <= inp.price), a = near(inp.book.asks, p => p >= inp.price);
      if (a + b > 0) add('Livro (±0,5%)', 10 * (b - a) / (a + b), 'pesa pouco: ordens do livro podem sumir');
    }
    let fv = 0, fw = 0;
    for (const tf of TFS) {
      const t = inp.tfs[tf]; if (!t) continue;
      for (const f of t.fvgs) {
        if (f.state === 'filled' || f.state === 'broken' || f.score < 60) continue;
        if (Math.abs((f.lo + f.hi) / 2 - inp.price) > 3 * (t.atr || inp.price * 0.002)) continue;
        const sgn = f.dir === 'bull' ? 1 : -1;
        if ((f.dir === 'bull' && f.rem <= inp.price) || (f.dir === 'bear' && f.rem >= inp.price)) { fv += sgn * TF_W[tf] * f.score / 100; fw += TF_W[tf] * f.score / 100; }
      }
    }
    if (fw) add('Gaps (FVG) perto do preço', 15 * clamp(fv / Math.max(fw, 1), -1, 1), 'gaps de alta abaixo = suporte; de baixa acima = resistência');
    if (inp.bigTrades && inp.bigTrades.buckets && inp.bigTrades.threshold) {
      let b = 0, s = 0;
      for (const k of inp.bigTrades.buckets) if (k.buy + k.sell >= inp.bigTrades.threshold && k.t >= (inp.now || Date.now()) - 15 * 60000) { b += k.buy; s += k.sell; }
      if (b + s > 0) add('Grandes trades (15 min)', 10 * (b - s) / (b + s), 'agressão grande recente');
    }
    const score = clamp(Math.round(sum(parts.map(p => p.value))), -100, 100);
    const label = score >= 25 ? 'comprador' : score >= 10 ? 'levemente comprador' : score <= -25 ? 'vendedor' : score <= -10 ? 'levemente vendedor' : 'neutro';
    return { score, label, parts };
  }

  // ---------- análise principal ----------
  function analyze(inp) {
    const { price, tick } = inp, now = inp.now || Date.now();
    const atrOf = tf => (inp.tfs[tf] && inp.tfs[tf].atr) || price * ({ '1m': 0.0006, '5m': 0.0012, '15m': 0.002, '1h': 0.004, '4h': 0.008 }[tf]);
    const atr15 = atrOf('15m'), atr1h = atrOf('1h');
    const warnings = [];
    const cvdRead = {};
    for (const tf of TFS) { const t = inp.tfs[tf]; cvdRead[tf] = t ? readCvd(tf, t.bars, atrOf(tf)) : null; if (!t) warnings.push(`Sem candles de ${tf}.`); }
    if (!inp.heat || !Object.keys(inp.heat).length) warnings.push('Heatmap de liquidações indisponível (open interest não carregou).');
    if (!inp.book) warnings.push('Livro de ofertas indisponível: sem paredes.');
    const bias = computeBias(inp, cvdRead);

    // 1) níveis individuais de cada ferramenta
    const levels = [];
    const push = l => { l.mid = (l.lo + l.hi) / 2; levels.push(l); };
    for (const tf of TFS) {
      const t = inp.tfs[tf]; if (!t) continue;
      const cands = [];
      for (const f of t.fvgs) {
        if (f.state === 'filled' || f.state === 'broken' || f.score < 45 || f.sizeAtr < 0.1) continue;
        const bull = f.dir === 'bull';
        const lo = bull ? f.lo : f.rem, hi = bull ? f.rem : f.hi;
        if (hi < lo) continue;
        if (bull ? lo > price * 1.001 : hi < price * 0.999) continue;                          // já foi atravessado
        const stateMult = f.state === 'held' ? 1.15 : f.forming ? 0.7 : 1;
        const w = TF_W[tf] * (f.score / 100) * stateMult * clamp(f.sizeAtr / 0.6, 0.6, 1.2);
        cands.push({ side: bull ? 'long' : 'short', kind: 'fvg', tf, lo, hi, w, fvg: f,
          label: `${bull ? 'FVG de alta' : 'FVG de baixa'} ${tf} (nota ${f.score}, ${{ open: 'aberto', tested: 'testado', held: 'defendido' }[f.state] || f.state})`, ce: (f.lo + f.hi) / 2 });
      }
      cands.sort((a, b) => b.w - a.w).slice(0, 6).forEach(c => {
        push(c);
        if (c.fvg.score >= 60) push({ side: c.side, kind: 'ce', tf, lo: c.ce - tick, hi: c.ce + tick, w: 0.25 * TF_W[tf] * c.fvg.score / 100, label: `Linha de 50% do ${c.label.split(' (')[0]}` });
      });
    }
    for (const r of HEAT_RANGES) {
      const h = inp.heat && inp.heat[r]; if (!h) continue;
      const maxUsd = Math.max(1, ...h.clusters.long.map(c => c.usd), ...h.clusters.short.map(c => c.usd));
      for (const side of ['long', 'short']) for (const c of h.clusters[side]) {
        push({ side, kind: 'liq', tf: r, lo: c.lo, hi: c.hi, w: HEAT_W[r] * (0.55 + 0.45 * c.usd / maxUsd), usd: c.usd,
          label: `Cluster de liquidação ${side === 'long' ? 'long' : 'short'} ${r.toUpperCase()} ${fmtUsd(c.usd)} (${side === 'long' ? 'varredura de stops de compradores' : 'varredura de stops de vendedores'})` });
      }
    }
    for (const w of findWalls(inp.book, price, tick)) push({ side: w.side, kind: 'wall', lo: w.lo, hi: w.hi, w: 0.5 * Math.min(1.3, w.rel / 5), label: `Parede de ${w.side === 'long' ? 'compra (bid)' : 'venda (ask)'} no livro (${w.rel.toFixed(1)}× a mediana)` });
    for (const b of bigTradeLevels(inp.bigTrades, price)) push({ side: b.side, kind: 'big', lo: b.lo, hi: b.hi, w: 0.45 * clamp(b.rel, 0.3, 1), label: `Grandes trades ${b.side === 'long' ? 'comprando' : 'vendendo'} (${Math.round(b.share * 100)}% do volume grande)` });
    for (const s of inp.fpStacks || []) {
      const side = s.side === 'buy' ? 'long' : 'short';
      if (side === 'long' ? s.lo > price * 1.001 : s.hi < price * 0.999) continue;
      const age = clamp(1 - (now - s.t) / (6 * 3600e3), 0.5, 1);
      push({ side, kind: 'fp', tf: s.tf, lo: s.lo, hi: s.hi, w: 0.55 * TF_W[s.tf] * clamp(s.n / 4, 0.5, 1) * age, label: `Footprint ${s.tf}: ${s.n} desequilíbrios ${s.side === 'buy' ? 'de compra' : 'de venda'} empilhados` });
    }

    // 2) funde níveis próximos em zonas
    const mergeGap = Math.max(price * 0.0012, 0.35 * atr15), maxWidth = Math.max(2.5 * atr15, price * 0.004);
    const zones = [];
    for (const side of ['long', 'short']) {
      const ls = levels.filter(l => l.side === side).sort((a, b) => a.mid - b.mid);
      let cur = null;
      const flush = () => { if (cur) zones.push(cur); cur = null; };
      for (const l of ls) {
        if (cur && l.lo <= cur.hi + mergeGap && Math.max(cur.hi, l.hi) - Math.min(cur.lo, l.lo) <= maxWidth) { cur.lo = Math.min(cur.lo, l.lo); cur.hi = Math.max(cur.hi, l.hi); cur.levels.push(l); }
        else { flush(); cur = { side, lo: l.lo, hi: l.hi, levels: [l] }; }
      }
      flush();
    }

    // 3) pontuação
    const bigDiv = { bull: 0, bear: 0 }, cvdAlign = { up: 0, down: 0 };
    for (const tf of TFS) { const c = cvdRead[tf]; if (!c) continue; if (c.div) bigDiv[c.div] += TF_W[tf]; if (['15m', '1h', '4h'].includes(tf) && c.trend !== 'flat') cvdAlign[c.trend] += TF_W[tf] * c.strength; }
    for (const z of zones) {
      z.mid = (z.lo + z.hi) / 2;
      z.dist = z.side === 'long' ? Math.max(0, price - z.hi) : Math.max(0, z.lo - price);
      z.inside = price >= z.lo - 0.0005 * price && price <= z.hi + 0.0005 * price;
      // CVD como confirmação: só conta para zonas relativamente próximas
      if (z.dist <= 4 * atr1h) {
        const w = z.side === 'long' ? Math.min(1, 0.35 * bigDiv.bull + 0.3 * cvdAlign.up) : Math.min(1, 0.35 * bigDiv.bear + 0.3 * cvdAlign.down);
        if (w > 0.15) z.levels.push({ side: z.side, kind: 'cvd', lo: z.lo, hi: z.hi, mid: z.mid, w, label: z.side === 'long' ? 'CVD/delta com compradores (divergência ou alinhamento entre timeframes)' : 'CVD/delta com vendedores (divergência ou alinhamento entre timeframes)' });
      }
      const byKind = {};
      for (const l of z.levels) (byKind[l.kind] = byKind[l.kind] || []).push(l.w);
      let raw = 0;
      for (const k of Object.keys(byKind)) { const a = byKind[k].sort((x, y) => y - x); raw += a[0] + 0.3 * sum(a.slice(1)); }
      z.kinds = Object.keys(byKind);
      if (z.kinds.length >= 2) raw += 0.25 * (z.kinds.length - 1);
      raw *= 1 + 0.15 * (z.side === 'long' ? 1 : -1) * bias.score / 100;
      z.raw = raw;
      z.score = Math.round(100 * (1 - Math.exp(-raw / 2.0)) / (1 + 0.06 * z.dist / atr1h));
      z.levels.sort((a, b) => b.w - a.w);
    }

    // 4) setups (entrada, stop, alvos)
    const buildSetup = (z, i) => {
      const long = z.side === 'long';
      const top = z.levels.find(l => l.kind === 'fvg') || null;
      const ceLvl = top && top.ce >= z.lo && top.ce <= z.hi ? top.ce : null;
      const entry = ceLvl !== null ? ceLvl : z.mid;
      const tfs = z.levels.map(l => l.tf).filter(Boolean).filter(t => TFS.includes(t));
      const domTf = tfs.length ? tfs.sort((a, b) => TF_W[b] - TF_W[a])[0] : '15m';
      const atrRef = atrOf(domTf);
      let edge = long ? z.lo : z.hi;
      const liq = z.levels.filter(l => l.kind === 'liq');
      if (liq.length) edge = long ? Math.min(edge, ...liq.map(l => l.lo)) : Math.max(edge, ...liq.map(l => l.hi));
      let stop = long ? edge - 0.5 * atrRef : edge + 0.5 * atrRef;
      let risk = Math.abs(entry - stop);
      const minRisk = Math.max(0.5 * atr15, price * 0.0008);
      if (risk < minRisk) { stop = long ? entry - minRisk : entry + minRisk; risk = minRisk; }
      // alvos: zonas do lado oposto, nesta ordem de distância
      const others = zones.filter(o => o.side !== z.side && (long ? o.lo > entry + 0.8 * risk : o.hi < entry - 0.8 * risk))
        .sort((a, b) => (long ? a.lo - b.lo : b.hi - a.hi));
      const targets = [];
      for (const o of others) {
        const p = long ? o.lo : o.hi, rr = Math.abs(p - entry) / risk;
        if (rr > 8) break;                                                                      // alvo irreal: usa os técnicos
        if (targets.length && Math.abs(p - targets[targets.length - 1].price) < 0.5 * risk) continue;
        const lead = o.levels[0];
        targets.push({ price: p, rr, label: lead ? lead.label.replace(/\s*\(.*\)$/, '') : 'zona oposta', kinds: o.kinds, tool: true });
        if (targets.length === 3) break;
      }
      for (const m of [1.5, 2.5, 4]) {
        if (targets.length >= 3) break;
        const p = long ? entry + m * risk : entry - m * risk;
        if (targets.some(t => Math.abs(t.price - p) < 0.5 * risk)) continue;
        targets.push({ price: p, rr: m, label: `alvo técnico ${m}R`, kinds: [], tool: false });
      }
      targets.sort((a, b) => a.rr - b.rr);
      const status = z.inside ? 'agora' : 'aguardar';
      const conf = z.score >= 70 ? 'alta' : z.score >= 50 ? 'média' : 'baixa';
      const flags = [];
      if (targets[0] && targets[0].rr < 1.2) flags.push('R:R do 1º alvo baixo');
      if (z.kinds.length < 2) flags.push('apenas uma ferramenta na zona');
      if (z.kinds.every(k => k === 'liq' || k === 'cvd')) flags.push('zona de varredura de liquidez: espere o preço varrer o cluster e mostrar reversão antes de entrar');
      if (z.dist > 3 * atr1h) flags.push('zona distante do preço');
      return {
        rank: i + 1, side: z.side, score: z.score, confidence: conf, zone: [z.lo, z.hi], entry, entryLabel: ceLvl !== null ? `50% do ${top.label.split(' (')[0]}` : 'meio da zona',
        aggressive: long ? z.hi : z.lo, deep: long ? z.lo : z.hi, stop, riskPct: risk / entry * 100, targets, status, distPct: z.dist / price * 100,
        distAtr: z.dist / atr1h, kinds: z.kinds, reasons: z.levels.slice(0, 9).map(l => ({ kind: l.kind, text: l.label, range: l.kind === 'cvd' ? null : [l.lo, l.hi] })), flags,
        invalidation: `fechamento de candle ${domTf} ${long ? 'abaixo' : 'acima'} de ${stop.toFixed(decimalsFor(tick))}`
      };
    };
    const pick = side => zones.filter(z => z.side === side && z.score >= 30 && (z.kinds.length >= 2 || z.raw >= 1.2)).sort((a, b) => b.score - a.score).slice(0, 3).map(buildSetup);
    const longs = pick('long'), shorts = pick('short');

    // 5) resumo em texto
    const summary = [];
    summary.push(`Viés geral ${bias.label} (${bias.score > 0 ? '+' : ''}${bias.score}).`);
    const rng = inp.heat && (inp.heat['24h'] || inp.heat['12h']);
    if (rng) {
      const a = rng.clusters.short[0], b = rng.clusters.long[0];
      summary.push(`Liquidação acumulada até ${rng.totals.reach}%: shorts ${fmtUsd(rng.totals.short)} acima, longs ${fmtUsd(rng.totals.long)} abaixo.` + (a ? ` Cluster short mais próximo em ${a.peak.toFixed(decimalsFor(tick))} (${fmtUsd(a.usd)}).` : '') + (b ? ` Cluster long mais próximo em ${b.peak.toFixed(decimalsFor(tick))} (${fmtUsd(b.usd)}).` : ''));
    }
    const ups = TFS.filter(t => cvdRead[t] && cvdRead[t].trend === 'up'), downs = TFS.filter(t => cvdRead[t] && cvdRead[t].trend === 'down');
    summary.push(`CVD: compradores agressivos em ${ups.length ? ups.join(', ') : 'nenhum timeframe'}; vendedores em ${downs.length ? downs.join(', ') : 'nenhum timeframe'}.`);
    const divs = TFS.filter(t => cvdRead[t] && cvdRead[t].div).map(t => `${t} ${cvdRead[t].div === 'bull' ? 'altista' : 'baixista'}`);
    if (divs.length) summary.push(`Divergências de CVD: ${divs.join(', ')}.`);
    for (const r of ['24h', '12h', '4h']) {
      const h = inp.heat && inp.heat[r];
      if (!h) continue;
      if (h.cascade.down && h.cascade.down.verdict === 'likely') summary.push(`Heatmap ${r.toUpperCase()}: risco de cascata de liquidações long para baixo (até ${h.cascade.down.endPrice.toFixed(decimalsFor(tick))}).`);
      if (h.cascade.up && h.cascade.up.verdict === 'likely') summary.push(`Heatmap ${r.toUpperCase()}: risco de cascata de liquidações short para cima (até ${h.cascade.up.endPrice.toFixed(decimalsFor(tick))}).`);
    }
    if (!longs.length && !shorts.length) summary.push('Nenhuma zona com confluência suficiente agora: melhor aguardar o preço chegar perto de níveis com mais de uma ferramenta.');

    const ladder = zones.filter(z => z.score >= 25).sort((a, b) => b.mid - a.mid).slice(0, 16)
      .map(z => ({ side: z.side, lo: z.lo, hi: z.hi, score: z.score, kinds: z.kinds, distPct: (z.mid - price) / price * 100 }));
    const tfRead = {};
    for (const tf of TFS) {
      const t = inp.tfs[tf]; if (!t) continue;
      const open = t.fvgs.filter(f => f.state !== 'filled' && f.state !== 'broken' && f.score >= 60);
      const nb = open.filter(f => f.dir === 'bull' && f.rem <= price).sort((a, b) => b.rem - a.rem)[0], nr = open.filter(f => f.dir === 'bear' && f.rem >= price).sort((a, b) => a.rem - b.rem)[0];
      tfRead[tf] = { cvd: cvdRead[tf], atr: atrOf(tf), nearestBull: nb ? [nb.lo, nb.rem, nb.score] : null, nearestBear: nr ? [nr.rem, nr.hi, nr.score] : null, openBull: open.filter(f => f.dir === 'bull').length, openBear: open.filter(f => f.dir === 'bear').length };
    }
    const heatRead = {};
    for (const r of HEAT_RANGES) { const h = inp.heat && inp.heat[r]; if (h) heatRead[r] = { long: h.totals.long, short: h.totals.short, reach: h.totals.reach, down: h.cascade.down && h.cascade.down.verdict, up: h.cascade.up && h.cascade.up.verdict }; }
    return { price, now, bias, longs, shorts, summary, ladder, tfRead, heatRead, warnings };
  }

  function decimalsFor(tick) { return Math.max(0, Math.min(10, Math.round(-Math.log10(tick) + 0.49))); }

  return { TFS, TF_W, HEAT_RANGES, HEAT_W, KIND_LABEL, analyze, readCvd, findWalls, bigTradeLevels, computeBias, fmtUsd, decimalsFor };
});
