# Heatmap de liquidações + Order Flow local (BTC · ETH · XAU)

Clone do mapa de liquidações do The Tradeskill, feito a partir do código que o próprio site entrega ao navegador.
Não depende do site deles: fala direto com a Binance Futures e a Bybit (APIs públicas, sem chave).

## Como rodar
1. Instale o Node.js 18 ou mais novo (https://nodejs.org).
2. Nesta pasta: `node server.js`
3. Abra http://localhost:3000   (outra porta: `PORT=4000 node server.js`)

Todas as chamadas às exchanges (REST e websockets) saem direto do navegador de quem abre a página, como no site original.
Por isso vale a região de quem acessa, e não a do servidor (a Binance bloqueia IPs dos EUA, onde ficam muitos servidores de hospedagem).
O `server.js` só serve os arquivos; o proxy `/api/...` dele é apenas reserva.
A biblioteca de gráfico (`lightweight-charts`, da TradingView) já está em `public/vendor`, então não precisa de internet para ela.
(Só a fonte Inter vem do Google Fonts; sem internet usa a fonte do sistema.)

## De onde vêm os dados (conferido no código do site)
- Binance Futures (Order Flow): `/fapi/v1/depth`, `/fapi/v1/aggTrades`, websockets `depth@100ms`, `aggTrade` e `kline`.
- Binance Futures: `/fapi/v1/klines`, `/futures/data/openInterestHist`, `/fapi/v1/openInterest` e websocket `kline` + `forceOrder`.
- Bybit: `/v5/market/kline`, `/v5/market/open-interest`, `/v5/market/tickers` e websocket `allLiquidation`.
- Não existe API própria do site: o heatmap é calculado no navegador (`public/engine.js`) a partir desses dados.

## Abas
- **Heatmap de liquidações**: mapa estimado de onde posições alavancadas seriam liquidadas (Binance + Bybit).
- **Order Flow** (só Binance Futures): heatmap do livro de ofertas gravado ao vivo, grandes trades, footprint, CVD e delta por barra,
  fair value gaps com nota 0–100 e paredes de liquidez. O heatmap do livro começa a ser gravado quando você abre a aba
  (guarda a última hora); o footprint já abre com os trades recentes e continua enchendo.

- **IA · Entradas**: motor de confluência (regras fixas e explicáveis, sem caixa-preta). Baixa na hora candles de 1m a 4h, os ~25 mil
  trades mais recentes, o livro e o open interest; cruza FVG, linha de 50%, footprint, CVD, grandes trades, paredes e clusters de liquidação
  (1H a 24H) e devolve as 3 melhores zonas de compra e de venda com entrada, stop, alvos, R:R e os motivos de cada uma.
  Informativo: não é recomendação nem garantia de resultado.

## Arquivos
- `public/engine.js`  simulação das posições, clusters, cascata (porta da lógica do site)
- `public/app.js`     abas, Heatmap: busca de dados, websockets, gráfico e painéis
- `public/orderflow.js` aba Order Flow (livro, trades, footprint, CVD, FVG)
- `public/flowcore.js`  cálculo de footprint e FVG (compartilhado)
- `public/data.js`      busca de dados Binance/Bybit (compartilhada)
- `public/analysis-core.js` motor de confluência (zonas, stop, alvos)
- `public/analysis.js`  coleta de dados e interface da aba IA · Entradas
- `public/index.html`, `public/style.css`  interface

## Hospedar online (ex.: Render)
O site é só arquivos estáticos. No Render, o mais simples é criar um **Static Site** apontando para a pasta `public` (sem comando de build).
Como Web Service também funciona (`node server.js`), mas o servidor não faz mais as chamadas às exchanges.
