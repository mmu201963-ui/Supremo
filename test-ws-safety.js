const WebSocket = require('ws');
let ws = new WebSocket('ws://127.0.0.1:1');
let safe = true;
ws.on('error', ()=>{});
try { ws.terminate(); } catch { safe = false; }
setTimeout(()=>{ console.log(safe ? 'WS_TERMINATE_SAFETY_TEST=PASS' : 'WS_TERMINATE_SAFETY_TEST=FAIL'); },50);
