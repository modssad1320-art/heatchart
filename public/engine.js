// Motor do mapa de liquidações — port fiel da lógica do site (LiquidationHeatmapPage).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HeatEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STEP = 5 * 60000;
  const LEVS = [5, 10, 25, 50, 100];
  const WEIGHTS = { 5: 0.1, 10: 0.25, 25: 0.3, 50: 0.2, 100: 0.15 };
  const MMR = 0.005;
  const clamp01 = e => Math.max(0, Math.min(1, e));

  // preço de liquidação de uma posição aberta em `entry` com alavancagem `lev`
  function liqPrice(entry, lev, side, mmr = MMR) {
    return side === 'long' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr);
  }

  // menor múltiplo "redondo" (1, 2, 5 × 10^k) do tick que é >= alvo
  function niceSize(tick, target) {
    for (let n = 1; n < 1e9; n *= 10)
      for (const r of [1, 2, 5]) if (r * n * tick >= target * 0.999999999) return +(r * n * tick).toPrecision(12);
    return target;
  }

  function makeGrid(price, size, span = 0.3) {
    const i0 = Math.floor(price * (1 - span) / size), i1 = Math.ceil(price * (1 + span) / size);
    return { size, i0, n: Math.max(1, i1 - i0) };
  }

  // Simulação: passo a passo (candles de 5 min). `steps` = [{t,open,high,low,close,vol,takerBuy,oi}]
  function simulate(steps, grid, opts, prevOi) {
    const mmr = opts.mmr ?? MMR;
    const lev = LEVS.map(L => [L, opts.weights[L] ?? 0]).filter(([, w]) => w > 0);
    const wsum = lev.reduce((a, [, w]) => a + w, 0) || 1;
    const { size, i0, n } = grid;
    const long = new Float32Array(n), short = new Float32Array(n);
    const cols = [], times = [], events = [];
    let prev = prevOi;
    for (const st of steps) {
      // 1) o preço atravessou níveis: essas posições foram liquidadas
      const lo = Math.floor(st.low / size) - i0;
      for (let k = Math.max(0, lo); k < n; k++) if (long[k] > 0) { events.push({ t: st.t, side: 'long', price: (k + i0 + 0.5) * size, usd: long[k] }); long[k] = 0; }
      const hi = Math.floor(st.high / size) - i0;
      for (let k = Math.min(n - 1, hi); k >= 0; k--) if (short[k] > 0) { events.push({ t: st.t, side: 'short', price: (k + i0 + 0.5) * size, usd: short[k] }); short[k] = 0; }
      // 2) variação do open interest
      if (prev !== undefined && prev > 0) {
        const d = st.oi - prev;
        if (d > 0) {
          const tp = (st.high + st.low + st.close) / 3;
          const usd = d * tp;
          const buy = st.vol > 0 ? Math.min(0.85, Math.max(0.15, st.takerBuy / st.vol)) : 0.5;
          for (const [entry, ew] of [[st.low, 0.2], [(st.low + tp) / 2, 0.2], [tp, 0.2], [(st.high + tp) / 2, 0.2], [st.high, 0.2]]) {
            for (const [L, w] of lev) {
              const amt = w / wsum * usd * ew;
              const lp = liqPrice(entry, L, 'long', mmr), sp = liqPrice(entry, L, 'short', mmr);
              const li = Math.floor(lp / size) - i0, si = Math.floor(sp / size) - i0;
              if (li >= 0 && li < n && lp < st.low) long[li] += amt * buy;
              if (si >= 0 && si < n && sp > st.high) short[si] += amt * (1 - buy);
            }
          }
        } else if (d < 0) {
          const f = Math.max(0, 1 + d / prev); // posições fechadas
          for (let k = 0; k < n; k++) { long[k] *= f; short[k] *= f; }
        }
      }
      prev = st.oi;
      const col = new Float32Array(n);
      for (let k = 0; k < n; k++) col[k] = long[k] + short[k];
      cols.push(col); times.push(st.t);
    }
    return { grid, times, cols, long, short, events };
  }

  // junta várias exchanges (soma nos passos de tempo em comum)
  function merge(list) {
    if (list.length === 1) return list[0];
    const first = list[0], n = first.grid.n;
    const sum = arrs => { const o = new Float32Array(n); for (const a of arrs) for (let k = 0; k < n; k++) o[k] += a[k]; return o; };
    const maps = list.map(x => new Map(x.times.map((t, i) => [t, x.cols[i]])));
    const times = first.times.filter(t => maps.every(m => m.has(t)));
    return {
      grid: first.grid, times,
      cols: times.map(t => sum(maps.map(m => m.get(t)))),
      long: sum(list.map(x => x.long)), short: sum(list.map(x => x.short)),
      events: list.flatMap(x => x.events).sort((a, b) => a.t - b.t)
    };
  }

  // Clusters de um lado (long abaixo / short acima) dentro de `reachPct` % do preço
  function findClusters(arr, grid, price, side, reachPct) {
    const { size, i0, n } = grid;
    const c = Math.floor(price / size) - i0, l = Math.ceil(price * reachPct / 100 / size);
    const u = side === 'long' ? Math.max(0, c - l) : Math.max(0, c);
    const d = side === 'long' ? Math.min(n - 1, c) : Math.min(n - 1, c + l);
    if (d <= u) return [];
    const f = [];
    for (let k = u; k <= d; k++) f.push(arr[k]);
    const p = f.map((_, k) => {
      let num = 0, den = 0;
      for (let e = -2; e <= 2; e++) { const v = f[k + e]; if (v === undefined) continue; const w = 3 - Math.abs(e); num += v * w; den += w; }
      return num / den;
    });
    const mx = Math.max(0, ...p);
    if (mx <= 0) return [];
    const total = f.reduce((a, b) => a + b, 0);
    const taken = new Uint8Array(p.length);
    const peaks = p.map((v, k) => ({ v, k })).filter(({ v, k }) => v >= 0.12 * mx && v >= (p[k - 1] ?? 0) && v >= (p[k + 1] ?? 0)).sort((a, b) => b.v - a.v);
    const out = [];
    for (const { v, k } of peaks) {
      if (taken[k]) continue;
      let i = k, s = k;
      while (i > 0 && !taken[i - 1] && p[i - 1] >= 0.35 * v && p[i - 1] <= p[i] * 1.05) i--;
      while (s < p.length - 1 && !taken[s + 1] && p[s + 1] >= 0.35 * v && p[s + 1] <= p[s] * 1.05) s++;
      let usd = 0;
      for (let e = i; e <= s; e++) { usd += f[e]; taken[e] = 1; }
      if (usd < 0.03 * total) continue;
      const lo = (u + i + i0) * size, hi = (u + s + 1 + i0) * size, peak = (u + k + i0 + 0.5) * size;
      out.push({ side, lo, hi, peak, usd, distPct: (peak - price) / price * 100 });
    }
    return out.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
  }

  // quanto o preço costuma se mover (em %) por US$ 1M de fluxo líquido a mercado (mediana, 24h)
  function impactPerMillion(steps) {
    const rets = [], nets = [];
    for (const r of steps.slice(-288)) {
      if (!(r.vol > 0) || !(r.open > 0)) continue;
      const net = Math.abs(2 * r.takerBuy - r.vol) * r.close;
      if (net <= 0) continue;
      rets.push(Math.abs(r.close - r.open) / r.open * 100);
      nets.push(net / 1e6);
    }
    if (rets.length < 12) return null;
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const m = med(nets);
    return m > 0 ? med(rets) / m : null;
  }

  const MERGE_GAP = 0.1, REACH_MARGIN = 1.25, POSSIBLE = 0.6;
  // Cascata: o "empurrão" dos clusters mais próximos chega ao núcleo do próximo?
  function cascade(clusters, price, impact) {
    if (!clusters.length || !impact) return null;
    const side = clusters[0].side, isLong = side === 'long';
    const a = [];
    for (const c of clusters) {
      const last = a[a.length - 1];
      const gap = last ? (isLong ? last.lo - c.hi : c.lo - last.hi) / price : Infinity;
      if (last && gap * 100 < MERGE_GAP) {
        const big = last.usd >= c.usd ? last : c;
        a[a.length - 1] = { ...last, lo: Math.min(last.lo, c.lo), hi: Math.max(last.hi, c.hi), peak: big.peak, usd: last.usd + c.usd, distPct: (big.peak - price) / price * 100 };
      } else a.push(c);
    }
    const hops = [];
    let chainUsd = 0, endPrice = 0, likely = false, ratio = 0;
    for (let i = 0; i < a.length; i++) {
      const c = a[i], edge = isLong ? c.lo : c.hi;
      const push = c.usd / 1e6 * impact;
      const next = a[i + 1] ?? null;
      const gapPct = next ? Math.abs(next.peak - edge) / edge * 100 : null;
      const reaches = gapPct !== null && push >= gapPct * REACH_MARGIN;
      hops.push({ cluster: c, pushPct: push, gapPct, next, reaches });
      chainUsd += c.usd;
      endPrice = isLong ? edge * (1 - push / 100) : edge * (1 + push / 100);
      if (gapPct !== null && gapPct > 0) ratio = Math.max(ratio, push / gapPct);
      if (!reaches) break;
      likely = true;
    }
    const first = a[0], trigger = isLong ? first.hi : first.lo;
    return { side, trigger, triggerDistPct: (trigger - price) / price * 100, hops, chainUsd, endPrice, verdict: likely ? 'likely' : ratio >= POSSIBLE ? 'possible' : 'unlikely' };
  }

  // totais long/short dentro de ±reachPct do preço
  function sumRange(P, price, reachPct) {
    const { size, i0, n } = P.grid;
    const a = Math.max(0, Math.floor(price * (1 - reachPct / 100) / size) - i0);
    const b = Math.min(n - 1, Math.floor(price * (1 + reachPct / 100) / size) - i0);
    let long = 0, short = 0;
    for (let k = a; k <= b; k++) { long += P.long[k]; short += P.short[k]; }
    return { long, short };
  }

  // Alinha candles de 5 min com a série de open interest (OI no fim de cada candle)
  function buildSteps(klines, oiPts, liveOi, takerMap) {
    const key = t => Math.round(t / STEP) * STEP;
    const map = new Map(oiPts.map(e => [key(e.t), e.oi]));
    const lastKey = oiPts.length ? key(oiPts[oiPts.length - 1].t) : 0;
    const out = [];
    let first, prev;
    for (const k of klines) {
      const start = map.get(k.t);
      let end = map.get(k.t + STEP);
      if (end === undefined) end = (k.t + 3e5 > lastKey && liveOi) ? liveOi.oi : prev;
      if (end === undefined) continue;
      if (first === undefined) { if (start === undefined) continue; first = start; }
      prev = end;
      const u = takerMap && takerMap.get(k.t);
      const hasTb = Number.isFinite(k.takerBuy);
      out.push({
        t: k.t, open: k.open, high: k.high, low: k.low, close: k.close,
        vol: hasTb ? k.vol : (u ? u.vol : k.vol),
        takerBuy: hasTb ? k.takerBuy : (u ? u.takerBuy : k.vol / 2),
        oi: end
      });
    }
    return out.length && first !== undefined ? { steps: out, prevOi: first } : null;
  }

  // Rampa de cores (ABGR em Uint32): roxo -> azul -> ciano -> verde -> amarelo -> branco, misturada ao fundo
  function makeLUT(bg = [11, 14, 20]) {
    const stops = [[0, [30, 14, 58]], [0.2, [72, 30, 130]], [0.4, [40, 92, 190]], [0.58, [18, 170, 170]], [0.74, [80, 210, 90]], [0.88, [245, 225, 40]], [1, [255, 250, 230]]];
    const lut = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      const r = n / 255;
      let i = 0;
      while (i < stops.length - 2 && r > stops[i + 1][0]) i++;
      const [a, ca] = stops[i], [b, cb] = stops[i + 1];
      const l = clamp01((r - a) / (b - a));
      const u = n === 0 ? 0 : 0.35 + 0.65 * Math.min(1, r * 2);
      const d = [0, 1, 2].map(e => Math.round(bg[e] + (ca[e] + (cb[e] - ca[e]) * l - bg[e]) * u));
      lut[n] = (255 << 24) | (d[2] << 16) | (d[1] << 8) | d[0];
    }
    return lut;
  }

  // mesmo formato compacto do site: 1.2k, 14M, 7.3M, 1.2B
  function fmtNum(e) {
    const t = Math.abs(e);
    return t >= 1e9 ? (e / 1e9).toFixed(1) + 'B' : t >= 1e6 ? (e / 1e6).toFixed(t >= 1e7 ? 0 : 1) + 'M' : t >= 1e3 ? (e / 1e3).toFixed(t >= 1e4 ? 0 : 1) + 'k' : t >= 100 ? e.toFixed(0) : t >= 10 ? e.toFixed(1) : t >= 1 ? e.toFixed(2) : t === 0 ? '0' : e.toFixed(3);
  }
  const fmtUsd = v => '$' + fmtNum(v);

  return { STEP, LEVS, WEIGHTS, liqPrice, niceSize, makeGrid, simulate, merge, findClusters, impactPerMillion, cascade, sumRange, buildSteps, makeLUT, fmtUsd, clamp01 };
});
