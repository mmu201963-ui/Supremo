const assert = require('assert');

function featureScore(h) {
  const p = h.at(-1).price;
  const ts = h.at(-1).ts;
  const ret = (w) => {
    for (let i = h.length - 1; i >= 0; i--) {
      if (ts - h[i].ts >= w) return p / h[i].price - 1;
    }
    return null;
  };
  const r1 = ret(1000), r2 = ret(2000), r5 = ret(5000);
  assert(r1 !== null && r2 !== null && r5 !== null);
  return .40 * (r2 / 2) + .30 * (r1 - r2 / 2) + .30 * (r5 / 5);
}

const up = Array.from({length:16}, (_,i) => ({ts:i*1000, price:100+i*0.30}));
const dn = Array.from({length:16}, (_,i) => ({ts:i*1000, price:100-i*0.30}));
assert(featureScore(up) > 0, 'uptrend must score positive');
assert(featureScore(dn) < 0, 'downtrend must score negative');

const roundTripCost = (0.0004 + 0.0002) * 2;
assert(roundTripCost > 0 && roundTripCost < 0.01);

console.log('SUPREMO_V2_SYNTHETIC_TEST=PASS');
