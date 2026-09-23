# SUPREMO Mean Reversion 4H — FINAL

Versión corregida para Railway.

La anterior falló con `SyntaxError: missing ) after argument list`. Esta versión:
- usa CommonJS (`require`) en lugar de ESM;
- separa el HTML de `server.js`;
- escucha en `0.0.0.0` y usa `PORT`;
- incluye `/health`;
- no necesita API keys;
- es PAPER;
- intenta Binance Futures USD-M y luego Spot;
- usa la última vela 4H cerrada;
- BUY: RSI(14) < 30 y precio <= Bollinger inferior;
- SELL: RSI(14) > 60 o precio >= SMA20;
- stop configurable 3–5%, por defecto 4%;
- máximo 5% del capital por posición.

Railway:
1. Reemplaza el contenido del servicio por este ZIP.
2. El Start Command debe ser `npm start`.
3. No agregues API keys.
4. Espera a que el deployment quede `Success`.
5. Abre la URL pública.

El sistema no garantiza beneficios y esta estrategia puede fallar en tendencias fuertes.
