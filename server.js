// Servidor local: serve a pasta /public e faz proxy das APIs públicas da Binance e da Bybit
// (o proxy evita problemas de CORS no navegador). Requer Node 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TARGET = { binance: 'https://fapi.binance.com', bybit: 'https://api.bybit.com' };
const ALLOWED = [/^\/fapi\/v1\/klines$/, /^\/fapi\/v1\/openInterest$/, /^\/fapi\/v1\/depth$/, /^\/fapi\/v1\/aggTrades$/, /^\/futures\/data\/openInterestHist$/, /^\/v5\/market\/open-interest$/, /^\/v5\/market\/kline$/, /^\/v5\/market\/tickers$/];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const m = u.pathname.match(/^\/api\/(binance|bybit)(\/.*)$/);
    if (m) {
      if (!ALLOWED.some(r => r.test(m[2]))) { res.writeHead(403); return res.end('endpoint não permitido'); }
      const r = await fetch(TARGET[m[1]] + m[2] + u.search, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const body = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    const fp = path.join(PUBLIC, path.normalize(rel));
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); return res.end('não encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, () => console.log(`Heatmap de liquidações rodando em http://localhost:${PORT}`));
