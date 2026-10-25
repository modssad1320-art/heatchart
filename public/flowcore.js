// Núcleo puro do Order Flow (footprint e fair value gaps), compartilhado entre a aba Order Flow e a análise.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ATR_N = 14, VOL_N = 20, IMB = 3;
  const ROWS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5];
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const pickMult = (tick, minPrice) => { for (const n of ROWS) if (n * tick >= minPrice * 0.999999999) return n; return ROWS[ROWS.length - 1]; };

  // minuteData: Map(minuto -> Map(linhaBase -> [compra, venda]))
  function addTrade(minuteData, rowBase, tick, t, price, qty, isSell) {
    const minute = Math.floor(t / 6e4) * 6e4;
    let m = minuteData.get(minute);
    if (!m) { m = new Map(); minuteData.set(minute, m); }
    const row = Math.floor(Math.round(price / tick) / rowBase), cur = m.get(row);
    if (cur) cur[+!!isSell] += qty; else m.set(row, isSell ? [0, qty] : [qty, 0]);
    return minute;
  }

  // footprint de uma barra com linhas de k × linha base
  function buildFootprint(minuteData, rowBase, bar, tfMs, k) {
    const t0 = bar.time * 1e3, agg = new Map();
    for (let m = t0; m < t0 + tfMs; m += 6e4) {
      const mm = minuteData.get(m);
      if (!mm) continue;
      for (const [base, [b, s]] of mm) {
        const r = Math.floor(base * rowBase / k), cur = agg.get(r);
        if (cur) { cur[0] += b; cur[1] += s; } else agg.set(r, [b, s]);
      }
    }
    const rows = [...agg.entries()].map(([r, [b, s]]) => ({ r, b, s, buyImb: false, sellImb: false })).sort((a, b) => a.r - b.r);
    let maxTot = 0, maxAbsDelta = 0, poc = null, buy = 0, sell = 0, maxSide = 0;
    for (const row of rows) {
      const tot = row.b + row.s;
      if (tot > maxTot) { maxTot = tot; poc = row.r; }
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(row.b - row.s));
      maxSide = Math.max(maxSide, row.b, row.s);
      buy += row.b; sell += row.s;
    }
    const byRow = new Map(rows.map(r => [r.r, r]));
    for (const row of rows) { // desequilíbrio diagonal 3:1
      const below = byRow.get(row.r - 1), above = byRow.get(row.r + 1);
      row.buyImb = row.b > 0 && row.b >= IMB * (below ? below.s : 0) && row.b >= 0.1 * maxSide;
      row.sellImb = row.s > 0 && row.s >= IMB * (above ? above.b : 0) && row.s >= 0.1 * maxSide;
    }
    return { k, rows, maxAbsDelta, maxSide, poc, buy, sell };
  }
  function sumInZone(fp, tick, lo, hi) {
    let b = 0, s = 0, imbBuy = 0, imbSell = 0;
    const rowPx = fp.k * tick;
    for (const r of fp.rows) {
      const c = (r.r + 0.5) * rowPx;
      if (c < lo || c > hi) continue;
      b += r.b; s += r.s;
      if (r.buyImb) imbBuy++;
      if (r.sellImb) imbSell++;
    }
    return { b, s, imbBuy, imbSell };
  }
  function longestRun(rows, key) {
    let best = 0, run = 0, prev = null;
    for (const r of rows) { if (r[key] && prev !== null && r.r === prev + 1 && run > 0) run++; else run = r[key] ? 1 : 0; prev = r.r; best = Math.max(best, run); }
    return best;
  }
  function atrSeries(bars) {
    const n = bars.length, atr = new Array(n).fill(0), trs = [];
    let sum = 0;
    for (let o = 0; o < n; o++) {
      const b = bars[o], pc = o ? bars[o - 1].close : b.close;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
      trs.push(tr); sum += tr;
      if (o >= ATR_N) sum -= trs[o - ATR_N];
      atr[o] = sum / Math.min(o + 1, ATR_N);
    }
    return atr;
  }

  // ctx = { tick, gapRowMult(atr), footprint(bar, mult) }
  function computeFvgs(bars, ctx) {
    const { tick } = ctx, n = bars.length, atr = atrSeries(bars), avgVol = new Array(n).fill(0);
    let volSum = 0;
    for (let o = 0; o < n; o++) {
      avgVol[o] = o ? volSum / Math.min(o, VOL_N) : bars[o].vol;
      volSum += bars[o].vol;
      if (o >= VOL_N) volSum -= bars[o - VOL_N].vol;
    }
    const out = [];
    for (let r = 1; r + 1 < n; r++) {
      const prev = bars[r - 1], mid = bars[r], next = bars[r + 1];
      let dir = null, lo = 0, hi = 0;
      if (next.low > prev.high) { dir = 'bull'; lo = prev.high; hi = next.low; }
      else if (next.high < prev.low) { dir = 'bear'; lo = next.high; hi = prev.low; }
      if (!dir) continue;
      const sgn = dir === 'bull' ? 1 : -1;
      const a = atr[r - 1] || atr[r] || mid.high - mid.low || tick;
      const size = hi - lo, body = Math.abs(mid.close - mid.open), disp = Math.sign(mid.close - mid.open) === sgn;
      const volRatio = avgVol[r] ? mid.vol / avgVol[r] : 1;
      const netPct = mid.vol ? sgn * mid.delta / mid.vol : 0;
      const mult = ctx.gapRowMult(a), fp = ctx.footprint(mid, mult), traded = fp.buy + fp.sell;
      let fpInfo = null;
      if (fp.rows.length > 0 && traded >= 0.5 * mid.vol) {
        const z = sumInZone(fp, tick, lo, hi), range = mid.high - mid.low || size;
        const share = traded ? (z.b + z.s) / traded : 0, thin = size > 0 ? share / (size / range) : 1;
        fpInfo = { stacked: longestRun(fp.rows, dir === 'bull' ? 'buyImb' : 'sellImb'), gapShare: share, thin, pocPx: fp.poc === null ? null : (fp.poc + 0.5) * mult * tick };
      }
      const sDisp = disp ? 25 * clamp01(body / a / 1.5) : 0, sVol = 25 * clamp01((volRatio - 1) / 2), sDelta = 25 * clamp01(netPct / 0.3);
      const score = fpInfo ? sDisp + sVol + sDelta + 15 * clamp01(fpInfo.stacked / 3) + 10 * clamp01((1 - fpInfo.thin) / 0.7) : (sDisp + sVol + sDelta) * (100 / 75);
      let rem = dir === 'bull' ? hi : lo, firstTest = null, fillIdx = null, heldIdx = null, brokenIdx = null, test = null;
      for (let t = r + 2; t < n; t++) {
        const b = bars[t];
        if (dir === 'bull' ? b.low < rem : b.high > rem) {
          if (firstTest === null) {
            firstTest = t;
            const f2 = ctx.footprint(b, mult), z2 = sumInZone(f2, tick, lo, hi);
            test = { t: b.time * 1e3, barDelta: b.delta, zoneDelta: z2.b - z2.s, hasFp: f2.rows.length > 0 };
          }
          rem = dir === 'bull' ? Math.max(lo, b.low) : Math.min(hi, b.high);
        }
        if (firstTest !== null && heldIdx === null && fillIdx === null && (dir === 'bull' ? b.close > hi : b.close < lo)) heldIdx = t;
        if (dir === 'bull' ? b.low <= lo : b.high >= hi) {
          fillIdx = t;
          if (dir === 'bull' ? b.close < lo : b.close > hi) brokenIdx = t;
          break;
        }
      }
      const filledPct = size > 0 ? (dir === 'bull' ? hi - rem : rem - lo) / size : 1;
      const state = brokenIdx !== null ? 'broken' : fillIdx !== null ? 'filled' : heldIdx !== null ? 'held' : firstTest !== null ? 'tested' : 'open';
      out.push({
        id: `${dir}:${mid.time}`, dir, i: r, t: mid.time * 1e3, lo, hi, size, atr: a, sizeAtr: size / a, bodyAtr: body / a, volRatio, netPct, delta: mid.delta,
        fp: fpInfo, score: Math.round(score), forming: r + 1 === n - 1, rem, filledPct, fillIdx, state, test
      });
    }
    return out;
  }

  return { ROWS, pickMult, addTrade, buildFootprint, sumInZone, longestRun, atrSeries, computeFvgs, clamp01 };
});
