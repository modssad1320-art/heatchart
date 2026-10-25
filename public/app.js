// Clone do mapa de liquidações — porta da lógica do site, rodando 100% no seu navegador.
(function () {
  'use strict';
  const E = window.HeatEngine, LW = window.LightweightCharts;
  const $ = s => document.querySelector(s);
  const S = E.STEP;

  // ---------- configuração ----------
  const SYMBOLS = [
    { binance: 'BTCUSDT', ticker: 'BTC', name: 'Bitcoin', tick: 0.1, group: 'top' },
    { binance: 'ETHUSDT', ticker: 'ETH', name: 'Ethereum', tick: 0.01, group: 'top' },
    { binance: 'XAUUSDT', ticker: 'XAU', name: 'Ouro', tick: 0.01, group: 'gold' }
  ];
  const EXCHANGES = ['binance', 'bybit'];
  const RANGES = ['1h', '4h', '12h', '24h'];
  const EXCH_OPTS = ['all', 'binance', 'bybit'];
  const RANGE_MS = { '1h': 36e5, '4h': 4 * 36e5, '12h': 12 * 36e5, '24h': 24 * 36e5 };
  const RANGE_CANDLE = { '1h': { interval: '1m', ms: 6e4 }, '4h': { interval: '5m', ms: 3e5 }, '12h': { interval: '5m', ms: 3e5 }, '24h': { interval: '5m', ms: 3e5 } };
  const REACH = { '1h': 1.5, '4h': 2.5, '12h': 4, '24h': 5 }; // alcance (%) do mapa
  const DEFAULTS = { range: '24h', exchange: 'all', heatmap: true, profile: true, liquidations: true, cascade: true, leverage: { 5: true, 10: true, 25: true, 50: true, 100: true }, gain: 1 };
  const FONT = 'Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  const BG = [11, 14, 20], ROSE = [244, 63, 94], GREEN = [34, 197, 94];
  const MAX_LIVE = 200, REFRESH_MS = 30000;
  const LUT = E.makeLUT(BG);
  const LUT0 = LUT[1];
  const EX_LABEL = { all: 'Binance + Bybit', binance: 'Binance', bybit: 'Bybit' };
  const LAYER_LABEL = { heatmap: 'Heatmap', profile: 'Perfil', liquidations: 'Liquidações ao vivo', cascade: 'Cascata' };

  const U = v => E.fmtUsd(v);
  const G = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const decimals = tick => Math.max(0, Math.min(10, Math.round(-Math.log10(tick) + 0.49)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const D = window.HeatData;
  const { bybitSym, fetchExchange, binKlines, liqBinance, liqBybit } = D;

  // ---------- a ferramenta (gráfico + simulação) ----------
  function createTool(els, sym, initialOpts, onSnap) {
    let opts = { ...initialOpts, leverage: { ...initialOpts.leverage } };
    let destroyed = false;
    const timers = [], sockets = new Set();
    const dp = decimals(sym.tick), fmt = v => v.toFixed(dp);
    const ctxOv = els.overlay.getContext('2d'), ctxHeat = els.heat.getContext('2d'), ctxProf = els.profile.getContext('2d');
    const tfTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const tfFull = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

    let hover = null, version = 0, optTick = 0;
    const chart = LW.createChart(els.chart, {
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: '#cbd5e1', fontFamily: FONT },
      grid: { vertLines: { color: 'rgba(148,163,184,0.05)' }, horzLines: { color: 'rgba(148,163,184,0.05)' } },
      rightPriceScale: { borderColor: '#232a36', scaleMargins: { top: 0.04, bottom: 0.04 } },
      timeScale: { borderColor: '#232a36', timeVisible: true, secondsVisible: false, rightOffset: 8, tickMarkFormatter: t => tfTime.format(new Date(t * 1000)) },
      crosshair: { mode: LW.CrosshairMode.Normal },
      localization: { priceFormatter: fmt, timeFormatter: t => tfFull.format(new Date(t * 1000)) }
    });
    let basePrice = 0;
    const series = chart.addCandlestickSeries({
      upColor: 'rgba(34,197,94,0.9)', downColor: 'rgba(239,68,68,0.9)', borderVisible: false,
      wickUpColor: 'rgba(34,197,94,0.9)', wickDownColor: 'rgba(239,68,68,0.9)',
      priceFormat: { type: 'price', precision: dp, minMove: sym.tick },
      autoscaleInfoProvider: orig => {
        const r = orig();
        if (!r || !basePrice) return r;
        const m = REACH[opts.range] / 100;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, basePrice * (1 - m)), maxValue: Math.max(r.priceRange.maxValue, basePrice * (1 + m)) } };
      }
    });
    const toBar = c => ({ time: Math.floor(c.t / 1000), open: c.open, high: c.high, low: c.low, close: c.close });

    let candles = [], grid = null, data = {}, P = null, impact = null, price = null;
    let failed = [], loading = true, anyData = false, wsOk = false, lastLoad = null, lastError = '';
    let gen = 0, J = { long: [], short: [] };
    const liqs = [], liqIds = new Set(), liveTot = { long: 0, short: 0, since: Date.now() };
    const rc = () => RANGE_CANDLE[opts.range];
    const nSteps = () => RANGE_MS[opts.range] / S;

    function activeWeights() {
      const w = {};
      for (const L of E.LEVS) if (opts.leverage[L]) w[L] = E.WEIGHTS[L];
      return w;
    }

    // monta (ou remonta) a grade de preços e roda a simulação para cada exchange
    function rebuild() {
      const exs = opts.exchange === 'all' ? EXCHANGES : [opts.exchange];
      const p = price ?? candles[candles.length - 1]?.close;
      if (!p) return;
      const size = E.niceSize(sym.tick, p * REACH[opts.range] / 100 / 160);
      if (!grid || grid.size !== size || Math.abs(p / ((grid.i0 + grid.n / 2) * grid.size) - 1) > 0.1) grid = E.makeGrid(p, size);
      const sims = [];
      for (const ex of exs) {
        const d = data[ex];
        if (d) sims.push(E.simulate(d.steps, grid, { weights: activeWeights() }, d.prevOi));
      }
      P = sims.length ? E.merge(sims) : null;
      if (P) anyData = true;
      if (P) killLast(candles[candles.length - 1]);
      version++;
      emit();
    }

    // candle ao vivo: zera o que o preço acabou de atravessar
    function killLast(c) {
      if (!P || !c) return;
      const { size, i0, n } = P.grid, last = P.cols[P.cols.length - 1];
      let changed = false;
      for (let k = Math.max(0, Math.floor(c.low / size) - i0); k < n; k++) if (P.long[k] > 0) { if (last) last[k] -= P.long[k]; P.long[k] = 0; changed = true; }
      for (let k = Math.min(n - 1, Math.floor(c.high / size) - i0); k >= 0; k--) if (P.short[k] > 0) { if (last) last[k] -= P.short[k]; P.short[k] = 0; changed = true; }
      if (changed) version++;
    }

    async function load(initial) {
      const my = ++gen;
      if (initial) { loading = true; candles = []; P = null; data = {}; series.setData([]); version++; emit(); }
      for (let attempt = 0; !destroyed && my === gen; attempt++) {
        try {
          const steps = nSteps();
          const k5 = await binKlines(sym.binance, '5m', steps + 3);
          if (destroyed || my !== gen) return;
          const disp = rc().interval === '5m' ? k5 : await binKlines(sym.binance, rc().interval, RANGE_MS[opts.range] / rc().ms + 2);
          if (destroyed || my !== gen) return;
          const cutoff = Date.now() - RANGE_MS[opts.range] - rc().ms;
          candles = disp.filter(e => e.t >= cutoff);
          series.setData(candles.map(toBar));
          price = candles[candles.length - 1]?.close ?? price;
          basePrice = price ?? 0;
          if (initial) chart.timeScale().fitContent();
          const res = await Promise.allSettled(EXCHANGES.map(ex => fetchExchange(ex, sym.binance, steps, k5)));
          if (destroyed || my !== gen) return;
          const d = {};
          failed = [];
          const errs = [];
          res.forEach((r, i) => { if (r.status === 'fulfilled' && r.value) d[EXCHANGES[i]] = r.value; else { failed.push(EXCHANGES[i]); if (r.status === 'rejected') errs.push(`${EXCHANGES[i]}: ${r.reason && r.reason.message}`); } });
          if (!d.binance && !d.bybit) throw new Error('sem dados de open interest (' + errs.join(' | ') + ')');
          data = d;
          impact = E.impactPerMillion(d.binance ? d.binance.steps : []);
          lastLoad = Date.now(); loading = false; lastError = '';
          rebuild();
          return;
        } catch (e) {
          lastError = String(e && e.message || e);
          console.warn('[heatmap] falha ao carregar:', lastError);
          if (initial) emit();
          if (!initial) return;
          await sleep(Math.min(15000, 2000 * (attempt + 1)));
        }
      }
    }

    // ---------- websockets ----------
    function openWs(url, onOpen, onMsg, onClose) {
      if (destroyed) return;
      const ws = new WebSocket(url);
      sockets.add(ws);
      ws.onopen = () => onOpen(ws);
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMsg(m); };
      ws.onclose = () => { sockets.delete(ws); if (!destroyed) onClose(); };
      ws.onerror = () => ws.close();
    }
    let binPath = 0;
    const BIN_PATHS = ['/market/stream', '/stream'];
    const low = sym.binance.toLowerCase();
    function connectBinance() {
      let opened = false;
      openWs(`wss://fstream.binance.com${BIN_PATHS[binPath]}?streams=${low}@kline_${rc().interval}/${low}@forceOrder`,
        () => { opened = true; wsOk = true; emit(); },
        m => {
          const d = m && m.data;
          if (!d) return;
          if (d.e === 'kline' && d.k.i === rc().interval) onKline(d.k);
          else if (d.e === 'forceOrder' && d.o) pushLiq(liqBinance(d.o));
        },
        () => { wsOk = false; emit(); if (!opened) binPath = (binPath + 1) % BIN_PATHS.length; timers.push(setTimeout(connectBinance, 3000)); });
    }
    function connectBybit() {
      let ping = null;
      openWs('wss://stream.bybit.com/v5/public/linear',
        ws => { ws.send(JSON.stringify({ op: 'subscribe', args: [`allLiquidation.${bybitSym(sym.binance)}`] })); ping = setInterval(() => ws.readyState === 1 && ws.send('{"op":"ping"}'), 20000); },
        m => { if (typeof m.topic === 'string' && m.topic.startsWith('allLiquidation') && Array.isArray(m.data)) for (const o of m.data) pushLiq(liqBybit(o)); },
        () => { if (ping !== null) clearInterval(ping); timers.push(setTimeout(connectBybit, 3000)); });
    }
    function onKline(k) {
      const c = { t: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, vol: +k.v, takerBuy: +k.V };
      const last = candles[candles.length - 1];
      if (last && last.t === c.t) candles[candles.length - 1] = c;
      else if (!last || c.t > last.t) candles.push(c);
      else return;
      price = c.close;
      try { series.update(toBar(c)); } catch (e) {}
      killLast(c);
      emitSoon();
    }
    function pushLiq(e) {
      if (!e || liqIds.has(e.id)) return;
      if (liqIds.size > 5000) liqIds.clear();
      liqIds.add(e.id);
      liqs.unshift(e);
      if (liqs.length > MAX_LIVE) liqs.length = MAX_LIVE;
      liveTot[e.side] += e.usd;
      version++;
      emitSoon();
    }
    let emitTimer = null;
    function emitSoon() { if (emitTimer === null) emitTimer = setTimeout(() => { emitTimer = null; emit(); }, 500); }

    function emit() {
      if (destroyed) return;
      const p = price, reach = REACH[opts.range];
      let lc = [], sc = [], totals = { long: 0, short: 0, reach };
      if (P && p) {
        lc = E.findClusters(P.long, P.grid, p, 'long', reach);
        sc = E.findClusters(P.short, P.grid, p, 'short', reach);
        totals = { ...E.sumRange(P, p, reach), reach };
      }
      const exs = opts.exchange === 'all' ? EXCHANGES : [opts.exchange];
      onSnap({
        status: !anyData && loading ? 'connecting' : wsOk && P ? 'live' : P ? 'connecting' : 'down',
        loading, error: lastError, price: p, longClusters: lc, shortClusters: sc,
        longCascade: p ? E.cascade(lc, p, impact) : null, shortCascade: p ? E.cascade(sc, p, impact) : null,
        totals, impact, exchanges: exs.filter(x => data[x]), failed: failed.filter(x => exs.includes(x)),
        steps: P ? P.times.length : 0, updatedAt: lastLoad,
        live: liqs.filter(e => opts.exchange === 'all' || e.ex === opts.exchange).slice(0, 40), liveTotals: { ...liveTot }
      });
      J = { long: lc, short: sc };
    }

    // ---------- desenho ----------
    let W = 0, H = 0, Z = 1, raf = 0, lastKey = '', smooth = null;
    function resize() {
      Z = window.devicePixelRatio || 1;
      W = els.chart.clientWidth; H = els.chart.clientHeight;
      chart.resize(W, H);
      els.overlay.width = W * Z; els.overlay.height = H * Z; ctxOv.setTransform(Z, 0, 0, Z, 0, 0);
      els.heat.width = Math.max(1, W); els.heat.height = Math.max(1, H);
      els.profile.width = 128 * Z; els.profile.height = H * Z; ctxProf.setTransform(Z, 0, 0, Z, 0, 0);
      version++;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(els.chart);
    resize();

    function priceMap() {
      const p = price;
      if (!p) return null;
      const y0 = series.priceToCoordinate(p), y1 = series.priceToCoordinate(p * 1.01);
      if (y0 === null || y1 === null || y0 === y1) return null;
      const k = (y1 - y0) / (p * 0.01);
      return { y: v => y0 + (v - p) * k, p: y => p + (y - y0) / k };
    }
    function timeMap() {
      if (candles.length < 2) return null;
      const ts = chart.timeScale();
      const ta = candles[candles.length - 2].t, tb = candles[candles.length - 1].t;
      const xa = ts.timeToCoordinate(Math.floor(ta / 1000)), xb = ts.timeToCoordinate(Math.floor(tb / 1000));
      if (xa === null || xb === null || xb === xa) return null;
      const pxPerMs = (xb - xa) / (tb - ta), left = xb - (xb - xa) / 2;
      return t => left + (t - tb) * pxPerMs;
    }

    // suaviza cada coluna na direção do preço (gaussiana)
    function smoothed(Pm) {
      if (smooth && smooth.v === version) return smooth.cols;
      const sigma = Math.max(0.6, (price ?? 0) * 5e-4 / Pm.grid.size), half = Math.ceil(sigma * 2.5);
      const ker = Array.from({ length: 2 * half + 1 }, (_, i) => Math.exp(-((i - half) ** 2) / (2 * sigma * sigma)));
      const ks = ker.reduce((a, b) => a + b, 0), n = Pm.grid.n;
      const cols = Pm.cols.map(col => {
        const out = new Float32Array(n);
        for (let k = 0; k < n; k++) {
          const v = col[k];
          if (v <= 0) continue;
          for (let e = -half; e <= half; e++) { const j = k + e; if (j >= 0 && j < n) out[j] += v * ker[e + half] / ks; }
        }
        return out;
      });
      smooth = { v: version, cols };
      return cols;
    }

    function drawHeat(pm, tm, pw, ph) {
      const Pm = P, cols = smoothed(Pm), cw = els.heat.width, ch = els.heat.height;
      const img = ctxHeat.createImageData(cw, ch), px = new Uint32Array(img.data.buffer);
      const { size, i0, n } = Pm.grid, rows = Math.min(ch, Math.ceil(ph));
      const lo = new Int32Array(rows), hi = new Int32Array(rows);
      for (let y = 0; y < rows; y++) {
        const a = pm.p(y), b = pm.p(y + 1);
        const ia = Math.floor(Math.min(a, b) / size) - i0, ib = Math.floor(Math.max(a, b) / size) - i0;
        lo[y] = Math.max(0, ia);
        hi[y] = Math.min(n - 1, Math.max(ia, ib - +(ib > ia)));
      }
      const vals = [];
      let minLo = Infinity, maxHi = -Infinity;
      for (let y = 0; y < rows; y++) { if (lo[y] < minLo) minLo = lo[y]; if (hi[y] > maxHi) maxHi = hi[y]; }
      for (let c = 0; c < cols.length; c += Math.max(1, Math.floor(cols.length / 60))) {
        const col = cols[c];
        for (let k = minLo; k <= maxHi; k++) if (col[k] > 0) vals.push(col[k]);
      }
      vals.sort((a, b) => a - b);
      const ref = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))] : 1;
      const gain = opts.gain / (ref || 1);
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const x0 = Math.max(0, Math.floor(tm(Pm.times[c])));
        const x1 = Math.min(pw, c === Pm.cols.length - 1 ? pw : Math.ceil(tm(Pm.times[c] + S)));
        if (x1 <= x0) continue;
        for (let y = 0; y < rows; y++) {
          let mx = 0;
          if (lo[y] <= hi[y] && hi[y] >= 0 && lo[y] < n) for (let k = lo[y]; k <= hi[y]; k++) if (col[k] > mx) mx = col[k];
          const color = mx > 0 ? LUT[Math.max(2, Math.min(255, Math.round(E.clamp01(mx * gain) ** 0.75 * 255)))] : LUT0;
          const o = y * cw;
          for (let x = x0; x < x1; x++) px[o + x] = color;
        }
      }
      ctxHeat.putImageData(img, 0, 0);
    }

    function pill(x, y, text, color, align = 'right') {
      ctxOv.font = `600 10px ${FONT}`;
      const w = ctxOv.measureText(text).width + 10, left = align === 'right' ? x - w : x;
      ctxOv.fillStyle = 'rgba(11,14,20,0.82)'; ctxOv.strokeStyle = rgba(color, 0.7); ctxOv.lineWidth = 1;
      ctxOv.beginPath(); ctxOv.roundRect(left, y - 8, w, 16, 4); ctxOv.fill(); ctxOv.stroke();
      ctxOv.fillStyle = rgba(color, 1); ctxOv.textBaseline = 'middle'; ctxOv.textAlign = 'left';
      ctxOv.fillText(text, left + 5, y + 0.5);
    }
    function drawLabels(pm, pw) {
      const top = a => [...a].sort((x, y) => y.usd - x.usd).slice(0, 4);
      for (const c of [...top(J.long), ...top(J.short)]) {
        const col = c.side === 'long' ? ROSE : GREEN, y = pm.y(c.peak);
        ctxOv.strokeStyle = rgba(col, 0.45); ctxOv.setLineDash([3, 4]);
        ctxOv.beginPath(); ctxOv.moveTo(pw - 150, Math.round(y) + 0.5); ctxOv.lineTo(pw, Math.round(y) + 0.5); ctxOv.stroke(); ctxOv.setLineDash([]);
        pill(pw - 6, y, `${U(c.usd)} · ${c.distPct >= 0 ? '+' : '−'}${Math.abs(c.distPct).toFixed(2)}%`, col);
      }
    }
    function drawBubbles(pm, tm, pw) {
      const list = liqs.filter(e => opts.exchange === 'all' || e.ex === opts.exchange);
      if (!list.length) return;
      const mx = Math.max(...list.map(e => e.usd));
      for (const e of list) {
        const x = Math.min(pw - 4, tm(e.t)), y = pm.y(e.price), r = 3 + Math.sqrt(e.usd / mx) * 13, col = e.side === 'long' ? ROSE : GREEN;
        ctxOv.fillStyle = rgba(col, 0.35); ctxOv.strokeStyle = rgba(col, 0.95); ctxOv.lineWidth = 1.2;
        ctxOv.beginPath(); ctxOv.arc(x, y, r, 0, Math.PI * 2); ctxOv.fill(); ctxOv.stroke();
      }
    }
    function drawCascade(pm, pw) {
      const p = price;
      if (!p) return;
      [E.cascade(J.long, p, impact), E.cascade(J.short, p, impact)].forEach((cs, i) => {
        if (!cs || cs.verdict === 'unlikely') return;
        const col = cs.side === 'long' ? ROSE : GREEN, x = pw - 196 - i * 18, y0 = pm.y(cs.trigger), y1 = pm.y(cs.endPrice);
        ctxOv.strokeStyle = rgba(col, cs.verdict === 'likely' ? 0.95 : 0.6); ctxOv.lineWidth = 2; ctxOv.setLineDash(cs.verdict === 'likely' ? [] : [5, 4]);
        ctxOv.beginPath(); ctxOv.moveTo(x, y0); ctxOv.lineTo(x, y1); ctxOv.stroke(); ctxOv.setLineDash([]);
        const dir = y1 > y0 ? 1 : -1;
        ctxOv.fillStyle = rgba(col, 0.95);
        ctxOv.beginPath(); ctxOv.moveTo(x, y1 + dir * 2); ctxOv.lineTo(x - 5, y1 - dir * 7); ctxOv.lineTo(x + 5, y1 - dir * 7); ctxOv.closePath(); ctxOv.fill();
        for (const h of cs.hops) { ctxOv.beginPath(); ctxOv.arc(x, pm.y(cs.side === 'long' ? h.cluster.hi : h.cluster.lo), 3.5, 0, Math.PI * 2); ctxOv.fill(); }
        pill(x - 8, (y0 + y1) / 2, cs.verdict === 'likely' ? 'Risco de cascata de liquidações' : 'Cascata possível', col);
      });
    }
    function drawProfile(pm, ph) {
      const Pm = P, p = price, { size, i0, n } = Pm.grid, rows = [];
      let mx = 0;
      for (let y = 0; y < ph; y += 2) {
        const a = pm.p(y), b = pm.p(y + 2);
        const k0 = Math.max(0, Math.floor(Math.min(a, b) / size) - i0), k1 = Math.min(n - 1, Math.floor(Math.max(a, b) / size) - i0);
        const side = (a + b) / 2 < p ? 'long' : 'short', arr = side === 'long' ? Pm.long : Pm.short;
        let s = 0;
        for (let k = k0; k <= k1; k++) s += arr[k];
        if (s > mx) mx = s;
        rows.push({ y, v: s, side });
      }
      ctxProf.fillStyle = 'rgba(11,14,20,0.6)'; ctxProf.fillRect(0, 0, 128, H);
      if (mx > 0) for (const r of rows) { if (r.v <= 0) continue; ctxProf.fillStyle = rgba(r.side === 'long' ? ROSE : GREEN, 0.25 + 0.6 * (r.v / mx)); ctxProf.fillRect(2, r.y, r.v / mx * 120, 2); }
      const yl = pm.y(p);
      ctxProf.strokeStyle = 'rgba(226,232,240,0.6)'; ctxProf.setLineDash([2, 3]);
      ctxProf.beginPath(); ctxProf.moveTo(0, Math.round(yl) + 0.5); ctxProf.lineTo(128, Math.round(yl) + 0.5); ctxProf.stroke(); ctxProf.setLineDash([]);
    }
    function drawReadout(pm) {
      if (!P || !candles.length) { els.readout.textContent = ''; return; }
      let c = candles[candles.length - 1];
      if (hover && hover.t) { const f = candles.find(e => Math.floor(e.t / 1000) === hover.t); if (f) c = f; }
      let extra = '';
      if (hover) {
        const pr = pm.p(hover.y), band = Math.max(P.grid.size, Math.abs(pm.p(hover.y + 6) - pr)), { size, i0, n } = P.grid;
        let l = 0, s = 0;
        for (let k = Math.max(0, Math.floor((pr - band) / size) - i0); k <= Math.min(n - 1, Math.floor((pr + band) / size) - i0); k++) { l += P.long[k]; s += P.short[k]; }
        extra = ` · <span style="color:#64748b">Liq. estimadas em ${fmt(pr)}:</span> <b style="color:#fb7185">${U(l)}</b> longs / <b style="color:#34d399">${U(s)}</b> shorts`;
      }
      els.readout.innerHTML = `<span style="color:#64748b">${tfFull.format(new Date(c.t))}</span> O <b>${fmt(c.open)}</b> H <b>${fmt(c.high)}</b> L <b>${fmt(c.low)}</b> C <b>${fmt(c.close)}</b>${extra}`;
    }

    chart.subscribeCrosshairMove(p => { hover = p.point ? { y: Math.round(p.point.y), t: p.time === undefined ? null : p.time } : null; });

    function frame() {
      raf = requestAnimationFrame(frame);
      const ts = chart.timeScale(), vr = ts.getVisibleLogicalRange(), r = price ?? 0;
      const key = [W, H, vr && vr.from.toFixed(2), vr && vr.to.toFixed(2), series.priceToCoordinate(r), series.priceToCoordinate(r * 1.01), candles.length, version, optTick, hover && `${hover.y}|${hover.t}`].join('|');
      if (key === lastKey) return;
      lastKey = key;
      ctxOv.clearRect(0, 0, W, H); ctxProf.clearRect(0, 0, 128, H);
      const pw = ts.width(), ph = H - ts.height(), pm = priceMap(), tm = timeMap();
      if (!pm || !tm || !P) { ctxHeat.clearRect(0, 0, els.heat.width, els.heat.height); return; }
      if (opts.heatmap) drawHeat(pm, tm, pw, ph); else ctxHeat.clearRect(0, 0, els.heat.width, els.heat.height);
      ctxOv.save(); ctxOv.beginPath(); ctxOv.rect(0, 0, pw, ph); ctxOv.clip();
      drawLabels(pm, pw);
      if (opts.liquidations) drawBubbles(pm, tm, pw);
      if (opts.cascade) drawCascade(pm, pw);
      ctxOv.restore();
      if (opts.profile) drawProfile(pm, ph);
      drawReadout(pm);
    }

    connectBinance(); connectBybit(); load(true);
    timers.push(setInterval(() => { if (!destroyed) load(false); }, REFRESH_MS));
    raf = requestAnimationFrame(frame);

    return {
      setOptions(o) {
        const prev = opts;
        opts = { ...opts, ...o, leverage: { ...opts.leverage, ...(o.leverage || {}) } };
        optTick++;
        if (o.range && o.range !== prev.range) { sockets.forEach(s => { try { s.close(); } catch (e) {} }); load(true); return; }
        if (o.exchange !== undefined || o.leverage !== undefined) rebuild(); else emit();
      },
      destroy() {
        destroyed = true; cancelAnimationFrame(raf);
        timers.forEach(t => { clearTimeout(t); clearInterval(t); });
        if (emitTimer !== null) clearTimeout(emitTimer);
        for (const s of sockets) { s.onclose = null; s.close(); }
        ro.disconnect(); chart.remove();
      }
    };
  }

  // ---------- interface ----------
  let opts = { ...DEFAULTS, leverage: { ...DEFAULTS.leverage } };
  try {
    const sv = JSON.parse(localStorage.getItem('liquidation:opts') || 'null');
    if (sv) opts = { ...DEFAULTS, ...sv, leverage: { ...DEFAULTS.leverage, ...(sv.leverage || {}) } };
  } catch (e) {}
  const url = new URLSearchParams(location.search);
  let symbol = SYMBOLS.find(s => s.binance === url.get('symbol')) || SYMBOLS.find(s => s.binance === localStorage.getItem('liquidation:symbol')) || SYMBOLS[0];
  if (url.get('range') && RANGES.includes(url.get('range'))) opts.range = url.get('range');
  if (url.get('exchange') && EXCH_OPTS.includes(url.get('exchange'))) opts.exchange = url.get('exchange');
  let tool = null, snap = null;
  const saveOpts = () => { try { localStorage.setItem('liquidation:opts', JSON.stringify(opts)); } catch (e) {} };
  const pxf = v => v.toFixed(decimals(symbol.tick));

  function setOpts(patch) {
    opts = { ...opts, ...patch, leverage: { ...opts.leverage, ...(patch.leverage || {}) } };
    saveOpts(); renderTop();
    if (tool) tool.setOptions(patch);
    if (snap) renderSide();
  }

  function renderTop() {
    $('#symLogo').textContent = symbol.ticker; $('#symName').textContent = symbol.binance; $('#symSub').textContent = `${symbol.name} · Binance Futures`;
    $('#symMenu').innerHTML = SYMBOLS.map(s => `<button data-s="${s.binance}" class="${s.binance === symbol.binance ? 'on' : ''}"><b>${s.binance}</b><small>${s.name}</small></button>`).join('');
    $('#rangeSeg').innerHTML = RANGES.map(r => `<button data-v="${r}" class="num ${opts.range === r ? 'on' : ''}">${r.toUpperCase()}</button>`).join('');
    $('#exSeg').innerHTML = EXCH_OPTS.map(x => `<button data-v="${x}" class="${opts.exchange === x ? 'on' : ''}">${EX_LABEL[x]}</button>`).join('');
    $('#chips').innerHTML = Object.keys(LAYER_LABEL).map(k => `<button class="chip ${opts[k] ? 'on' : ''}" data-k="${k}">${opts[k] ? '✓ ' : ''}${LAYER_LABEL[k]}</button>`).join('');
    $('#profileBox').classList.toggle('off', !opts.profile);
    renderCfg();
  }
  function renderCfg() {
    const nOn = E.LEVS.filter(L => opts.leverage[L]).length;
    $('#cfgPop').innerHTML = `<h5>Mistura de alavancagem</h5><p>Qual alavancagem o modelo assume que as posições novas usam. Desligue faixas para ver onde só quem opera com alavancagem alta ou baixa seria liquidado.</p>
      <div class="lev">${E.LEVS.map(L => `<button class="num ${opts.leverage[L] ? 'on' : ''}" data-l="${L}" ${opts.leverage[L] && nOn === 1 ? 'disabled' : ''}>${L}×</button>`).join('')}</div>
      <h5>Exibição</h5><label>Brilho do heatmap <span class="num" id="gainLab" style="color:#e2e8f0">${opts.gain.toFixed(1)}×</span><input type="range" id="gain" min="0.5" max="2" step="0.1" value="${opts.gain}"></label>`;
  }

  function tile(k, v, sm) { return `<div class="tile"><div class="k">${k}</div><div class="v num ${sm ? 'sm' : ''}">${v}</div></div>`; }
  function nearest(c) {
    if (!c) return '—';
    return `<span class="${c.side === 'long' ? 't-rose' : 't-em'}">${pxf(c.peak)} <span class="dim">(${G(c.distPct)})</span><span class="blk">${U(c.usd)}</span></span>`;
  }
  const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtClockS = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function renderMap() {
    const s = snap, reach = s ? s.totals.reach : 0, lo = s ? s.totals.long : 0, sh = s ? s.totals.short : 0, tot = lo + sh;
    const l0 = s && s.longClusters[0], s0 = s && s.shortClusters[0];
    const lean = lo > sh * 1.15 ? 'Há mais liquidações long acumuladas abaixo do preço do que short acima: o lado de baixa é o mais lotado.'
      : sh > lo * 1.15 ? 'Há mais liquidações short acumuladas acima do preço do que long abaixo: o lado de alta é o mais lotado.'
      : 'As liquidações long e short estão mais ou menos equilibradas em torno do preço.';
    const src = s ? s.exchanges.map(e => EX_LABEL[e]).join(' + ') : '';
    $('#map').innerHTML = `<div class="grid2">
      ${tile(`Liq. short a até ${reach}%`, `<span class="t-em">${s ? U(sh) : '—'}</span>`)}
      ${tile(`Liq. long a até ${reach}%`, `<span class="t-rose">${s ? U(lo) : '—'}</span>`)}
      ${tile('Cluster short mais próximo', nearest(s0), true)}
      ${tile('Cluster long mais próximo', nearest(l0), true)}</div>
      ${tot > 0 ? `<div class="bar"><div class="l" style="width:${lo / tot * 100}%"></div><div class="s" style="width:${sh / tot * 100}%"></div></div><p class="small s4">${lean}</p>` : ''}
      ${s && s.steps > 0 ? `<p class="small">Estimado a partir de ${s.steps} passos de cinco minutos de open interest e preço da ${src}. Atualizado às ${s.updatedAt ? fmtClock(s.updatedAt) : '—'}.</p>` : ''}
      ${s ? s.failed.map(e => `<p class="small warn">Os dados da ${EX_LABEL[e]} estão indisponíveis agora; o mapa usa a outra exchange.</p>`).join('') : ''}`;
  }

  function cascadeCard(c, side) {
    const title = side === 'long' ? 'Para baixo: liquidações long' : 'Para cima: short squeeze';
    const cls = side === 'long' ? 't-rose' : 't-em';
    if (!c) {
      const msg = !snap || snap.loading ? '…' : snap.impact == null ? 'Ainda não há volume recente suficiente para estimar o impacto no preço.' : `Nenhum cluster significativo deste lado dentro de ${snap.totals.reach}% do preço.`;
      return `<div class="cc ${side}"><div class="top"><p>${title}</p></div><p class="none">${msg}</p></div>`;
    }
    const first = c.hops[0], shown = c.hops.filter((h, i) => i === 0 || c.hops[i - 1].reaches);
    const vtxt = { likely: 'Risco de cascata de liquidações', possible: 'Cascata possível', unlikely: 'Provavelmente absorvida' }[c.verdict];
    const box = (k, v, sub) => `<div class="box"><div class="k">${k}</div><div class="v num">${v}</div>${sub ? `<div class="sub num">${sub}</div>` : ''}</div>`;
    const arrow = '<svg class="arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m0 0-6-6m6 6 6-6"/></svg>';
    return `<div class="cc ${side}"><div class="top"><p>${title}</p><span class="vd ${c.verdict}">${vtxt}</span></div>
      ${box('Gatilho', `<span class="${cls}">${pxf(c.trigger)}</span>`, G(c.triggerDistPct))}${arrow}
      ${box(side === 'long' ? 'Liquidações long' : 'Liquidações short', U(first.cluster.usd))}${arrow}
      ${box('Aceleração do preço', `${side === 'long' ? '−' : '+'}${first.pushPct.toFixed(2)}%`, 'empurrão estimado')}${arrow}
      ${first.next ? box('Próximo cluster', `<span class="${cls}">${pxf(first.next.peak)}</span>`, `${U(first.next.usd)} · ${first.gapPct.toFixed(2)}% até o núcleo`) : `<p class="none" style="text-align:center">Nenhum outro cluster dentro de ${snap.totals.reach}% do preço.</p>`}
      ${shown.length > 1 ? `<p class="chain">Se disparar: ${shown.length} clusters acionados, cerca de ${U(c.chainUsd)} liquidados, empurrando o preço para ${pxf(c.endPrice)}.</p>` : ''}</div>`;
  }
  function renderCasc() {
    $('#casc').innerHTML = cascadeCard(snap && snap.longCascade, 'long') + cascadeCard(snap && snap.shortCascade, 'short')
      + (snap && snap.impact != null ? `<p class="small">Empurrão = tamanho estimado do cluster × quanto o preço costuma se mover a cada US$ 1 mi em ordens a mercado nas últimas 24 horas (agora ${(+snap.impact.toPrecision(2))}% por US$ 1 mi). Uma cascata é sinalizada quando esse empurrão levaria o preço ao núcleo do próximo cluster, com margem de segurança porque os tamanhos são estimativas.</p>` : '');
  }
  function renderClusters() {
    const list = snap ? [...snap.shortClusters.slice(0, 5).reverse(), ...snap.longClusters.slice(0, 5)] : [];
    if (!list.length) { $('#clusters').innerHTML = '<p class="empty">Sem clusters relevantes por enquanto.</p>'; return; }
    const mx = Math.max(...list.map(c => c.usd));
    $('#clusters').innerHTML = list.map((c, i) => {
      const sep = i > 0 && list[i - 1].side === 'short' && c.side === 'long' ? `<div class="sep"><i></i><span class="num">${pxf(snap.price)}</span><i></i></div>` : '';
      return `<div class="cl">${sep}<div class="row"><div><div class="rng num ${c.side === 'long' ? 't-rose' : 't-em'}">${pxf(c.lo)}–${pxf(c.hi)}</div><div class="mini"><div style="width:${c.usd / mx * 100}%;background:${c.side === 'long' ? 'rgba(244,63,94,.7)' : 'rgba(16,185,129,.7)'}"></div></div></div><span class="d num">${G(c.distPct)}</span><span class="u num">${U(c.usd)}</span></div></div>`;
    }).join('');
  }
  function renderLive() {
    const s = snap, src = EX_LABEL[opts.exchange];
    $('#live').innerHTML = `<div class="grid2">${tile('Longs liquidados', `<span class="t-rose">${U(s ? s.liveTotals.long : 0)}</span>`, true)}${tile('Shorts liquidados', `<span class="t-em">${U(s ? s.liveTotals.short : 0)}</span>`, true)}</div>
      <p class="small">Desde que você abriu esta página.</p>
      <div class="feed">${s && s.live.length ? s.live.map(e => `<div class="r"><span class="num" style="color:#64748b">${fmtClockS(e.t)}</span><span class="ex">${e.ex === 'binance' ? 'BIN' : 'BYB'}</span><span class="side ${e.side === 'long' ? 't-rose' : 't-em'}">${e.side === 'long' ? 'Liq. long' : 'Liq. short'} <span class="n num">@ ${pxf(e.price)}</span></span><span class="usd num">${U(e.usd)}</span></div>`).join('') : '<p class="empty" style="font-size:12px">Aguardando liquidações… Mercados calmos podem passar minutos sem nenhuma.</p>'}</div>
      <p class="small">Ordens de liquidação reais da ${src}, também desenhadas como bolhas no gráfico. A Binance informa no máximo uma por segundo por mercado, então os totais são um mínimo.</p>`;
  }
  function renderSide() { renderMap(); renderCasc(); renderClusters(); renderLive(); }

  function renderHeader() {
    $('#price').textContent = snap && snap.price != null ? pxf(snap.price) : '';
    const st = snap ? snap.status : 'connecting', el = $('#status');
    el.className = `status ${st}`;
    el.querySelector('span').textContent = { live: 'Ao vivo', connecting: 'Conectando', down: 'Reconectando' }[st];
    const ld = $('#loading'), show = !snap || snap.loading;
    ld.classList.toggle('hide', !show);
    $('#loadingTxt').textContent = snap && snap.error ? `Não foi possível carregar os dados (${snap.error}). Tentando de novo… Se for HTTP 451/403, a exchange está bloqueando a sua rede/região (use uma rede ou VPN de país permitido).` : `Montando o mapa de liquidações de ${symbol.binance}…`;
  }
  function onSnap(s) { snap = s; renderHeader(); renderSide(); }

  function start() {
    if (tool) tool.destroy();
    snap = null; renderHeader(); renderSide();
    tool = createTool({ chart: $('#chart'), heat: $('#heat'), overlay: $('#overlay'), profile: $('#profile'), readout: $('#readout') }, symbol, opts, onSnap);
  }

  // eventos
  $('#symBtn').onclick = e => { e.stopPropagation(); $('#symMenu').classList.toggle('open'); };
  $('#symMenu').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    symbol = SYMBOLS.find(s => s.binance === b.dataset.s);
    try { localStorage.setItem('liquidation:symbol', symbol.binance); } catch (x) {}
    $('#symMenu').classList.remove('open'); renderTop(); start();
  };
  $('#rangeSeg').onclick = e => { const b = e.target.closest('button'); if (b) setOpts({ range: b.dataset.v }); };
  $('#exSeg').onclick = e => { const b = e.target.closest('button'); if (b) setOpts({ exchange: b.dataset.v }); };
  $('#chips').onclick = e => { const b = e.target.closest('button'); if (b) setOpts({ [b.dataset.k]: !opts[b.dataset.k] }); };
  $('#cfgBtn').onclick = e => { e.stopPropagation(); const p = $('#cfgPop'); p.hidden = !p.hidden; };
  $('#cfgPop').onclick = e => {
    e.stopPropagation();
    const b = e.target.closest('button[data-l]');
    if (b && !b.disabled) setOpts({ leverage: { [b.dataset.l]: !opts.leverage[b.dataset.l] } });
  };
  $('#cfgPop').oninput = e => {
    if (e.target.id !== 'gain') return;
    opts.gain = Number(e.target.value); saveOpts();
    if (tool) tool.setOptions({ gain: opts.gain });
    const lab = $('#gainLab'); if (lab) lab.textContent = `${opts.gain.toFixed(1)}×`;
  };
  $('#keyBtn').onclick = () => { const k = $('#key'); k.hidden = !k.hidden; };
  $('#key').innerHTML = [
    ['Heatmap', 'onde posições alavancadas seriam fechadas à força, acumuladas ao longo do período. Mais brilhante = mais tamanho estimado. Uma faixa que termina é um nível que o preço atravessou (essas posições foram liquidadas).'],
    ['Perfil', 'o que ainda está esperando em cada preço agora: liquidações long abaixo do preço (vermelho), short acima (verde).'],
    ['Clusters', 'zonas de preço onde as liquidações se acumulam, com tamanho estimado e distância do preço. O preço costuma ser atraído por clusters grandes.'],
    ['Cascata', 'quando um cluster é atingido, as ordens forçadas empurram o preço mais longe. Se esse empurrão levar o preço ao próximo cluster, as liquidações podem encadear.'],
    ['Liquidações ao vivo', 'ordens de liquidação reais transmitidas pelas exchanges conforme acontecem.'],
    ['Estimativa', 'as exchanges não publicam onde as posições são liquidadas. O mapa é modelado a partir de variações do open interest, fluxo dos takers, preço e uma mistura típica de alavancagem de 5× a 100×; use como guia de onde está o risco, não como ordens exatas.']
  ].map(([k, v]) => `<p><b>${k}</b>: ${v}</p>`).join('');
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#cfgPop') && !e.target.closest('#cfgBtn')) $('#cfgPop').hidden = true;
    if (!e.target.closest('#symMenu') && !e.target.closest('#symBtn')) $('#symMenu').classList.remove('open');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#cfgPop').hidden = true; $('#symMenu').classList.remove('open'); } });

  // ---------- abas (Heatmap | Order Flow) ----------
  let tab = 'heat';
  window.OrderFlowUI.init({
    symbols: SYMBOLS,
    onSymbolChange: s => { symbol = s; try { localStorage.setItem('liquidation:symbol', s.binance); } catch (x) {} renderTop(); }
  });
  window.AnalysisUI.init({
    symbols: SYMBOLS,
    onSymbolChange: s => { symbol = s; try { localStorage.setItem('liquidation:symbol', s.binance); } catch (x) {} renderTop(); }
  });
  function showTab(name) {
    tab = name;
    try { localStorage.setItem('liquidation:tab', name); } catch (x) {}
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    $('#viewHeat').hidden = name !== 'heat';
    $('#viewFlow').hidden = name !== 'flow';
    $('#viewAI').hidden = name !== 'ai';
    if (name !== 'heat' && tool) { tool.destroy(); tool = null; }
    if (name !== 'flow') window.OrderFlowUI.stop();
    if (name !== 'ai') window.AnalysisUI.stop();
    if (name === 'flow') window.OrderFlowUI.start(symbol);
    else if (name === 'ai') window.AnalysisUI.start(symbol);
    else { renderTop(); start(); }
  }
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.tab !== tab) showTab(b.dataset.tab); };
  let firstTab = url.get('tab') || localStorage.getItem('liquidation:tab') || 'heat';
  if (!['flow', 'ai'].includes(firstTab)) firstTab = 'heat';
  showTab(firstTab);
})();
