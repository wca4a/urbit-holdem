// verify.mjs: run the page's own checking code (the block between VERIFY-BEGIN and VERIFY-END in
// ship/poker-ui.html) outside the browser. Bots play against ../poker.wasm, each keeping its own
// record like a browser would, and every finished hand must pass. Then tampered proofs must fail.
// usage: node verify.mjs [hands]
import fs from 'fs'; import crypto from 'crypto';
const page = fs.readFileSync(new URL('../ship/poker-ui.html', import.meta.url), 'utf8');
const code = page.slice(page.indexOf('/*VERIFY-BEGIN*/'), page.indexOf('/*VERIFY-END*/'));
const { sha256, hexOf, commitmentOf, deckOf, checkProof } = new Function(code + '; return { sha256, hexOf, commitmentOf, deckOf, checkProof };')();
for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {   // the page's SHA-256 against Node's
  const m = crypto.randomBytes(n);
  if (hexOf(sha256(m)) !== crypto.createHash('sha256').update(m).digest('hex')) throw new Error('sha256 differs at length ' + n);
}
let entropy = 1n;
const env = { ship_entropy: () => { entropy = (entropy * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return BigInt.asIntN(64, entropy); } };
const { instance: { exports: e } } = await WebAssembly.instantiate(fs.readFileSync(new URL('../poker.wasm', import.meta.url)), { env });
let views = {};
function send(req) {
  const buf = Buffer.from(JSON.stringify(req)), p = e.request(buf.length) >>> 0; new Uint8Array(e.memory.buffer).set(buf, p);
  const n = e.handle(buf.length) >>> 0, q = e.response() >>> 0;
  const out = Buffer.from(new Uint8Array(e.memory.buffer, q, n)).toString().split('\n');
  views = {}; for (const l of out.slice(1)) views[l.slice(0, 32)] = JSON.parse(l.slice(32));
  for (const t of toks) if (views[t]) watch(t, views[t]);
  return JSON.parse(out[0]);
}
let seed = 7n; const rnd = n => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn; return Number((seed >> 33n) % BigInt(n)); };
const toks = [1, 2, 3, 4, 5].map(i => i.toString(16).padStart(32, '0')), mine = {}; toks.forEach(t => mine[t] = {});
function watch(t, v) {   // what the page's fair() remembers
  if (v.next.commit) { const m = mine[t][v.next.hand] = mine[t][v.next.hand] || { commit: v.next.commit, seed: null, seat: null, cards: null, board: [] }; if (m.commit !== v.next.commit) throw new Error('fingerprint changed'); }
  if (v.stage !== 'idle') { const m = mine[t][v.hand] = mine[t][v.hand] || { commit: null, seed: null, seat: null, cards: null, board: [] };
    if (v.seats[v.you].cards.length === 2) { m.cards = v.seats[v.you].cards.slice(); m.seat = v.you; } if (v.board.length >= m.board.length) m.board = v.board.slice();
    if (JSON.stringify(v).includes('"secret"')) throw new Error('a secret is visible during a hand'); }
}
const want = +process.argv[2] || 300; let checked = 0, done = 0, lastProof = null, lastSeen = null;
toks.forEach((t, i) => send({ op: 'join', token: t, name: 'bot' + i }));
while (done < want) {
  const spec = views['0'.repeat(32)];
  if (spec.stage === 'idle') {
    for (const t of toks) { const v = views[t]; if (!v) continue;
      if (v.proof && !mine[t][v.proof.hand].checked) { const seen = mine[t][v.proof.hand], res = checkProof(v.proof, seen);
        if (!res.ok || res.lines.some(l => l.ok !== true)) throw new Error('hand ' + v.proof.hand + ' failed for ' + t + ': ' + JSON.stringify(res.lines));
        seen.checked = true; checked++; lastProof = v.proof; lastSeen = seen; }
      if (v.seats[v.you].busted) send({ op: 'rebuy', token: t }); }
    for (const t of toks) { const v = views[t], m = mine[t][v.next.hand]; if (!m.seed) { m.seed = crypto.randomBytes(16).toString('hex'); m.seat = v.you; send({ op: 'seed', token: t, seed: m.seed }); } }
    send({ op: 'deal', token: toks[0] }); done++; continue;
  }
  const t = toks.find(t => views[t].actions), a = views[t].actions, pick = rnd(100);
  if (pick < 10) send({ op: 'act', token: t, action: 'fold' });
  else if (pick < 25 && a.can_raise) send({ op: 'act', token: t, action: 'raise', amount: pick < 13 ? a.max_raise_to : a.min_raise_to });
  else send({ op: 'act', token: t, action: a.can_check ? 'check' : 'call' });
}
// a dishonest table must be caught: change one thing at a time in a real proof
const clone = () => JSON.parse(JSON.stringify(lastProof)), fails = p => !checkProof(p, lastSeen).ok;
const flip = h => (h[0] === 'a' ? 'b' : 'a') + h.slice(1);
const cases = {
  'a different secret': p => { p.secret = flip(p.secret); },
  'a different secret with a matching fingerprint': p => { p.secret = flip(p.secret); p.commit = commitmentOf(p.secret); },
  'my number left out': p => { p.seeds[lastSeen.seat] = ''; },
  'my number replaced': p => { p.seeds[lastSeen.seat] = flip(p.seeds[lastSeen.seat]); },
  'two cards swapped in the deck': p => { [p.deck[0], p.deck[51]] = [p.deck[51], p.deck[0]]; },
  'another player\'s number changed after the fact': p => { const i = p.seeds.findIndex((s, k) => s && k !== lastSeen.seat); p.seeds[i] = flip(p.seeds[i]); },
};
for (const [name, change] of Object.entries(cases)) { const p = clone(); change(p); if (!fails(p)) throw new Error('not caught: ' + name); }
console.log(`${done} hands dealt, ${checked} player-checks passed, every check line true; ${Object.keys(cases).length} kinds of tampering all caught`);
