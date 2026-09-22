# SUPREMO — Global Low-Latency Profit Engine PAPER V2

Motor PAPER para probar SUPREMO con datos públicos de Binance USD-M Futures antes de usar dinero real.

## Cambios principales V2

- Universo completo de futuros USD-M USDT perpetuals en estado `TRADING`.
- Feed de mercado por WebSocket con suscripción individual `@miniTicker` para todo el universo (hasta 1024 streams por conexión; SUPREMO usa el número real de mercados detectados).
- Ruta principal `wss://fstream.binance.com/market/stream` y fallback global `!miniTicker@arr`.
- Reconexión automática y watchdog: si el feed queda sin datos, SUPREMO no abre operaciones.
- Cobertura visible: mercados detectados vs mercados con datos reales.
- Actualización individual de mini ticker a 500 ms para el radar; el stream global es fallback de 1000 ms.
- Escaneo interno cada 250 ms (configurable). Esto no crea datos nuevos si el feed no los entrega; sirve para reaccionar inmediatamente cuando llega un tick.
- Historial por símbolo de 60 s.
- Señal de velocidad + aceleración + persistencia + penalización de agotamiento.
- Filtro de `edge` estimado después de costes básicos de comisión y slippage.
- LONG y SHORT.
- Rotación de candidatos y cooldown de 5 minutos para evitar repetir siempre las mismas monedas.
- Hasta 12 posiciones PAPER, máximo 6 LONG y 6 SHORT.
- TP/SL/timeout PAPER.
- PnL neto con comisión y slippage simulados.
- Registro de operaciones y drawdown máximo.
- Dashboard con feed, cobertura, latencia del scan, mensajes, updates, reconexiones y PnL.

## Railway

Start Command:

```bash
node server.js
```

Para PAPER **no configures API Keys de Binance**.

Variables opcionales:

- `PAPER_START_CAPITAL=10000`
- `SCAN_MS=250`
- `MIN_EDGE=0.00065`
- `MAX_POSITIONS=12`
- `MAX_SIDE=6`
- `LEVERAGE=5`
- `POSITION_MARGIN=100`
- `PAPER_TP=0.006`
- `PAPER_SL=0.004`
- `PAPER_MAX_HOLD_MS=900000`
- `FEED_TIMEOUT_MS=8000`
- `COOLDOWN_MS=300000`

## Qué debe mostrar

Al estabilizarse el feed, el panel debe pasar de `ESPERANDO FEED` a `FEED OK` y mostrar una cobertura cercana a `528/528` (el número exacto depende del universo que Binance entregue en ese momento).

Si aparece `WS OK` pero `Datos 0/...`, **NO es un feed operativo** y SUPREMO no debe abrir posiciones.

## Objetivo de utilidad

El objetivo del motor es buscar PnL neto positivo, no simplemente generar muchas operaciones. Esto no constituye una garantía de rentabilidad. Antes de LIVE hay que medir en mercado real PAPER, durante un periodo suficiente, PnL neto, tasa de acierto, ganancia/pérdida media, drawdown, costes, rotación y estabilidad.

## LIVE

Esta V2 sigue siendo PAPER. No contiene ejecución de órdenes reales. Para LIVE habrá que añadir una capa separada de autenticación, ejecución y confirmación de órdenes/posiciones mediante los User Data Streams de Binance.
