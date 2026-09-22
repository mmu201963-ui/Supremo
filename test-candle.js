const assert=require('node:assert');
function d(c){return c.close>c.open?'LONG':c.close<c.open?'SHORT':null}
function s(a,b){const x=d(a),y=d(b);return x&&x===y?y:null}
assert.equal(s({open:100,close:101},{open:101,close:102}),'LONG');
assert.equal(s({open:100,close:99},{open:99,close:98}),'SHORT');
assert.equal(s({open:100,close:101},{open:101,close:100}),null);
console.log('CLOSED_TWO_CANDLE_TEST=PASS');
