// mkpoker.mjs: let bots play hold'em against ../poker.wasm and write the requests they made,
// one per line, to poker-work.txt next to this file. Deterministic. usage: node mkpoker.mjs [requests]
import fs from 'fs';
const ENTROPY = 0x123456789abcdef0n;
const {instance:{exports:e}} = await WebAssembly.instantiate(fs.readFileSync(new URL('../poker.wasm', import.meta.url)), {env: {ship_entropy: () => ENTROPY}});
let seed = 20261125n;
const rnd = n => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((seed >> 33n) % BigInt(n)); };
const tok = i => (i + 1).toString(16).padStart(32, '0');
const NAMES = ['Ada', 'Grace', 'Alan', 'Linus', 'Barbara', 'Ken', 'Dennis', 'Margaret', 'Edsger', 'Radia'];
const lines = []; let views = {}; const stats = {};
function send(req) {
  const text = typeof req === 'string' ? req : JSON.stringify(req), buf = Buffer.from(text);
  lines.push(text);
  const p = e.request(buf.length) >>> 0; new Uint8Array(e.memory.buffer).set(buf, p);
  const n = e.handle(buf.length) >>> 0, q = e.response() >>> 0;
  const out = Buffer.from(new Uint8Array(e.memory.buffer, q, n)).toString().split('\n');
  views = {}; for (const l of out.slice(1)) views[l.slice(0, 32)] = JSON.parse(l.slice(32));
  const ans = JSON.parse(out[0]); const k = (req.op || 'bad') + (ans.ok ? '' : ' refused'); stats[k] = (stats[k] || 0) + 1;
  return ans;
}
const want = +process.argv[2] || 700;
send({op: 'hello'});
while (lines.length < want) {
  const spec = views['0'.repeat(32)], seated = Object.keys(views).filter(t => t !== '0'.repeat(32));
  const roll = rnd(100);
  if (seated.length < 2 || roll < 3) { const i = rnd(NAMES.length); send({op: 'join', token: tok(i), name: NAMES[i]}); continue; }
  if (roll < 4) { send({op: 'leave', token: seated[rnd(seated.length)]}); continue; }
  if (roll < 5) { send(['{"op":"act","token":', 'not json', '{"op":"fly"}'][rnd(3)]); continue; }
  if (roll < 7) { send({op: 'act', token: seated[rnd(seated.length)], action: ['call', 'check', 'raise'][rnd(3)], amount: rnd(500)}); continue; }  // often out of turn
  for (const t of seated) if (views[t] && views[t].seats[views[t].you].busted) send({op: 'rebuy', token: t});
  if (spec.stage === 'idle') for (const t of seated) if (views[t] && !views[t].next.seeded[views[t].you] && rnd(10) < 8) send(rnd(20) ? {op: 'seed', token: t, seed: Array.from({length: 32}, () => '0123456789abcdef'[rnd(16)]).join('')} : {op: 'seed', token: t, seed: 'nope'});
  if (spec.stage === 'idle') { send({op: 'deal', token: seated[rnd(seated.length)]}); continue; }
  const t = seated.find(t => views[t].actions); const a = views[t].actions; const pick = rnd(100);
  if (pick < 10) send({op: 'act', token: t, action: 'fold'});
  else if (pick < 30 && a.can_raise) send({op: 'act', token: t, action: 'raise', amount: pick < 14 ? a.max_raise_to : a.min_raise_to + rnd(Math.max(1, Math.min(60, a.max_raise_to - a.min_raise_to + 1)))});
  else send({op: 'act', token: t, action: a.can_check ? 'check' : 'call'});
}
fs.writeFileSync(new URL('poker-work.txt', import.meta.url), lines.join('\n') + '\n');
console.log(lines.length, 'requests', JSON.stringify(stats), 'hands', views['0'.repeat(32)].hand);
