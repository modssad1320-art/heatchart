// Aba Order Flow — port da lógica do site (engine do Order Flow), rodando 100% no seu navegador.
// Dados: Binance Futures (klines, aggTrades, depth do livro e websockets).
(function () {
  'use strict';
  const LW = window.LightweightCharts;
  const $ = s => document.querySelector(s);

  // ---------- constantes (as mesmas do site) ----------
  const TFS = ['1m', '5m', '15m', '1h', '4h'];
  const TF_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5 };
  const TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' };
  const DEFAULTS = { tf: '5m', heatmap: true, bubbles: true, footprint: true, fvg: true, ce: true, walls: true, fpRow: 'auto', heatRow: 'auto', heatGain: 1, minScore: 60, minSizeAtr: 0.1, openOnly: true };
  const REST = 'https://fapi.binance.com', WS = 'wss://fstream.binance.com', PROXY = '/api/binance';
  const MAIN_M = { top: 0.04, bottom: 0.34 }, CVD_M = { top: 0.68, bottom: 0.16 }, DELTA_M = { top: 0.86, bottom: 0.02 };
  const ATR_N = 14, VOL_N = 20, IMB = 3;
  const ROWS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5];
  const BUCKET_MS = 1e3, MAX_FRAMES = 3600, BOOK_RANGE = 0.02, MAX_BIG = 3600, KEEP_MS = 12 * 36e5, BACKFILL_PAGES = 40, KLINE_LIMIT = 1e3, DEPTH_W = 72;
  const BG = [11, 14, 20], GREEN = [34, 197, 94], RED = [239, 68, 68], GOLD = [245, 197, 24];
  const FONT = 'Inter, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const fmtHour = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const fmtFull = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

  // mapa de calor do livro: azul escuro -> azul -> ciano -> verde -> amarelo -> laranja -> branco
  const HEAT_LUT = (() => {
    const stops = [[0, [14, 26, 60]], [0.22, [18, 70, 160]], [0.42, [20, 170, 200]], [0.6, [60, 200, 90]], [0.75, [240, 220, 40]], [0.88, [250, 130, 30]], [1, [255, 245, 235]]];
    const lut = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      const r = n / 255;
      let i = 0;
      while (i < stops.length - 2 && r > stops[i + 1][0]) i++;
      const [a, ca] = stops[i], [b, cb] = stops[i + 1];
      const l = clamp01((r - a) / (b - a)), u = 0.25 + 0.75 * Math.min(1, r * 2.2);
      const d = [0, 1, 2].map(e => Math.round(BG[e] + (ca[e] + (cb[e] - ca[e]) * l - BG[e]) * u));
      lut[n] = (255 << 24) | (d[2] << 16) | (d[1] << 8) | d[0];
    }
    return lut;
  })();

  const decimals = tick => Math.max(0, Math.min(10, Math.round(-Math.log10(tick) + 0.49)));
  const pickMult = (tick, minPrice) => { for (const n of ROWS) if (n * tick >= minPrice * 0.999999999) return n; return ROWS[ROWS.length - 1]; };
  function L(e) { // formatador compacto (volumes)
    const t = Math.abs(e);
    return t >= 1e9 ? (e / 1e9).toFixed(1) + 'B' : t >= 1e6 ? (e / 1e6).toFixed(t >= 1e7 ? 0 : 1) + 'M' : t >= 1e3 ? (e / 1e3).toFixed(t >= 1e4 ? 0 : 1) + 'k' : t >= 100 ? e.toFixed(0) : t >= 10 ? e.toFixed(1) : t >= 1 ? e.toFixed(2) : t === 0 ? '0' : e.toFixed(3);
  }
  const R = e => (e > 0 ? '+' : e < 0 ? '−' : '') + L(Math.abs(e));
  const isDone = f => f.state === 'filled' || f.state === 'broken';

  // ---------- textos (traduzidos do site) ----------
  const T = {
    layers: { heatmap: 'Heatmap', bubbles: 'Grandes trades', footprint: 'Footprint', fvg: 'FVG', ce: 'Linha de 50%', walls: 'Paredes' },
    settings: 'Configurações', connecting: 'Conectando ao order flow de {{symbol}}…',
    bookTitle: 'Livro de ofertas atual (bids em verde, asks em vermelho)', book: 'Livro', cvd: 'CVD', deltaBar: 'Delta / barra', timeframe: 'Timeframe',
    nearHeading: 'Gaps e liquidez perto do preço',
    stats: { openBull: 'Gaps de alta abertos', openBear: 'Gaps de baixa abertos', nearestBull: 'Gap de alta mais próximo abaixo', nearestBear: 'Gap de baixa mais próximo acima', book: 'Livro ±2% bids / asks', cvd: 'CVD (barras carregadas)' },
    gapsHeading: 'Gaps institucionais — leitura do footprint', howToRead: 'Como ler isto', close: 'Fechar', waiting: 'Aguardando candles…',
    noGaps: 'Nenhum gap passa nos filtros — diminua a nota mínima nas Configurações.',
    status: { live: 'Ao vivo', connecting: 'Conectando', down: 'Reconectando' },
    note: {
      heatSince: 'Gravação do heatmap desde {{time}} (livro ao vivo, última hora).', heatNow: 'O heatmap começa a ser gravado agora (livro ao vivo, última hora).',
      fpFrom: 'Footprint a partir de {{time}}; continua se preenchendo enquanto esta aba estiver aberta.', fpLoading: 'Footprint carregando trades recentes…; continua se preenchendo enquanto esta aba estiver aberta.'
    },
    state: { open: 'aberto', tested: 'testado', held: 'defendido', filled: 'preenchido', broken: 'rompido' },
    stateHelp: { open: 'intocado — o preço ainda não voltou', tested: 'o preço voltou para dentro do gap', held: 'o preço entrou e foi empurrado para fora — gap defendido', filled: 'o preço atravessou o gap inteiro', broken: 'o preço fechou além do gap — ele falhou' },
    fvg: {
      bull: 'FVG de alta', bear: 'FVG de baixa', displacedUp: 'Compradores deslocaram o preço para cima', displacedDown: 'Vendedores deslocaram o preço para baixo', body: 'corpo', avgVolume: 'do volume médio',
      netBuyers: 'compradores líquidos', netSellers: 'vendedores líquidos', footprint: 'Footprint',
      fpBuy: '{{n}} desequilíbrios de compra empilhados, {{pct}}% do volume da barra dentro do gap ({{thin}}).', fpSell: '{{n}} desequilíbrios de venda empilhados, {{pct}}% do volume da barra dentro do gap ({{thin}}).',
      thin: 'fino: o preço passou com pouco negócio nos dois lados', lighter: 'mais leve que o resto da barra', heavy: 'muito negociado, então menos um gap de verdade',
      fpMissing: 'não registrado para esta barra (mais antiga que os trades carregados).', retest: 'Reteste', deltaInGap: 'Δ no gap', buyersDefended: 'compradores defenderam', sellersDefended: 'vendedores defenderam',
      buyersPushed: 'compradores empurraram para dentro', sellersPushed: 'vendedores empurraram para dentro', barDelta: 'Δ da barra', size: 'Tamanho', filled: 'Preenchido', dist: 'Dist.', inside: 'dentro',
      barPoc: 'POC da barra', forming: 'formando', priceInside: 'preço dentro'
    },
    key: {
      heatmap: 'ordens limite paradas ao longo do tempo — azul é fino, amarelo/branco é pesado. Faixas horizontais brilhantes são paredes de liquidez.',
      bubbles: 'rajadas de um segundo de volume agressivo, com tamanho pelo volume — verde = compradores atacaram a oferta, vermelho = vendedores bateram na compra.',
      footprint: 'vendas × compras negociadas em cada preço dentro de um candle. Negrito = desequilíbrio diagonal de 3×; caixa dourada = ponto de controle. Dê zoom (scroll) para ler os números.',
      fvg: 'gaps de três candles <span class="text-bull">de alta</span> / <span class="text-bear">de baixa</span>. Sólido = não preenchido, fraco = negociado de volta, tracejado = 50% (CE). Nota = deslocamento vs ATR + volume vs média + delta com o movimento + footprint.',
      cvdTerm: 'CVD / Delta', cvd: 'diferença acumulada e por barra entre o volume agressivo de compra e de venda.'
    },
    panel: {
      display: 'Exibição', fpRow: 'Tamanho da linha do footprint', heatRow: 'Tamanho da linha do heatmap', auto: 'Auto (segue o zoom)', baseRow: '{{k}}× a linha base', baseBucket: '{{k}}× o balde base',
      brightness: 'Brilho do heatmap', fvgHeading: 'Fair value gaps', minScore: 'Nota mínima', allGaps: 'Todos os gaps', institutional: '60+ institucional', strong: '75+ forte',
      minSize: 'Tamanho mínimo do gap', any: 'Qualquer', show: 'Mostrar', openGaps: 'Gaps abertos', openFilled: 'Abertos + preenchidos'
    },
    picker: { exchange: 'Binance Futures', search: 'Buscar moeda…', noMatch: 'Nenhum resultado' },
    groups: { top: 'Principais', gold: 'Ouro' }
  };
  const tr = (s, p) => (p ? s.replace(/\{\{(\w+)\}\}/g, (_, k) => p[k]) : s);

  // =====================================================================
  //  MOTOR (gráfico + dados + cálculo)
  // =====================================================================
  function createTool(els, sym, initOpts, onSnap) {
    let opts = { ...initOpts };
    let destroyed = false;
    const timers = [], sockets = new Set();
    const tick = sym.tick, dp = decimals(tick), fmt = v => v.toFixed(dp);
    const ctxO = els.overlay.getContext('2d'), ctxH = els.heat.getContext('2d'), ctxD = els.depth.getContext('2d');

    const chart = LW.createChart(els.chart, {
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: '#cbd5e1', fontFamily: FONT },
      grid: { vertLines: { color: 'rgba(148,163,184,0.06)' }, horzLines: { color: 'rgba(148,163,184,0.06)' } },
      rightPriceScale: { borderColor: '#232a36', scaleMargins: MAIN_M },
      timeScale: {
        borderColor: '#232a36', timeVisible: true, secondsVisible: false, rightOffset: 6,
        tickMarkFormatter: (t, type) => { const d = new Date(t * 1e3); return type === 0 ? String(d.getFullYear()) : type === 1 ? fmtMonth.format(d) : type === 2 ? fmtDay.format(d) : fmtHour.format(d); }
      },
      crosshair: { mode: LW.CrosshairMode.Normal },
      localization: { priceFormatter: v => fmt(v), timeFormatter: t => fmtFull.format(new Date(t * 1e3)) }
    });
    const NORMAL = { upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444' };
    const HOLLOW = { upColor: 'rgba(34,197,94,0.10)', downColor: 'rgba(239,68,68,0.10)', borderVisible: true, borderUpColor: 'rgba(34,197,94,0.85)', borderDownColor: 'rgba(239,68,68,0.85)', wickUpColor: 'rgba(34,197,94,0.85)', wickDownColor: 'rgba(239,68,68,0.85)' };
    const candle = chart.addCandlestickSeries({ ...NORMAL, priceFormat: { type: 'price', precision: dp, minMove: tick } });
    const cvdS = chart.addCandlestickSeries({ priceScaleId: 'cvd', ...NORMAL, priceLineVisible: false, priceFormat: { type: 'volume' } });
    chart.priceScale('cvd').applyOptions({ scaleMargins: CVD_M });
    const deltaS = chart.addHistogramSeries({ priceScaleId: 'delta', priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'volume' } });
    chart.priceScale('delta').applyOptions({ scaleMargins: DELTA_M });

    // estado
    let bars = [], loaded = false, loadGen = 0, pendingKlines = [];
    const minuteData = new Map();          // minuto -> Map(linhaBase -> [compra, venda])
    let fpCache = new Map();               // barra -> Map(tamanhoLinha -> footprint)
    let fpFrom = null;
    let fvgs = [], version = 0, fvgVersion = -1, optVer = 0;
    let hollow = false, hoverTime = null;
    let frames = [];                       // gravações do livro (1 por segundo)
    let bigBuckets = [], curBucket = null, bigEma = 0, heatNorm = 0;
    let rowBase = 1, heatBase = 1, priceInit = false;
    const book = { bids: new Map(), asks: new Map() };
    let synced = false, lastU = null, depthBuf = [], snapId = null, snapBusy = false, depthWsOk = false, marketWsOk = false;
    let firstAggId = null, backfilled = false, dirty = false;
    let wallRows = null, rowPriceSize = 0, imageData = null;
    let W = 0, H = 0, Z = 1, raf = 0, lastFull = '', lastHeatKey = '';
    let proxyMode = false;

    function initRows(price) {
      if (priceInit || !(price > 0)) return;
      priceInit = true;
      rowBase = pickMult(tick, price * 1e-5);
      heatBase = pickMult(tick, price * 1e-4);
    }
    const tfMs = () => TF_MS[opts.tf];

    // ---------- candles / CVD ----------
    function setDelta(bar, prev) { bar.delta = 2 * bar.tb - bar.vol; bar.cvdOpen = prev ? prev.cvd : 0; bar.cvd = bar.cvdOpen + bar.delta; }
    const cvdBar = b => ({ time: b.time, open: b.cvdOpen, close: b.cvd, high: Math.max(b.cvdOpen, b.cvd), low: Math.min(b.cvdOpen, b.cvd) });
    const deltaBar = b => ({ time: b.time, value: b.delta, color: b.delta >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)' });
    const mkBar = (t, o, h, l, c, vol, tb) => ({ time: Math.floor(t / 1000), open: o, high: h, low: l, close: c, vol, tb, delta: 0, cvdOpen: 0, cvd: 0 });
    function setAllBars() {
      for (let i = 0; i < bars.length; i++) setDelta(bars[i], bars[i - 1]);
      candle.setData(bars); cvdS.setData(bars.map(cvdBar)); deltaS.setData(bars.map(deltaBar)); version++;
    }
    function upsertBar(b) {
      const last = bars[bars.length - 1];
      if (last && last.time === b.time) bars[bars.length - 1] = b;
      else if (!last || b.time > last.time) bars.push(b);
      else return;
      setDelta(b, bars[bars.length - 2]);
      try { candle.update(b); cvdS.update(cvdBar(b)); deltaS.update(deltaBar(b)); } catch (e) {}
      version++;
    }

    // fetch direto na Binance (como o site); se o navegador não conseguir chamar, usa o proxy local
    async function binFetch(path) {
      if (!proxyMode) {
        try { return await fetch(REST + path); }
        catch (e) { proxyMode = true; console.warn('[orderflow] Binance direto falhou; usando proxy local'); }
      }
      return fetch(PROXY + path);
    }

    async function loadKlines() {
      const my = ++loadGen;
      loaded = false; bars = []; fvgs = []; fpCache = new Map();
      candle.setData([]); cvdS.setData([]); deltaS.setData([]); version++;
      for (let n = 0; !destroyed && my === loadGen; n++) {
        try {
          const r = await binFetch(`/fapi/v1/klines?symbol=${sym.binance}&interval=${opts.tf}&limit=${KLINE_LIMIT}`);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          if (destroyed || my !== loadGen) return;
          bars = j.map(e => mkBar(Number(e[0]), +e[1], +e[2], +e[3], +e[4], +e[5], +e[9]));
          if (bars.length) initRows(bars[bars.length - 1].close);
          setAllBars(); loaded = true; chart.timeScale().scrollToRealTime();
          return;
        } catch (e) { lastError = String(e && e.message || e); await sleep(Math.min(15000, 2000 * (n + 1))); }
      }
    }
    let lastError = '';

    // ---------- footprint (compra × venda por preço) ----------
    function addTrade(t, price, qty, isSell) {
      const minute = FlowCore.addTrade(minuteData, rowBase, tick, t, price, qty, isSell);
      fpCache.delete(Math.floor(minute / tfMs()) * tfMs());
    }

    function footprint(bar, k) {
      const t0 = bar.time * 1e3;
      let perBar = fpCache.get(t0);
      if (!perBar) { perBar = new Map(); fpCache.set(t0, perBar); }
      const hit = perBar.get(k);
      if (hit) return hit;
      const res = FlowCore.buildFootprint(minuteData, rowBase, bar, tfMs(), k);
      perBar.set(k, res);
      return res;
    }
    const gapRowMult = atr => Math.max(rowBase, pickMult(tick, atr / 25));
    // ---------- fair value gaps (núcleo compartilhado com a análise) ----------
    function computeFvgs() { return FlowCore.computeFvgs(bars, { tick, gapRowMult, footprint }); }
    const visibleFvgs = () => fvgs.filter(f => f.score >= opts.minScore && f.sizeAtr >= opts.minSizeAtr && (!opts.openOnly || !isDone(f)));
    function refreshFvgs() { if (fvgVersion === version || !bars.length) return; fvgs = computeFvgs(); fvgVersion = version; }

    // ---------- livro de ofertas ----------
    function applyBook(map, list) { for (const [p, q] of list) { const pn = Number(p), qn = Number(q); if (qn === 0) map.delete(pn); else map.set(pn, qn); } }
    async function loadSnapshot() {
      if (snapBusy) return;
      snapBusy = true; synced = false; snapId = null;
      try {
        const r = await binFetch(`/fapi/v1/depth?symbol=${sym.binance}&limit=1000`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (destroyed) return;
        book.bids.clear(); book.asks.clear(); applyBook(book.bids, j.bids); applyBook(book.asks, j.asks);
        snapId = j.lastUpdateId; lastU = null; snapBusy = false;
        const buf = depthBuf; depthBuf = [];
        for (const e of buf) onDepth(e);
      } catch (e) { snapBusy = false; timers.push(setTimeout(() => !destroyed && loadSnapshot(), 3000)); }
    }
    function onDepth(e) {
      if (snapId === null) { depthBuf.push(e); if (depthBuf.length > 2000) depthBuf.shift(); return; }
      if (e.u < snapId) return;
      if (!synced) {
        if (e.U > snapId) { depthBuf = [e]; loadSnapshot(); return; }
        synced = true;
      } else if (e.pu !== lastU) { depthBuf = [e]; loadSnapshot(); return; }
      applyBook(book.bids, e.b); applyBook(book.asks, e.a); lastU = e.u;
    }

    // ---------- websockets ----------
    function openWs(url, onOpen, onMsg, onClose) {
      if (destroyed) return;
      const ws = new WebSocket(url);
      sockets.add(ws);
      ws.onopen = onOpen;
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m && m.data) onMsg(m.data); };
      ws.onclose = () => { sockets.delete(ws); if (!destroyed) onClose(); };
      ws.onerror = () => ws.close();
    }
    const low = sym.binance.toLowerCase();
    let depthPath = 0, marketPath = 0;
    const DEPTH_PATHS = ['/public/stream', '/stream'], MARKET_PATHS = ['/market/stream', '/stream'];
    function connectDepth() {
      let opened = false;
      openWs(`${WS}${DEPTH_PATHS[depthPath]}?streams=${low}@depth@100ms`,
        () => { opened = true; depthWsOk = true; depthBuf = []; loadSnapshot(); },
        d => { if (d.e === 'depthUpdate') onDepth(d); },
        () => { depthWsOk = false; synced = false; if (!opened) depthPath = (depthPath + 1) % DEPTH_PATHS.length; timers.push(setTimeout(connectDepth, 3000)); });
    }
    function connectMarket() {
      let opened = false;
      const streams = [`${low}@aggTrade`, ...TFS.map(t => `${low}@kline_${t}`)].join('/');
      openWs(`${WS}${MARKET_PATHS[marketPath]}?streams=${streams}`,
        () => { opened = true; marketWsOk = true; },
        d => {
          if (d.e === 'aggTrade') { onTrade(d); return; }
          if (d.e !== 'kline' || d.k.i !== opts.tf) return;
          const k = d.k, b = mkBar(k.t, +k.o, +k.h, +k.l, +k.c, +k.v, +k.V);
          if (!loaded) { pendingKlines.push(b); return; }
          if (pendingKlines.length) { for (const p of pendingKlines) upsertBar(p); pendingKlines = []; }
          upsertBar(b);
        },
        () => { marketWsOk = false; if (!opened) marketPath = (marketPath + 1) % MARKET_PATHS.length; timers.push(setTimeout(connectMarket, 3000)); });
    }

    // ---------- trades ----------
    function onTrade(e) {
      const p = Number(e.p), q = Number(e.q);
      initRows(p);
      if (firstAggId === null) { firstAggId = e.a; if (!backfilled) { backfilled = true; backfill(e.a); } }
      addTrade(e.T, p, q, e.m);
      const bucket = Math.floor(e.T / BUCKET_MS) * BUCKET_MS;
      if (!curBucket || curBucket.t !== bucket) { if (curBucket) pushBucket(curBucket); curBucket = { t: bucket, buy: 0, sell: 0, pv: 0 }; }
      if (e.m) curBucket.sell += q; else curBucket.buy += q;
      curBucket.pv += p * q; dirty = true;
    }
    function pushBucket(b) {
      bigBuckets.push(b);
      if (bigBuckets.length > MAX_BIG) bigBuckets.shift();
      const t = b.buy + b.sell;
      bigEma = bigEma ? bigEma * 0.995 + t * 0.005 : t;
    }
    async function backfill(firstId) { // puxa trades recentes para o footprint já abrir com histórico
      const pages = [];
      for (let t = 1; t <= BACKFILL_PAGES; t++) { const end = firstId - 1000 * (t - 1); if (end <= 0) break; pages.push([Math.max(0, end - 1000), end]); }
      let earliest = null, idx = 0;
      const worker = async () => {
        while (!destroyed && idx < pages.length) {
          const [from, to] = pages[idx++];
          try {
            const r = await binFetch(`/fapi/v1/aggTrades?symbol=${sym.binance}&fromId=${from}&limit=1000`);
            if (!r.ok) { if (r.status === 429 || r.status === 418) return; continue; }
            const j = await r.json();
            if (destroyed) return;
            for (const t of j) { if (t.a >= to || t.a < from) continue; addTrade(t.T, Number(t.p), Number(t.q), t.m); if (earliest === null || t.T < earliest) earliest = t.T; }
            version++;
          } catch (e) {}
          await sleep(120);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      fpFrom = earliest; fpCache = new Map(); version++;
    }
    timers.push(setInterval(() => { if (dirty) { dirty = false; version++; } }, 250));

    // grava o livro 1x por segundo (±2% do preço) para formar o heatmap
    timers.push(setInterval(() => {
      if (!synced || !priceInit) return;
      let bid = -Infinity, ask = Infinity;
      for (const p of book.bids.keys()) if (p > bid) bid = p;
      for (const p of book.asks.keys()) if (p < ask) ask = p;
      if (!isFinite(bid) || !isFinite(ask)) return;
      const mid = (bid + ask) / 2, size = heatBase * tick;
      const i0 = Math.floor(mid * (1 - BOOK_RANGE) / size), n = Math.floor(mid * (1 + BOOK_RANGE) / size) - i0 + 1;
      const bids = new Float32Array(n), asks = new Float32Array(n);
      for (const [p, q] of book.bids) { const k = Math.floor(Math.round(p / tick) / heatBase) - i0; if (k >= 0 && k < n) bids[k] += q; }
      for (const [p, q] of book.asks) { const k = Math.floor(Math.round(p / tick) / heatBase) - i0; if (k >= 0 && k < n) asks[k] += q; }
      frames.push({ t: Date.now(), i0, bids, asks });
      if (frames.length > MAX_FRAMES) frames.shift();
      if (curBucket && Date.now() - curBucket.t > 1500) { pushBucket(curBucket); curBucket = null; }
    }, BUCKET_MS));
    timers.push(setInterval(() => {
      const cut = Date.now() - KEEP_MS;
      for (const k of minuteData.keys()) if (k < cut) minuteData.delete(k);
      refreshFvgs(); emit();
    }, 1000));

    function emit() {
      if (destroyed) return;
      const last = bars[bars.length - 1], list = visibleFvgs(), open = list.filter(f => !isDone(f)), price = last ? last.close : null;
      let bidD = 0, askD = 0;
      const fr = frames[frames.length - 1];
      if (fr) { for (const v of fr.bids) bidD += v; for (const v of fr.asks) askD += v; }
      onSnap({
        status: depthWsOk && marketWsOk && loaded ? 'live' : depthWsOk || marketWsOk ? 'connecting' : 'down', price, error: lastError,
        fvgs: [...list].sort((a, b) => b.t - a.t).slice(0, 60),
        openBull: open.filter(f => f.dir === 'bull').length, openBear: open.filter(f => f.dir === 'bear').length,
        nearestBull: price === null ? null : open.filter(f => f.dir === 'bull' && f.rem <= price).sort((a, b) => b.rem - a.rem)[0] ?? null,
        nearestBear: price === null ? null : open.filter(f => f.dir === 'bear' && f.rem >= price).sort((a, b) => a.rem - b.rem)[0] ?? null,
        bidDepth: bidD, askDepth: askD, fpFrom, heatFrom: frames.length ? frames[0].t : null, cvd: last ? last.cvd : null
      });
    }

    // ---------- desenho ----------
    function resize() {
      Z = window.devicePixelRatio || 1; W = els.chart.clientWidth; H = els.chart.clientHeight;
      chart.resize(W, H);
      els.overlay.width = W * Z; els.overlay.height = H * Z; ctxO.setTransform(Z, 0, 0, Z, 0, 0);
      els.heat.width = Math.max(1, W); els.heat.height = Math.max(1, H);
      els.depth.width = DEPTH_W * Z; els.depth.height = H * Z; ctxD.setTransform(Z, 0, 0, Z, 0, 0);
      imageData = null; version++;
    }
    const ro = new ResizeObserver(resize);
    ro.observe(els.chart);
    resize();

    const barSpacing = () => { const ts = chart.timeScale(), a = ts.logicalToCoordinate(0), b = ts.logicalToCoordinate(1); return a === null || b === null ? 6 : b - a; };
    function priceMap() {
      const last = bars[bars.length - 1];
      if (!last) return null;
      const p = last.close, y0 = candle.priceToCoordinate(p), y1 = candle.priceToCoordinate(p + p * 0.01);
      if (y0 === null || y1 === null || y0 === y1) return null;
      const k = (y1 - y0) / (p * 0.01);
      return { y: v => y0 + (v - p) * k, ppu: Math.abs(k) };
    }
    function timeMap() {
      if (bars.length < 2) return null;
      const ts = chart.timeScale(), ta = bars[bars.length - 2].time, tb = bars[bars.length - 1].time;
      const xa = ts.timeToCoordinate(ta), xb = ts.timeToCoordinate(tb);
      if (xa === null || xb === null || xb === xa) return null;
      const k = (xb - xa) / ((tb - ta) * 1e3), left = xb - (xb - xa) / 2;
      return { x: ms => left + (ms - tb * 1e3) * k, pxPerMs: k };
    }

    // heatmap do livro: cada gravação vira uma coluna; cor pela quantidade (escala log)
    function drawHeat(pm, tm, plotW, paneH) {
      const cw = els.heat.width, ch = els.heat.height;
      if (!imageData || imageData.width !== cw || imageData.height !== ch) imageData = ctxH.createImageData(cw, ch);
      const px = new Uint32Array(imageData.data.buffer);
      px.fill(0);
      const latest = frames[frames.length - 1];
      if (!latest) { ctxH.putImageData(imageData, 0, 0); return null; }
      const bucketPx = heatBase * tick;
      let mult = typeof opts.heatRow === 'number' ? opts.heatRow : 1;
      if (opts.heatRow === 'auto') { for (const e of ROWS) { mult = e; if (e * bucketPx * pm.ppu >= 2) break; } }
      const rowSize = bucketPx * mult;
      const toRows = f => {
        const m = new Map();
        for (let k = 0; k < f.bids.length; k++) {
          const b = f.bids[k], a = f.asks[k];
          if (!b && !a) continue;
          const r = Math.floor((f.i0 + k) / mult), cur = m.get(r);
          if (cur) { cur[0] += b; cur[1] += a; } else m.set(r, [b, a]);
        }
        return m;
      };
      const latestRows = toRows(latest);
      rowPriceSize = rowSize;
      if (!opts.heatmap || !tm) { ctxH.putImageData(imageData, 0, 0); return latestRows; }
      const H1 = Math.min(ch, Math.floor(paneH)), W1 = Math.min(cw, Math.floor(plotW));
      const cols = [];
      const nowX = tm.x(Date.now());
      let right = Math.min(W1, Math.max(nowX, tm.x(latest.t) + 2));
      for (let e = frames.length - 1; e >= 0 && right > 0; e--) {
        const f = frames[e], x = tm.x(f.t);
        if (x >= W1 || (right - x < 1.5 && e > 0)) continue;
        const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(W1, Math.ceil(right));
        if (x1 > x0) cols.push({ f, x0, x1 });
        right = x;
      }
      const list = cols.map(c => ({ ...c, rows: c.f === latest ? latestRows : toRows(c.f) }));
      let mx = 0;
      for (const c of list) for (const [, [b, a]] of c.rows) mx = Math.max(mx, b, a);
      heatNorm = heatNorm ? Math.max(mx * 0.6, heatNorm * 0.97 + mx * 0.03) : mx;
      const logMax = Math.log1p(Math.max(heatNorm, 1e-12)), gain = opts.heatGain;
      const paint = (rows, x0, x1, alpha) => {
        for (const [r, [b, a]] of rows) {
          const v = Math.max(b, a);
          if (v <= 0) continue;
          let yTop = Math.round(pm.y((r + 1) * rowSize)), yBot = Math.round(pm.y(r * rowSize));
          if (yBot < 0 || yTop >= H1) continue;
          yTop = Math.max(0, yTop); yBot = Math.min(H1, Math.max(yBot, yTop + 1));
          const idx = Math.min(255, Math.round(255 * clamp01(Math.log1p(v) / logMax * gain) * alpha));
          if (idx < 8) continue;
          const color = HEAT_LUT[idx];
          for (let y = yTop; y < yBot; y++) px.fill(color, y * cw + x0, y * cw + x1);
        }
      };
      for (const c of list) paint(c.rows, c.x0, c.x1, 1);
      const futureX = Math.max(0, Math.ceil(Math.min(W1, nowX)));
      if (futureX < W1) paint(latestRows, futureX, W1, 0.55); // projeta o livro atual para a direita
      ctxH.putImageData(imageData, 0, 0);
      return latestRows;
    }

    function drawWalls(pm, rows, plotW) {
      const top = side => [...rows.entries()].filter(([, v]) => v[side] > 0).sort((a, b) => b[1][side] - a[1][side]).slice(0, 3);
      ctxO.font = `10px ${FONT}`; ctxO.textBaseline = 'middle';
      for (const [side, col] of [[0, GREEN], [1, RED]]) {
        for (const [r, v] of top(side)) {
          const y = Math.round(pm.y((r + 0.5) * rowPriceSize)) + 0.5;
          ctxO.strokeStyle = rgba(GOLD, 0.55); ctxO.setLineDash([5, 4]);
          ctxO.beginPath(); ctxO.moveTo(0, y); ctxO.lineTo(plotW, y); ctxO.stroke(); ctxO.setLineDash([]);
          const text = `${side === 0 ? 'Bid wall' : 'Ask wall'} ${fmt(r * rowPriceSize)} · ${L(v[side])}`, w = ctxO.measureText(text).width;
          ctxO.fillStyle = 'rgba(11,14,20,0.85)'; ctxO.fillRect(8, y - 8, w + 8, 15);
          ctxO.fillStyle = rgba(col, 1); ctxO.textAlign = 'left'; ctxO.fillText(text, 12, y);
        }
      }
    }
    function drawDepth(pm, rows, paneH) {
      let mx = 0;
      for (const [, [b, a]] of rows) mx = Math.max(mx, b, a);
      if (!mx) return;
      ctxD.save(); ctxD.beginPath(); ctxD.rect(0, 0, DEPTH_W, paneH); ctxD.clip();
      for (const [r, [b, a]] of rows) {
        const y1 = pm.y((r + 1) * rowPriceSize), y0 = pm.y(r * rowPriceSize);
        if (y0 < 0 || y1 > paneH) continue;
        const h = Math.max(1, y0 - y1 - (y0 - y1 > 3 ? 0.5 : 0));
        if (b > 0) { ctxD.fillStyle = rgba(GREEN, 0.6); ctxD.fillRect(0, y1, Math.sqrt(b / mx) * (DEPTH_W - 4), h); }
        if (a > 0) { ctxD.fillStyle = rgba(RED, 0.6); ctxD.fillRect(0, y1, Math.sqrt(a / mx) * (DEPTH_W - 4), h); }
      }
      ctxD.restore();
    }
    function drawBubbles(pm, tm, plotW) {
      if (!bigEma) return;
      const thr = bigEma * 4, list = curBucket ? [...bigBuckets, curBucket] : bigBuckets;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i], x = tm.x(b.t + BUCKET_MS / 2);
        if (x < -20) break;
        if (x > plotW + 20) continue;
        const tot = b.buy + b.sell;
        if (tot < thr) continue;
        const y = pm.y(b.pv / tot), rad = Math.max(3, Math.min(22, 4 * Math.sqrt(tot / thr))), share = b.buy / tot, col = share >= 0.5 ? GREEN : RED;
        ctxO.beginPath(); ctxO.arc(x, y, rad, 0, Math.PI * 2);
        ctxO.fillStyle = rgba(col, 0.28 + 0.3 * Math.abs(share - 0.5) * 2); ctxO.fill();
        ctxO.strokeStyle = rgba(col, 0.95); ctxO.lineWidth = 1; ctxO.stroke();
      }
    }
    function drawFvg(from, bs, plotW) {
      const ts = chart.timeScale();
      ctxO.textBaseline = 'middle';
      for (const g of visibleFvgs()) {
        if (g.fillIdx !== null && g.fillIdx < from) continue;
        const cx = ts.logicalToCoordinate(g.i);
        if (cx === null) continue;
        const x0 = cx - bs / 2, fx = g.fillIdx === null ? null : ts.logicalToCoordinate(g.fillIdx), x1 = fx === null ? plotW : fx;
        if (x1 < 0 || x0 > plotW) continue;
        const yHi = candle.priceToCoordinate(g.hi), yLo = candle.priceToCoordinate(g.lo);
        if (yHi === null || yLo === null) continue;
        const col = g.dir === 'bull' ? GREEN : RED, sc = clamp01(g.score / 100), done = isDone(g);
        ctxO.fillStyle = rgba(col, done ? 0.05 : 0.07); ctxO.fillRect(x0, yHi, x1 - x0, Math.max(1, yLo - yHi));
        if (!done) {
          const yr = candle.priceToCoordinate(g.rem);
          if (yr !== null) { const a = g.dir === 'bull' ? yr : yHi, b = g.dir === 'bull' ? yLo : yr; ctxO.fillStyle = rgba(col, 0.1 + 0.22 * sc); ctxO.fillRect(x0, a, x1 - x0, Math.max(1, b - a)); }
        }
        ctxO.strokeStyle = rgba(col, done ? 0.35 : 0.45 + 0.5 * sc); ctxO.lineWidth = g.score >= 75 && !done ? 1.5 : 1;
        if (g.forming) ctxO.setLineDash([4, 3]);
        ctxO.strokeRect(Math.round(x0) + 0.5, Math.round(yHi) + 0.5, Math.round(x1 - x0), Math.max(1, Math.round(yLo - yHi)));
        ctxO.setLineDash([]);
        if (opts.ce) {
          const ym = (yHi + yLo) / 2;
          ctxO.strokeStyle = rgba(col, 0.6); ctxO.lineWidth = 1; ctxO.setLineDash([3, 3]);
          ctxO.beginPath(); ctxO.moveTo(x0, Math.round(ym) + 0.5); ctxO.lineTo(x1, Math.round(ym) + 0.5); ctxO.stroke(); ctxO.setLineDash([]);
        }
        if (yLo - yHi >= 9 || !done) {
          const text = `${g.dir === 'bull' ? 'Bull' : 'Bear'} FVG ${g.score}${g.forming ? ' · forming' : ''} · ${g.volRatio.toFixed(1)}× vol · Δ ${R(g.delta)}`
            + (g.fp && g.fp.stacked >= 2 ? ` · ${g.fp.stacked} stacked` : '') + (!done && g.filledPct > 0.01 ? ` · ${Math.round(g.filledPct * 100)}% filled` : '');
          ctxO.font = `${g.score >= 60 ? '600 ' : ''}10px ${FONT}`; ctxO.textAlign = 'right'; ctxO.fillStyle = rgba(col, done ? 0.55 : 0.95);
          const y = yLo - yHi >= 12 ? yHi + 7 : g.dir === 'bull' ? yLo + 7 : yHi - 7;
          ctxO.fillText(text, Math.min(x1, plotW) - 4, y);
        }
      }
    }
    function setHollow(on) { if (on !== hollow) { hollow = on; candle.applyOptions(on ? HOLLOW : NORMAL); } }
    function fpRowSize(ppu, bs) {
      if (opts.fpRow !== 'auto') return Math.max(rowBase, opts.fpRow * rowBase);
      const minPx = bs >= 54 ? 13 : 4;
      for (const t of ROWS) if (t >= rowBase && t * tick * ppu >= minPx) return t;
      return ROWS[ROWS.length - 1];
    }
    function drawFootprint(from, to, bs) {
      if (!opts.footprint || bs < 8) { setHollow(false); return; }
      const pm = priceMap();
      if (!pm) return;
      const mult = fpRowSize(pm.ppu, bs), rowPx = mult * tick, rowH = rowPx * pm.ppu;
      if (rowH < 2) { setHollow(false); return; }
      const numbers = rowH >= 11 && bs >= 54, cellW = bs * 0.88, ts = chart.timeScale();
      let drew = false;
      const gapByBar = new Map();
      if (opts.fvg) for (const g of visibleFvgs()) gapByBar.set(g.i, g);
      ctxO.textBaseline = 'middle';
      const fontPx = Math.min(11, Math.max(8, Math.floor(rowH - 2)));
      for (let n = from; n <= to; n++) {
        const fp = footprint(bars[n], mult);
        if (!fp.rows.length) continue;
        const cx = ts.logicalToCoordinate(n);
        if (cx === null) continue;
        drew = true;
        const left = cx - cellW / 2, maxSide = fp.maxSide || 1, gap = gapByBar.get(n);
        for (const row of fp.rows) {
          const yTop = pm.y((row.r + 1) * rowPx), yBot = pm.y(row.r * rowPx), h = Math.max(1, yBot - yTop - (rowH >= 6 ? 1 : 0)), ym = yTop + (yBot - yTop) / 2;
          if (numbers) {
            const d = row.b - row.s, a = 0.1 + 0.5 * (fp.maxAbsDelta ? Math.abs(d) / fp.maxAbsDelta : 0);
            ctxO.fillStyle = rgba(d >= 0 ? GREEN : RED, a); ctxO.fillRect(left, yTop, cellW, h);
            ctxO.font = `${row.sellImb ? '700 ' : ''}${fontPx}px ${FONT}`; ctxO.fillStyle = row.sellImb ? '#ff7b7b' : 'rgba(226,232,240,0.9)'; ctxO.textAlign = 'right'; ctxO.fillText(L(row.s), cx - 6, ym);
            ctxO.font = `${fontPx}px ${FONT}`; ctxO.fillStyle = 'rgba(148,163,184,0.9)'; ctxO.textAlign = 'center'; ctxO.fillText('×', cx, ym);
            ctxO.font = `${row.buyImb ? '700 ' : ''}${fontPx}px ${FONT}`; ctxO.fillStyle = row.buyImb ? '#4ade80' : 'rgba(226,232,240,0.9)'; ctxO.textAlign = 'left'; ctxO.fillText(L(row.b), cx + 6, ym);
          } else {
            const half = cellW / 2;
            ctxO.fillStyle = rgba(RED, row.sellImb ? 0.9 : 0.55); ctxO.fillRect(cx - row.s / maxSide * half, yTop, row.s / maxSide * half, h);
            ctxO.fillStyle = rgba(GREEN, row.buyImb ? 0.9 : 0.55); ctxO.fillRect(cx, yTop, row.b / maxSide * half, h);
          }
          if (row.r === fp.poc) { ctxO.strokeStyle = rgba(GOLD, 0.9); ctxO.lineWidth = 1; ctxO.strokeRect(left + 0.5, yTop + 0.5, cellW - 1, Math.max(1, h - 1)); }
        }
        if (gap) {
          const yHi = pm.y(gap.hi), yLo = pm.y(gap.lo);
          ctxO.strokeStyle = rgba(GOLD, 0.8); ctxO.lineWidth = 1; ctxO.setLineDash([2, 2]); ctxO.strokeRect(left - 1.5, yHi, cellW + 3, yLo - yHi); ctxO.setLineDash([]);
        }
        if (numbers) {
          const yLow = pm.y(fp.rows[0].r * rowPx), d = fp.buy - fp.sell;
          ctxO.font = `700 10px ${FONT}`; ctxO.textAlign = 'center'; ctxO.fillStyle = d >= 0 ? '#4ade80' : '#ff7b7b'; ctxO.fillText(`Δ ${R(d)}`, cx, yLow + 9);
        }
      }
      setHollow(drew);
    }

    const crosshairHandler = p => { hoverTime = p && p.time !== undefined ? p.time : null; drawReadout(); };
    chart.subscribeCrosshairMove(crosshairHandler);
    function barIndexAt(t) { let lo = 0, hi = bars.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
    function drawReadout() {
      if (!bars.length) { els.readout.textContent = ''; return; }
      let i = bars.length - 1;
      if (hoverTime !== null) { const k = barIndexAt(hoverTime); if (k >= 0) i = k; }
      const b = bars[i], cls = v => (v >= 0 ? 'text-bull' : 'text-bear'), gap = fvgs.find(g => g.i === i), d = new Date(b.time * 1e3);
      els.readout.innerHTML = `<span class="text-slate-500">${fmtDay.format(d)} ${fmtHour.format(d)}</span> O <b>${fmt(b.open)}</b> H <b>${fmt(b.high)}</b> L <b>${fmt(b.low)}</b> C <b>${fmt(b.close)}</b> · Vol <b>${L(b.vol)}</b> · Δ <b class="${cls(b.delta)}">${R(b.delta)}</b> · CVD <b class="${cls(b.cvd)}">${R(b.cvd)}</b>`
        + (gap ? ` · <b class="${gap.dir === 'bull' ? 'text-bull' : 'text-bear'}">${gap.dir === 'bull' ? 'Bull' : 'Bear'} FVG ${fmt(gap.lo)}–${fmt(gap.hi)}</b> score <b>${gap.score}</b>` : '');
    }

    function frameLoop() {
      raf = requestAnimationFrame(frameLoop);
      const ts = chart.timeScale(), vr = ts.getVisibleLogicalRange(), lastClose = bars.length ? bars[bars.length - 1].close : 0;
      const layout = [W, H, vr && vr.from.toFixed(3), vr && vr.to.toFixed(3), candle.priceToCoordinate(lastClose), candle.priceToCoordinate(lastClose * 1.01), bars.length].join('|');
      const heatKey = `${layout}|${frames.length ? frames[frames.length - 1].t : 0}|${optVer}`;
      const full = `${layout}|${version}|${heatKey}`;
      if (full === lastFull) return;
      lastFull = full;
      ctxO.clearRect(0, 0, W, H); ctxD.clearRect(0, 0, DEPTH_W, H);
      if (!vr || !bars.length) { ctxH.clearRect(0, 0, els.heat.width, els.heat.height); return; }
      const pw = ts.width(), ph = H - ts.height(), paneH = ph * (1 - MAIN_M.bottom + CVD_M.top) / 2;
      els.cvdLabel.style.top = `${ph * CVD_M.top - 14}px`; els.deltaLabel.style.top = `${ph * DELTA_M.top - 12}px`;
      const pm = priceMap(), tm = timeMap(), bs = barSpacing();
      const from = Math.max(0, Math.floor(vr.from)), to = Math.min(bars.length - 1, Math.ceil(vr.to));
      if (heatKey !== lastHeatKey) { lastHeatKey = heatKey; wallRows = pm ? drawHeat(pm, tm, pw, paneH) : null; }
      ctxO.save(); ctxO.beginPath(); ctxO.rect(0, 0, pw, paneH); ctxO.clip();
      if (opts.fvg) drawFvg(from, bs, pw);
      drawFootprint(from, to, bs);
      if (opts.bubbles && pm && tm) drawBubbles(pm, tm, pw);
      if (opts.walls && wallRows && pm) drawWalls(pm, wallRows, pw);
      ctxO.restore();
      ctxO.strokeStyle = '#232a36'; ctxO.lineWidth = 1;
      for (const y of [paneH, ph * (1 - CVD_M.bottom + DELTA_M.top) / 2]) { ctxO.beginPath(); ctxO.moveTo(0, Math.round(y) + 0.5); ctxO.lineTo(pw, Math.round(y) + 0.5); ctxO.stroke(); }
      if (wallRows && pm) drawDepth(pm, wallRows, paneH);
      drawReadout();
    }

    connectDepth(); connectMarket(); loadKlines();
    raf = requestAnimationFrame(frameLoop);

    return {
      setOptions(o) {
        const tfChanged = o.tf !== undefined && o.tf !== opts.tf;
        opts = { ...opts, ...o }; optVer++;
        if (tfChanged) { pendingKlines = []; loadKlines(); }
        fvgVersion = -1; refreshFvgs(); version++; emit();
      },
      focusBar(i) { const ts = chart.timeScale(), vr = ts.getVisibleLogicalRange(), half = vr ? (vr.to - vr.from) / 2 : 40; ts.setVisibleLogicalRange({ from: i - half, to: i + half }); },
      destroy() {
        destroyed = true; cancelAnimationFrame(raf);
        for (const t of timers) { clearInterval(t); clearTimeout(t); }
        for (const s of sockets) { s.onclose = null; s.close(); }
        sockets.clear(); ro.disconnect(); chart.unsubscribeCrosshairMove(crosshairHandler); chart.remove();
      }
    };
  }

  // =====================================================================
  //  INTERFACE DA ABA
  // =====================================================================
  const UI = (function () {
    let cfg = null, tool = null, snap = null, opts = { ...DEFAULTS }, symbol = null, built = false;
    try { const sv = JSON.parse(localStorage.getItem('orderflow:opts') || 'null'); if (sv) opts = { ...DEFAULTS, ...sv }; } catch (e) {}
    const saveOpts = () => { try { localStorage.setItem('orderflow:opts', JSON.stringify(opts)); } catch (e) {} };
    const pxf = v => v.toFixed(decimals(symbol.tick));

    function renderTop() {
      $('#ofSymLogo').textContent = symbol.ticker; $('#ofSymName').textContent = symbol.binance; $('#ofSymSub').textContent = `${symbol.group === 'gold' ? T.groups.gold : symbol.name} · ${T.picker.exchange}`;
      renderMenu();
      $('#ofTf').innerHTML = TFS.map(t => `<button data-v="${t}" class="num ${opts.tf === t ? 'on' : ''}">${TF_LABEL[t]}</button>`).join('');
      $('#ofChips').innerHTML = ['heatmap', 'bubbles', 'footprint', 'fvg', 'ce', 'walls'].map(k => `<button class="chip ${opts[k] ? 'on' : ''}" data-k="${k}" aria-pressed="${opts[k]}">${opts[k] ? '✓ ' : ''}${T.layers[k]}</button>`).join('');
    }
    function renderMenu() {
      const q = ($('#ofSearch') ? $('#ofSearch').value : '').trim().toLowerCase();
      const list = cfg.symbols.filter(s => !q || `${s.name} ${s.ticker} ${s.binance}`.toLowerCase().includes(q));
      const groups = ['top', 'gold'].map(g => {
        const items = list.filter(s => (s.group || 'top') === g);
        return items.length ? `<div class="grp"><div class="gh">${T.groups[g]}</div>${items.map(s => `<button data-s="${s.binance}" class="${s.binance === symbol.binance ? 'on' : ''}"><span>${s.group === 'gold' ? T.groups.gold : s.name} (${s.ticker})</span><small class="num">${s.binance}</small></button>`).join('')}</div>` : '';
      }).join('');
      const keep = $('#ofSearch') ? $('#ofSearch').value : '';
      $('#ofSymMenu').innerHTML = `<div class="srch"><input id="ofSearch" placeholder="${T.picker.search}" autocomplete="off"></div><div class="lst">${groups || `<p class="empty">${T.picker.noMatch}</p>`}</div>`;
      const inp = $('#ofSearch'); inp.value = keep;
      if (keep) { inp.focus(); inp.setSelectionRange(keep.length, keep.length); }
    }
    function renderCfg() {
      const sel = (id, label, value, options) => `<label>${label}<select id="${id}">${options.map(([v, t]) => `<option value="${v}" ${String(value) === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
      const p = T.panel;
      $('#ofCfgPop').innerHTML = `<h5>${p.display}</h5>
        ${sel('ofFpRow', p.fpRow, opts.fpRow, [['auto', p.auto], ...[1, 2, 5, 10, 20, 50, 100].map(k => [k, tr(p.baseRow, { k })])])}
        ${sel('ofHeatRow', p.heatRow, opts.heatRow, [['auto', p.auto], ...[1, 2, 5, 10, 20].map(k => [k, tr(p.baseBucket, { k })])])}
        <label>${p.brightness} <span class="num" id="ofGainLab" style="color:#e2e8f0">${opts.heatGain.toFixed(1)}×</span><input type="range" id="ofGain" min="0.5" max="2" step="0.1" value="${opts.heatGain}"></label>
        <h5 style="margin-top:14px">${p.fvgHeading}</h5>
        ${sel('ofMinScore', p.minScore, opts.minScore, [[0, p.allGaps], [40, '40+'], [60, p.institutional], [75, p.strong]])}
        ${sel('ofMinSize', p.minSize, opts.minSizeAtr, [[0, p.any], [0.1, '0.1 × ATR'], [0.25, '0.25 × ATR'], [0.5, '0.5 × ATR']])}
        ${sel('ofShow', p.show, opts.openOnly ? 'open' : 'all', [['open', p.openGaps], ['all', p.openFilled]])}`;
    }
    function setOpt(patch) {
      opts = { ...opts, ...patch }; saveOpts(); renderTop();
      if (tool) tool.setOptions(patch);
      if (snap) renderSide();
    }

    const tile = (k, v, small) => `<div class="tile"><div class="k">${k}</div><div class="v num ${small ? 'sm' : ''}">${v}</div></div>`;
    const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    function fvgCard(f) {
      const bull = f.dir === 'bull', done = isDone(f), c = (k, p) => tr(T.fvg[k], p), price = snap.price;
      const inside = !done && price !== null && price >= f.lo && price <= f.hi;
      let fpTxt;
      if (f.fp) { const thin = c(f.fp.thin < 0.6 ? 'thin' : f.fp.thin < 1 ? 'lighter' : 'heavy'); fpTxt = c(bull ? 'fpBuy' : 'fpSell', { n: f.fp.stacked, pct: Math.round(f.fp.gapShare * 100), thin }); }
      else fpTxt = c('fpMissing');
      const dist = price === null ? '—' : inside ? c('inside') : Math.abs(bull ? price - f.hi : f.lo - price).toFixed(decimals(symbol.tick));
      const defended = bull ? f.test && f.test.zoneDelta > 0 : f.test && f.test.zoneDelta < 0;
      const cl = v => (v >= 0 ? 'text-bull' : 'text-bear');
      let retest = '';
      if (f.test) {
        retest = `<p class="m">${c('retest')}: ` + (f.test.hasFp
          ? `${c('deltaInGap')} <b class="${cl(f.test.zoneDelta)}">${R(f.test.zoneDelta)}</b> — ${c(defended ? (bull ? 'buyersDefended' : 'sellersDefended') : (bull ? 'sellersPushed' : 'buyersPushed'))}.`
          : `${c('barDelta')} <b class="${cl(f.test.barDelta)}">${R(f.test.barDelta)}</b>.`) + '</p>';
      }
      return `<button class="fv ${bull ? 'bull' : 'bear'} ${done ? 'done' : ''} ${inside ? 'in' : ''}" data-i="${f.i}">
        <div class="r1"><span class="num nm">${c(bull ? 'bull' : 'bear')} ${pxf(f.lo)}–${pxf(f.hi)} <span class="sc">${f.score}</span></span><span class="num dt">${new Date(f.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
        <p>${c(bull ? 'displacedUp' : 'displacedDown')}: ${c('body')} <b>${f.bodyAtr.toFixed(1)}× ATR</b>, <b>${f.volRatio.toFixed(1)}×</b> ${c('avgVolume')}, ${c(bull ? 'netBuyers' : 'netSellers')} <b class="${f.netPct >= 0 ? 'text-bull' : 'text-bear'}">${Math.round(f.netPct * 100)}%</b> (Δ ${R(f.delta)}).</p>
        <p class="m">${c('footprint')}: ${fpTxt}</p>${retest}
        <div class="num g3"><span>${c('size')} <b>${f.sizeAtr.toFixed(2)} ATR</b></span><span>${c('filled')} <b>${Math.round(f.filledPct * 100)}%</b></span><span>50% <b>${pxf((f.lo + f.hi) / 2)}</b></span><span>${c('dist')} <b>${dist}</b></span><span class="c2">${c('barPoc')} <b>${f.fp && f.fp.pocPx !== null ? pxf(f.fp.pocPx) : '—'}</b></span></div>
        <div class="tags">${f.forming ? `<span class="tg cy">${c('forming')}</span>` : ''}<span class="tg st-${f.state}" title="${esc(T.stateHelp[f.state])}">${T.state[f.state]}</span>${inside ? `<span class="tg am">${c('priceInside')}</span>` : ''}</div></button>`;
    }
    function renderSide() {
      const s = snap;
      $('#ofStats').innerHTML = [
        tile(T.stats.openBull, `<span class="text-bull">${s ? s.openBull : '—'}</span>`),
        tile(T.stats.openBear, `<span class="text-bear">${s ? s.openBear : '—'}</span>`),
        tile(T.stats.nearestBull, s && s.nearestBull ? `<span class="text-bull">${pxf(s.nearestBull.lo)}–${pxf(s.nearestBull.hi)}</span>` : '—', true),
        tile(T.stats.nearestBear, s && s.nearestBear ? `<span class="text-bear">${pxf(s.nearestBear.lo)}–${pxf(s.nearestBear.hi)}</span>` : '—', true),
        tile(T.stats.book, s && (s.bidDepth || s.askDepth) ? `<span class="text-bull">${L(s.bidDepth)}</span> / <span class="text-bear">${L(s.askDepth)}</span>` : '—', true),
        tile(T.stats.cvd, !s || s.cvd == null ? '—' : `<span class="${s.cvd >= 0 ? 'text-bull' : 'text-bear'}">${R(s.cvd)}</span>`, true)
      ].join('');
      $('#ofNote').innerHTML = s ? `${s.heatFrom ? tr(T.note.heatSince, { time: clock(s.heatFrom) }) : T.note.heatNow} ${s.fpFrom ? tr(T.note.fpFrom, { time: clock(s.fpFrom) }) : T.note.fpLoading}` : '';
      $('#ofGaps').innerHTML = !s ? `<p class="empty">${T.waiting}</p>` : s.fvgs.length === 0 ? `<p class="empty">${T.noGaps}</p>` : s.fvgs.map(fvgCard).join('');
      const st = s ? s.status : 'connecting', el = $('#ofStatus');
      el.className = `status ${st}`; el.querySelector('span').textContent = T.status[st];
      $('#ofPrice').textContent = s && s.price != null ? pxf(s.price) : '';
      const ld = $('#ofLoading'), hasPrice = s && s.price != null;
      ld.classList.toggle('hide', !!hasPrice);
      $('#ofLoadingTxt').textContent = s && s.error ? `Não foi possível carregar os dados (${s.error}). Tentando de novo… Se for HTTP 451/403, a Binance está bloqueando a sua rede/região.` : tr(T.connecting, { symbol: symbol.binance });
    }
    function onSnap(s) { snap = s; renderSide(); }

    function begin() {
      if (tool) tool.destroy();
      snap = null; renderTop(); renderSide();
      tool = createTool({ wrap: $('#ofWrap'), heat: $('#ofHeat'), chart: $('#ofChart'), overlay: $('#ofOverlay'), depth: $('#ofDepth'), readout: $('#ofReadout'), cvdLabel: $('#ofCvdLab'), deltaLabel: $('#ofDeltaLab') }, symbol, opts, onSnap);
    }

    function build() {
      built = true;
      $('#ofTf').setAttribute('aria-label', T.timeframe);
      $('#ofSettingsLab').textContent = T.settings;
      $('#ofBookTitle').title = T.bookTitle; $('#ofBookLab').textContent = T.book;
      $('#ofCvdLab').textContent = T.cvd; $('#ofDeltaLab').textContent = T.deltaBar;
      $('#ofNearH').textContent = T.nearHeading; $('#ofGapsH').textContent = T.gapsHeading; $('#ofHowBtn').title = T.howToRead;
      const k = T.key, l = T.layers;
      $('#ofKey').innerHTML = `<button class="x" id="ofKeyClose" aria-label="${T.close}">×</button><p><b>${l.heatmap}</b>: ${k.heatmap}</p><p><b>${l.bubbles}</b>: ${k.bubbles}</p><p><b>${l.footprint}</b>: ${k.footprint}</p><p><b>FVG</b>: ${k.fvg}</p><p><b>${k.cvdTerm}</b>: ${k.cvd}</p>`;
      $('#ofKeyClose').onclick = () => { $('#ofKey').hidden = true; };
      $('#ofHowBtn').onclick = () => { $('#ofKey').hidden = !$('#ofKey').hidden; };

      $('#ofSymBtn').onclick = e => { e.stopPropagation(); $('#ofSymMenu').classList.toggle('open'); if ($('#ofSymMenu').classList.contains('open')) $('#ofSearch').focus(); };
      $('#ofSymMenu').onclick = e => { e.stopPropagation(); const b = e.target.closest('button[data-s]'); if (!b) return; pick(cfg.symbols.find(s => s.binance === b.dataset.s)); };
      $('#ofSymMenu').oninput = e => { if (e.target.id === 'ofSearch') renderMenu(); };
      $('#ofSymMenu').onkeydown = e => { if (e.key === 'Enter' && e.target.id === 'ofSearch') { const b = $('#ofSymMenu button[data-s]'); if (b) b.click(); } };
      $('#ofTf').onclick = e => { const b = e.target.closest('button'); if (b) setOpt({ tf: b.dataset.v }); };
      $('#ofChips').onclick = e => { const b = e.target.closest('button'); if (b) setOpt({ [b.dataset.k]: !opts[b.dataset.k] }); };
      $('#ofCfgBtn').onclick = e => { e.stopPropagation(); const p = $('#ofCfgPop'); p.hidden = !p.hidden; if (!p.hidden) renderCfg(); };
      $('#ofCfgPop').onclick = e => e.stopPropagation();
      $('#ofCfgPop').onchange = e => {
        const id = e.target.id, v = e.target.value, num = x => (x === 'auto' ? 'auto' : Number(x));
        if (id === 'ofFpRow') setOpt({ fpRow: num(v) });
        else if (id === 'ofHeatRow') setOpt({ heatRow: num(v) });
        else if (id === 'ofMinScore') setOpt({ minScore: Number(v) });
        else if (id === 'ofMinSize') setOpt({ minSizeAtr: Number(v) });
        else if (id === 'ofShow') setOpt({ openOnly: v === 'open' });
      };
      $('#ofCfgPop').oninput = e => {
        if (e.target.id !== 'ofGain') return;
        opts.heatGain = Number(e.target.value); saveOpts();
        if (tool) tool.setOptions({ heatGain: opts.heatGain });
        $('#ofGainLab').textContent = `${opts.heatGain.toFixed(1)}×`;
      };
      $('#ofGaps').onclick = e => { const b = e.target.closest('button[data-i]'); if (b && tool) tool.focusBar(Number(b.dataset.i)); };
      document.addEventListener('mousedown', e => {
        if (!e.target.closest('#ofCfgPop') && !e.target.closest('#ofCfgBtn')) $('#ofCfgPop').hidden = true;
        if (!e.target.closest('#ofSymMenu') && !e.target.closest('#ofSymBtn')) $('#ofSymMenu').classList.remove('open');
      });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#ofCfgPop').hidden = true; $('#ofSymMenu').classList.remove('open'); } });
    }
    function pick(s) { if (!s) return; symbol = s; $('#ofSymMenu').classList.remove('open'); cfg.onSymbolChange(s); begin(); }

    return {
      init(c) { cfg = c; },
      start(sym) { symbol = sym; if (!built) build(); begin(); },
      stop() { if (tool) { tool.destroy(); tool = null; } },
      setSymbol(sym) { symbol = sym; if (tool) begin(); }
    };
  })();

  window.OrderFlowUI = UI;
})();
