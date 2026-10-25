// Aba "IA · Entradas": coleta os dados (Heatmap + Order Flow, todos os timeframes) e mostra as zonas de compra/venda.
(function () {
  'use strict';
  const E = window.HeatEngine, FC = window.FlowCore, D = window.HeatData, AC = window.AnalysisCore;
  const $ = s => document.querySelector(s);
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5 };
  const RANGE_STEPS = { '1h': 12, '4h': 48, '12h': 144, '24h': 288 };
  const REACH = { '1h': 1.5, '4h': 2.5, '12h': 4, '24h': 5 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const decimals = AC.decimalsFor;

  // ---------- coleta ----------
  const mkBars = list => {
    const bars = list.map(k => ({ time: Math.floor(k.t / 1000), open: k.open, high: k.high, low: k.low, close: k.close, vol: k.vol, tb: k.takerBuy, delta: 0, cvdOpen: 0, cvd: 0 }));
    for (let i = 0; i < bars.length; i++) { const b = bars[i]; b.delta = 2 * b.tb - b.vol; b.cvdOpen = i ? bars[i - 1].cvd : 0; b.cvd = b.cvdOpen + b.delta; }
    return bars;
  };

  async function fetchTrades(sym, pages) {
    const latest = await D.binGet(`/fapi/v1/aggTrades?symbol=${sym}&limit=1000`);
    if (!latest.length) return [];
    const all = [...latest], firstId = latest[0].a, jobs = [];
    for (let k = 1; k <= pages; k++) { const to = firstId - 1000 * (k - 1), from = Math.max(0, to - 1000); if (to <= 0) break; jobs.push([from, to]); }
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const [from, to] = jobs[idx++];
        try {
          const j = await D.binGet(`/fapi/v1/aggTrades?symbol=${sym}&fromId=${from}&limit=1000`);
          for (const t of j) if (t.a < to && t.a >= from) all.push(t);
        } catch (e) { if (/429|418/.test(String(e && e.message))) return; }
        await sleep(120);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return all.map(t => ({ T: t.T, p: Number(t.p), q: Number(t.q), m: t.m })).sort((a, b) => a.T - b.T);
  }

  async function collect(sym, pages, progress) {
    const tick = sym.tick, warnings = [];
    let done = 0;
    const total = 8;
    const tick1 = label => { done++; progress(`${label} (${done}/${total})`); };
    const k5P = D.binKlines(sym.binance, '5m', 1000);
    const klP = Promise.all(AC.TFS.map(tf => (tf === '5m' ? k5P : D.binKlines(sym.binance, tf, 1000)).then(r => { tick1(`Candles ${tf}`); return r; })));
    const depthP = D.binGet(`/fapi/v1/depth?symbol=${sym.binance}&limit=1000`).then(r => { tick1('Livro de ofertas'); return r; });
    const tradesP = fetchTrades(sym.binance, pages).then(r => { tick1('Trades recentes'); return r; });
    const heatP = k5P.then(k5 => Promise.allSettled(['binance', 'bybit'].map(ex => D.fetchExchange(ex, sym.binance, 288, k5)))).then(r => { tick1('Open interest'); return r; });
    const [klR, depthR, tradesR, heatR] = await Promise.allSettled([klP, depthP, tradesP, heatP]);
    if (klR.status !== 'fulfilled') throw new Error('candles: ' + (klR.reason && klR.reason.message));
    const klines = Object.fromEntries(AC.TFS.map((tf, i) => [tf, klR.value[i]]));
    const bars = Object.fromEntries(AC.TFS.map(tf => [tf, mkBars(klines[tf])]));
    const price = bars['1m'][bars['1m'].length - 1].close;

    // trades -> footprint por minuto + grandes trades por segundo
    const minuteData = new Map(), rowBase = FC.pickMult(tick, price * 1e-5);
    let trades = [], bigTrades = null, earliest = null;
    if (tradesR.status === 'fulfilled' && tradesR.value.length) {
      trades = tradesR.value; earliest = trades[0].T;
      const buckets = []; let cur = null, ema = 0;
      const push = b => { buckets.push(b); const t = b.buy + b.sell; ema = ema ? ema * 0.995 + t * 0.005 : t; };
      for (const t of trades) {
        FC.addTrade(minuteData, rowBase, tick, t.T, t.p, t.q, t.m);
        const k = Math.floor(t.T / 1000) * 1000;
        if (!cur || cur.t !== k) { if (cur) push(cur); cur = { t: k, buy: 0, sell: 0, pv: 0 }; }
        if (t.m) cur.sell += t.q; else cur.buy += t.q;
        cur.pv += t.p * t.q;
      }
      if (cur) push(cur);
      bigTrades = { buckets, threshold: ema * 4 };
    } else warnings.push('Trades recentes indisponíveis: footprint e grandes trades ficaram de fora.');

    // FVGs, ATR e pilhas de desequilíbrio (footprint) por timeframe
    const tfs = {}, fpStacks = [];
    for (const tf of AC.TFS) {
      const b = bars[tf], atrArr = FC.atrSeries(b), atr = atrArr[atrArr.length - 1];
      const gapRowMult = a => Math.max(rowBase, FC.pickMult(tick, a / 25));
      const cache = new Map();
      const footprint = (bar, mult) => { const key = bar.time + ':' + mult; let r = cache.get(key); if (!r) { r = FC.buildFootprint(minuteData, rowBase, bar, TF_MS[tf], mult); cache.set(key, r); } return r; };
      tfs[tf] = { bars: b, fvgs: FC.computeFvgs(b, { tick, gapRowMult, footprint }), atr };
      if (earliest !== null && ['1m', '5m', '15m'].includes(tf)) {
        const mult = gapRowMult(atr);
        for (const bar of b.slice(-60)) {
          if (bar.time * 1000 < earliest) continue;
          const fp = footprint(bar, mult);
          for (const [key, side] of [['buyImb', 'buy'], ['sellImb', 'sell']]) {
            let start = null, prev = null, run = 0;
            const close = () => { if (run >= 3) fpStacks.push({ tf, side, lo: start * mult * tick, hi: (prev + 1) * mult * tick, t: bar.time * 1000, n: run }); };
            for (const r of fp.rows) {
              if (r[key] && prev !== null && r.r === prev + 1 && run > 0) { run++; prev = r.r; }
              else { close(); if (r[key]) { start = r.r; prev = r.r; run = 1; } else { run = 0; prev = r.r; } }
            }
            close();
          }
        }
      }
    }

    // heatmap de liquidações em 4 janelas (1H, 4H, 12H, 24H)
    let heat = {};
    const book = depthR.status === 'fulfilled' ? { bids: depthR.value.bids.map(([p, q]) => [Number(p), Number(q)]), asks: depthR.value.asks.map(([p, q]) => [Number(p), Number(q)]) } : null;
    if (depthR.status !== 'fulfilled') warnings.push('Livro de ofertas indisponível: sem paredes.');
    const heatRaw = heatR.status === 'fulfilled' ? heatR.value : [];
    const dat = {};
    ['binance', 'bybit'].forEach((ex, i) => { if (heatRaw[i] && heatRaw[i].status === 'fulfilled' && heatRaw[i].value) dat[ex] = heatRaw[i].value; });
    if (dat.binance || dat.bybit) {
      const impact = E.impactPerMillion(dat.binance ? dat.binance.steps : []);
      for (const r of AC.HEAT_RANGES) {
        const size = E.niceSize(tick, price * REACH[r] / 100 / 160), grid = E.makeGrid(price, size), sims = [];
        for (const ex of Object.keys(dat)) {
          const d = dat[ex], st = d.steps.slice(-(RANGE_STEPS[r] + 2)), idx = d.steps.length - st.length;
          sims.push(E.simulate(st, grid, { weights: E.WEIGHTS }, idx > 0 ? d.steps[idx - 1].oi : d.prevOi));
        }
        const P = E.merge(sims);
        const clusters = { long: E.findClusters(P.long, grid, price, 'long', REACH[r]), short: E.findClusters(P.short, grid, price, 'short', REACH[r]) };
        heat[r] = { clusters, totals: { ...E.sumRange(P, price, REACH[r]), reach: REACH[r] }, cascade: { down: E.cascade(clusters.long, price, impact), up: E.cascade(clusters.short, price, impact) } };
      }
      if (!dat.bybit) warnings.push('Bybit indisponível: o heatmap usou só a Binance.');
      if (!dat.binance) warnings.push('Binance (open interest) indisponível: o heatmap usou só a Bybit.');
    }
    return { tick, price, now: Date.now(), tfs, heat, book, bigTrades, fpStacks, collectWarnings: warnings, tradeCount: trades.length };
  }

  // ---------- interface ----------
  const UI = (function () {
    let cfg = null, symbol = null, built = false, running = false, timer = null, result = null, gen = 0, auto = false;
    try { auto = localStorage.getItem('analysis:auto') === '1'; } catch (e) {}
    const pxf = v => v.toFixed(decimals(symbol.tick));
    const usd = AC.fmtUsd;
    const pct = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
    const KIND = { fvg: 'FVG', ce: '50%', liq: 'Liquidação', wall: 'Parede', big: 'Grandes trades', fp: 'Footprint', cvd: 'CVD' };
    const TAGC = { fvg: 'k-fvg', ce: 'k-ce', liq: 'k-liq', wall: 'k-wall', big: 'k-big', fp: 'k-fp', cvd: 'k-cvd' };

    function setStatus(t, cls) { const el = $('#aiStatus'); el.textContent = t; el.className = `ai-status ${cls || ''}`; }

    function setupCard(s) {
      const long = s.side === 'long', cls = long ? 'long' : 'short';
      const tg = s.kinds.map(k => `<span class="kt ${TAGC[k]}">${KIND[k]}</span>`).join('');
      const tps = s.targets.map((t, i) => `<div class="tp"><span class="n">TP${i + 1}</span><b class="num">${pxf(t.price)}</b><span class="rr num">${t.rr.toFixed(1)}R</span><span class="lb">${esc(t.label)}</span></div>`).join('');
      const why = s.reasons.map(r => `<li><span class="kt ${TAGC[r.kind]}">${KIND[r.kind]}</span> ${esc(r.text)}${r.range ? ` <span class="num rg">${pxf(r.range[0])}–${pxf(r.range[1])}</span>` : ''}</li>`).join('');
      const st = s.status === 'agora' ? '<span class="pill now">preço dentro da zona</span>' : `<span class="pill wait">aguardar · ${s.distPct.toFixed(2)}% (${s.distAtr.toFixed(1)} ATR 1h) do preço</span>`;
      return `<article class="setup ${cls}">
        <header><div><b>${long ? 'COMPRA' : 'VENDA'} #${s.rank}</b> <span class="conf c-${s.confidence === 'alta' ? 'hi' : s.confidence === 'média' ? 'mid' : 'lo'}">confiança ${s.confidence} · ${s.score}</span></div>${st}</header>
        <div class="tools">${tg}</div>
        <div class="grid3">
          <div><span class="k">Zona de entrada</span><b class="num">${pxf(Math.min(...s.zone))} – ${pxf(Math.max(...s.zone))}</b></div>
          <div><span class="k">Entrada ideal</span><b class="num">${pxf(s.entry)}</b><small>${esc(s.entryLabel)}</small></div>
          <div><span class="k">Stop</span><b class="num ${long ? 't-rose' : 't-rose'}">${pxf(s.stop)}</b><small>risco ${s.riskPct.toFixed(2)}%</small></div>
        </div>
        <div class="tps">${tps}</div>
        <p class="inv"><b>Invalidação:</b> ${esc(s.invalidation)}.</p>
        ${s.flags.length ? `<p class="flags">⚠ ${s.flags.map(esc).join(' · ')}</p>` : ''}
        <details><summary>Por que esta zona (${s.reasons.length} confluências)</summary><ul class="why">${why}</ul></details>
      </article>`;
    }
    function tfTable(r) {
      const rows = AC.TFS.map(tf => {
        const t = r.tfRead[tf]; if (!t) return '';
        const c = t.cvd;
        const cv = c ? `<span class="${c.trend === 'up' ? 'text-bull' : c.trend === 'down' ? 'text-bear' : ''}">${c.trend === 'up' ? 'compradores' : c.trend === 'down' ? 'vendedores' : 'neutro'}</span> <small class="num">(${(c.pct * 100).toFixed(1)}%)</small>${c.div ? ` · <b class="${c.div === 'bull' ? 'text-bull' : 'text-bear'}">div. ${c.div === 'bull' ? 'altista' : 'baixista'}</b>` : ''}` : '—';
        const z = a => (a ? `<span class="num">${pxf(a[0])}–${pxf(a[1])}</span> <small>(${a[2]})</small>` : '—');
        return `<tr><td><b>${tf}</b></td><td>${cv}</td><td class="num">${pxf(t.atr)}</td><td>${z(t.nearestBull)}</td><td>${z(t.nearestBear)}</td><td class="num"><span class="text-bull">${t.openBull}</span> / <span class="text-bear">${t.openBear}</span></td></tr>`;
      }).join('');
      const heat = AC.HEAT_RANGES.map(h => {
        const x = r.heatRead[h]; if (!x) return '';
        const v = { likely: 'risco', possible: 'possível', unlikely: '—' };
        return `<tr><td><b>${h.toUpperCase()}</b></td><td class="num">até ${x.reach}%</td><td class="num text-bear">${usd(x.long)}</td><td class="num text-bull">${usd(x.short)}</td><td>${v[x.down] || '—'}</td><td>${v[x.up] || '—'}</td></tr>`;
      }).join('');
      return `<div class="tbl"><table><thead><tr><th>TF</th><th>CVD</th><th>ATR</th><th>FVG alta + próximo (abaixo)</th><th>FVG baixa + próximo (acima)</th><th>Abertos ↑/↓</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div class="tbl"><table><thead><tr><th>Heatmap</th><th>Alcance</th><th>Longs a liquidar</th><th>Shorts a liquidar</th><th>Cascata ↓</th><th>Cascata ↑</th></tr></thead><tbody>${heat}</tbody></table></div>`;
    }
    function ladder(r) {
      const rows = []; let placed = false;
      for (const z of r.ladder) {
        if (!placed && z.distPct < 0) { rows.push(`<div class="lr now"><span class="num">preço ${pxf(r.price)}</span></div>`); placed = true; }
        rows.push(`<div class="lr ${z.side}"><span class="b">${z.side === 'long' ? 'compra' : 'venda'}</span><span class="num">${pxf(z.lo)} – ${pxf(z.hi)}</span><span class="num d">${pct(z.distPct)}</span><span class="sc num">${z.score}</span><span class="ks">${z.kinds.map(k => `<span class="kt ${TAGC[k]}">${KIND[k]}</span>`).join('')}</span></div>`);
      }
      if (!placed) rows.push(`<div class="lr now"><span class="num">preço ${pxf(r.price)}</span></div>`);
      return rows.join('');
    }
    function render(r, inp) {
      const b = r.bias, pos = (b.score + 100) / 2;
      const parts = b.parts.map(p => `<li><span>${esc(p.name)}</span><b class="num ${p.value >= 0 ? 'text-bull' : 'text-bear'}">${p.value > 0 ? '+' : ''}${p.value}</b><small>${esc(p.note)}</small></li>`).join('');
      $('#aiSummary').innerHTML = `<div class="ai-head"><div><span class="k">Preço</span><b class="num big">${pxf(r.price)}</b></div>
        <div class="biasbox"><span class="k">Viés geral (todas as ferramentas)</span><b class="${b.score > 9 ? 'text-bull' : b.score < -9 ? 'text-bear' : ''}">${b.label} (${b.score > 0 ? '+' : ''}${b.score})</b>
        <div class="biasbar"><i style="left:${pos}%"></i></div><div class="bl"><span>vendedor</span><span>neutro</span><span>comprador</span></div></div></div>
        <ul class="sum">${r.summary.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
        <details><summary>Como o viés foi calculado</summary><ul class="parts">${parts}</ul></details>
        ${(r.warnings.concat(inp.collectWarnings)).length ? `<p class="flags">⚠ ${r.warnings.concat(inp.collectWarnings).map(esc).join(' · ')}</p>` : ''}`;
      $('#aiLong').innerHTML = `<h2>Melhores zonas de compra</h2>${r.longs.length ? r.longs.map(setupCard).join('') : '<p class="empty">Nenhuma zona de compra com confluência suficiente agora.</p>'}`;
      $('#aiShort').innerHTML = `<h2>Melhores zonas de venda</h2>${r.shorts.length ? r.shorts.map(setupCard).join('') : '<p class="empty">Nenhuma zona de venda com confluência suficiente agora.</p>'}`;
      $('#aiTf').innerHTML = tfTable(r);
      $('#aiMap').innerHTML = ladder(r);
      $('#aiPrice').textContent = pxf(r.price);
    }

    async function run() {
      if (running || !symbol) return;
      running = true; const my = ++gen;
      $('#aiRun').disabled = true;
      setStatus('Analisando…', 'busy');
      try {
        const inp = await collect(symbol, result ? 14 : 24, t => my === gen && setStatus(`Analisando… ${t}`, 'busy'));
        if (my !== gen) return;
        result = AC.analyze(inp);
        render(result, inp);
        const hh = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setStatus(`Atualizado às ${hh} · ${inp.tradeCount.toLocaleString()} trades analisados`, 'ok');
      } catch (e) {
        if (my === gen) setStatus(`Falha ao coletar dados: ${e.message}. Se for HTTP 451/403, a Binance está bloqueando a sua rede/região.`, 'err');
      } finally { running = false; $('#aiRun').disabled = false; }
    }
    function schedule() { clearInterval(timer); timer = null; if (auto) timer = setInterval(run, 90000); }

    function renderMenu() {
      $('#aiSym').innerHTML = cfg.symbols.map(s => `<option value="${s.binance}" ${s.binance === symbol.binance ? 'selected' : ''}>${s.binance} · ${s.group === 'gold' ? 'Ouro' : s.name}</option>`).join('');
    }
    function build() {
      built = true;
      $('#aiRun').onclick = () => run();
      $('#aiAuto').checked = auto;
      $('#aiAuto').onchange = e => { auto = e.target.checked; try { localStorage.setItem('analysis:auto', auto ? '1' : '0'); } catch (x) {} schedule(); };
      $('#aiSym').onchange = e => { const s = cfg.symbols.find(x => x.binance === e.target.value); if (!s) return; symbol = s; cfg.onSymbolChange(s); result = null; clear(); run(); };
    }
    function clear() { for (const id of ['#aiSummary', '#aiLong', '#aiShort', '#aiTf', '#aiMap']) $(id).innerHTML = ''; $('#aiPrice').textContent = ''; }

    return {
      init(c) { cfg = c; },
      start(sym) { symbol = sym; if (!built) build(); renderMenu(); result = null; clear(); schedule(); run(); },
      stop() { gen++; clearInterval(timer); timer = null; running = false; const b = $('#aiRun'); if (b) b.disabled = false; },
      setSymbol(sym) { symbol = sym; renderMenu(); }
    };
  })();

  window.AnalysisUI = UI;
})();
