# GALAXI GLOBAL SCANNER — PAPER V1

Scanner global para probar GALAXI con datos públicos de Binance sin API keys y sin dinero real.

Incluye:
- universo completo de futuros USD-M USDT perpetuals en estado TRADING;
- WebSocket global `!miniTicker@arr`;
- historial por símbolo;
- movimiento 1s/2s/5s/15s;
- velocidad y aceleración;
- ranking dinámico;
- rotación y cooldown de 5 minutos;
- hasta 12 posiciones PAPER, máximo 6 por lado;
- TP/SL/timeout PAPER;
- comisión y slippage simulados;
- dashboard en vivo.

## Railway
Start Command: `node server.js`

No configures API keys para esta prueba.

## Importante
Esto NO garantiza utilidades futuras. La prueba válida es dejarlo en PAPER con mercado real y evaluar PnL neto, tasa de acierto, drawdown y rotación antes de activar LIVE.
