// Run on an empty disposable guest dealer, e.g. node test/guest-presence.mjs 34981.
// Uses the dealer's real 20-second close grace and two-minute silent timeout.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const dealer = new URL('http://127.0.0.1');
dealer.port = process.argv[2] || '34721';
const players = Array.from({ length: 4 }, () => randomBytes(16).toString('hex'));
const spectator = '0'.repeat(32);
const post = async (route, data) => {
  const res = await fetch(new URL('/poker/' + route, dealer), {
    method: 'POST', body: data, signal: AbortSignal.timeout(10000),
  });
  assert.equal(res.status, 200);
  return res.json();
};
const poll = async token => (await post('poll', token)).view;
const disconnect = token => post('disconnect', token);
async function move(token, action) {
  const result = await post('api', JSON.stringify({ token, ...action }));
  assert.equal(result.ok, true, result.error);
}

async function until(deadline, check, message) {
  do {
    if (await check()) return;
    await sleep(750);
  } while (performance.now() < deadline);
  assert.fail(message);
}

const mode = await (await fetch(new URL('/poker/auth/session', dealer))).json();
assert.deepEqual(mode, { standalone: true }, 'requires a standalone dealer');
assert.ok(!(await poll(spectator))?.seats.some(Boolean), 'requires an empty dealer');
try {
  for (const [i, token] of players.slice(0, 3).entries()) {
    await move(token, { op: 'join', name: 'Presence ' + i });
  }
  await move(players[0], { op: 'deal' });
  const deal = await poll(spectator);
  await move(players[deal.to_act], { op: 'act', action: 'call' });
  const initial = await poll(spectator);
  const absent = initial.to_act;
  const returning = (absent + 1) % 3;
  const active = (absent + 2) % 3;
  const cards = (await poll(players[returning])).seats[returning].cards;
  assert.equal(initial.stage, 'preflop');
  assert.ok(initial.seats[absent].bet > 0, 'the missing player has chips in the pot');
  assert.equal(cards.length, 2);

  const silentStart = performance.now();
  await move(players[3], { op: 'join', name: 'Silent guest' });
  await disconnect(players[returning]);
  await disconnect(players[absent]);
  const closeStart = performance.now();
  await sleep(3000);
  const reconnected = await poll(players[returning]);
  assert.equal(reconnected.to_act, absent, 'close allows time to reconnect');
  assert.deepEqual(reconnected.seats[returning].cards, cards);

  await until(closeStart + 35000, async () => {
    const view = await poll(players[active]);
    return view.seats[absent]?.folded && view.to_act !== absent;
  }, 'an absent guest was still blocking the hand');
  assert.ok(performance.now() >= closeStart + 18000, 'the reconnect grace ended early');
  const afterFold = await poll(players[returning]);
  assert.deepEqual(afterFold.seats[returning].cards, cards, 'return restored the same hand');
  assert.equal(afterFold.seats[returning].folded, false);
  await move(players[afterFold.to_act], { op: 'act', action: 'fold' });
  const finished = await poll(spectator);
  assert.equal(finished.stage, 'idle');
  assert.equal(finished.seats[absent], null, 'free the abandoned seat at hand end');
  assert.equal(finished.seats[active].chips + finished.seats[returning].chips,
    2000 + initial.seats[absent].bet, 'credit the pot including the abandoned blind');

  // The fourth player joined mid-hand and never sends a beacon or heartbeat.
  assert.equal(finished.seats[3].name, 'Silent guest');
  await until(silentStart + 155000, async () => {
    await poll(players[active]);
    const view = await poll(players[returning]);
    assert.equal(view.you, returning);
    assert.ok(view.seats[active]);
    if (performance.now() < silentStart + 115000) assert.ok(view.seats[3], 'silent timeout ended early');
    return view.seats[3] === null;
  }, 'the guest that vanished without a beacon kept its seat');
  console.log('Passed guest reconnect, automatic fold, turn advance, blind accounting and silent timeout.');
} finally {
  for (const token of players) {
    if ((await poll(token))?.you != null) await move(token, { op: 'leave' });
  }
}
