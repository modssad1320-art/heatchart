// Busca de dados das exchanges (Binance Futures e Bybit), compartilhada entre as abas.
// As chamadas saem do navegador; o proxy local (/api/...) só entra como reserva.
(function () {
  'use strict';
  const E = window.HeatEngine;
  // ---------- dados das exchanges (via proxy local /api/...) ----------
  const BIN = '/api/binance', BYB = '/api/bybit';
  const bybitSym = s => (s === '1000SHIBUSDT' ? 'SHIB1000USDT' : s);
  // As chamadas saem direto do SEU navegador (como no site original), então valem a região/IP de quem abre a página.
  // O proxy do server.js só é usado como reserva se o navegador não conseguir chamar a exchange (rede/CORS).
  const BASES = { binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com' };
  const mode = { binance: 'direct', bybit: 'direct' };
  async function fetchJson(u, signal) {
    const r = await fetch(u, { signal });
    const txt = await r.text();
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${txt.slice(0, 120)}`), { http: true });
    return JSON.parse(txt);
  }
  async function getJson(url, signal) {
    const m = url.match(/^\/api\/(binance|bybit)(\/.*)$/);
    const ex = m[1], path = m[2];
    if (mode[ex] === 'direct') {
      try { return await fetchJson(BASES[ex] + path, signal); }
      catch (e) { if (e.http || e.name === 'AbortError') throw e; mode[ex] = 'proxy'; console.warn(`[heatmap] ${ex} direto falhou (${e.message}); usando o proxy local`); }
    }
    return fetchJson(url, signal);
  }
  async function binKlines(sym, interval, limit, signal) {
    const j = await getJson(`${BIN}/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(1500, limit)}`, signal);
    return j.map(k => ({ t: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5], takerBuy: +k[9] }));
  }
  async function binOiHist(sym, limit, signal) {
    const j = await getJson(`${BIN}/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=${Math.min(500, limit)}`, signal);
    return j.map(e => ({ t: e.timestamp, oi: +e.sumOpenInterest }));
  }
  async function binOiNow(sym, signal) {
    const j = await getJson(`${BIN}/fapi/v1/openInterest?symbol=${sym}`, signal);
    return { t: j.time, oi: +j.openInterest };
  }
  async function bybitCall(path, signal) {
    const j = await getJson(`${BYB}${path}`, signal);
    if (j.retCode !== 0) throw new Error(j.retMsg || `Bybit ${j.retCode}`);
    return j.result;
  }
  async function bybKlines(sym, limit, signal) {
    const r = await bybitCall(`/v5/market/kline?category=linear&symbol=${sym}&interval=5&limit=${Math.min(1000, limit)}`, signal);
    return r.list.map(k => ({ t: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], vol: +k[5], takerBuy: NaN })).reverse();
  }
  async function bybOiHist(sym, limit, signal) {
    const out = [];
    let cursor = '';
    while (out.length < limit) {
      const r = await bybitCall(`/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, signal);
      out.push(...r.list.map(e => ({ t: +e.timestamp, oi: +e.openInterest })));
      if (!r.nextPageCursor || !r.list.length) break;
      cursor = r.nextPageCursor;
    }
    return out.reverse();
  }
  async function bybOiNow(sym, signal) {
    const r = await bybitCall(`/v5/market/tickers?category=linear&symbol=${sym}`, signal);
    return { t: Date.now(), oi: +r.list[0].openInterest };
  }
  async function fetchExchange(ex, sym, nSteps, binK, signal) {
    const n = nSteps + 2;
    if (ex === 'binance') {
      const [oi, now] = await Promise.all([binOiHist(sym, n, signal), binOiNow(sym, signal).catch(() => null)]);
      return E.buildSteps(binK.slice(-n), oi, now);
    }
    const bs = bybitSym(sym);
    const [k, oi, now] = await Promise.all([bybKlines(bs, n, signal), bybOiHist(bs, n, signal), bybOiNow(bs, signal).catch(() => null)]);
    return E.buildSteps(k, oi, now, new Map(binK.map(e => [e.t, e])));
  }
  const liqBinance = o => {
    const p = Number(o.ap) || Number(o.p), q = Number(o.z) || Number(o.q);
    return p > 0 && q > 0 ? { id: `b${o.T}${o.S}${q}`, ex: 'binance', side: o.S === 'SELL' ? 'long' : 'short', price: p, qty: q, usd: p * q, t: o.T } : null;
  };
  const liqBybit = o => {
    const p = Number(o.p), q = Number(o.v);
    return p > 0 && q > 0 ? { id: `y${o.T}${o.S}${o.v}`, ex: 'bybit', side: o.S === 'Buy' ? 'long' : 'short', price: p, qty: q, usd: p * q, t: o.T } : null;
  };


  // GET genérico na Binance (depth, aggTrades...): direto no navegador, proxy como reserva
  async function binGet(path, signal) { return getJson(`${BIN}${path}`, signal); }

  window.HeatData = { bybitSym, getJson, binGet, binKlines, binOiHist, binOiNow, bybKlines, bybOiHist, bybOiNow, fetchExchange, liqBinance, liqBybit };
})();
