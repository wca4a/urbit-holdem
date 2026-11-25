import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { createBridge } from '../login/bridge.mjs';
import { createGateway } from '../login/gateway.mjs';

const gameOrigin = 'https://game.example';
const bridgeOrigin = 'https://identity.example';
const dealerOrigin = 'https://dealer.example';
const bridgeSecret = 'b'.repeat(32);
const dealerKey = 'd'.repeat(32);
const seatSecret = 's'.repeat(32);
const spectator = '0'.repeat(32);
const accounts = {
  '~zod': 'use-00000000-0000-0000-0000-000000000001',
  '~divmes-davset-samhec-fasnem': 'use-00000000-0000-0000-0000-000000000002',
};

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

// Same request/reply contract as the Gall dealer, running the checked-in engine.
async function makeDealer() {
  const wasm = await readFile(new URL('../poker.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasm, { env: { ship_entropy: () => 42n } });
  const engine = instance.exports;
  const views = new Map();
  let version = 0;
  function act(text) {
    const bytes = Buffer.from(text);
    const ptr = engine.request(bytes.length) >>> 0;
    new Uint8Array(engine.memory.buffer).set(bytes, ptr);
    const size = engine.handle(bytes.length) >>> 0;
    const output = Buffer.from(engine.memory.buffer, engine.response() >>> 0, size).toString();
    const [answer, ...lines] = output.split('\n');
    views.clear();
    for (const line of lines) views.set(line.slice(0, 32), JSON.parse(line.slice(32)));
    version++;
    return JSON.parse(answer);
  }
  act('{"op":"hello"}');
  return (path, body) => {
    if (path === '/poker/gateway-status') return { protected: true };
    if (path === '/poker/poll') return { v: version, view: views.get(body) ?? views.get(spectator) };
    assert.equal(path, '/poker/api');
    return act(body);
  };
}

test('two Tlon sessions play a hand on the Wasm dealer and reconnect to their own seats', async t => {
  const deal = await makeDealer();
  let time = Date.now(), protectedDealer = true;
  const issuer = await listen(t, createBridge({
    gameOrigin, bridgeOrigin, secret: bridgeSecret, now: () => time,
    fetchImpl: async (input, options) => {
      const cookie = new Headers(options.headers).get('cookie');
      const ship = Object.keys(accounts).find(s => cookie === 'SolarisSession=test-' + s);
      if (!ship) return Response.json({}, { status: 401 });
      const profile = bridgeOrigin + '/v1/users/' + accounts[ship];
      if (input === profile + '/pending-lures') return Response.json([]);
      assert.equal(input, profile);
      return Response.json({ id: accounts[ship], ships: [ship.slice(1)] });
    },
  }));
  const base = await listen(t, createGateway({
    gameOrigin, bridgeOrigin, dealerOrigin, bridgeSecret, seatSecret, dealerKey, now: () => time,
    fetchImpl: async (input, options) => {
      const url = new URL(input), headers = new Headers(options.headers);
      if (url.origin === dealerOrigin) {
        assert.equal(headers.get('x-poker-dealer-key'), dealerKey);
        return Response.json(deal(url.pathname, options.body), {
          headers: protectedDealer ? { 'X-Poker-Protected': '1' } : {},
        });
      }
      assert.equal(url.href, bridgeOrigin + '/holdem-auth/redeem');
      assert.equal(headers.get('authorization'), 'Bearer ' + bridgeSecret);
      return fetch(issuer + url.pathname, options);
    },
  }));
  function get(path, cookie = '') {
    return fetch(base + path, { redirect: 'manual', headers: { cookie } });
  }
  function post(path, cookie, body = '', origin = gameOrigin) {
    return fetch(base + path, { method: 'POST', headers: { cookie, origin }, body });
  }
  async function login(ship) {
    const start = await get('/poker/auth/start');
    assert.equal(start.status, 303);
    const target = new URL(start.headers.get('location'));
    assert.equal(target.origin + target.pathname, bridgeOrigin + '/holdem-auth/authorize');
    const state = target.searchParams.get('state');
    const stateCookie = start.headers.getSetCookie()[0].split(';')[0];
    const consent = await fetch(issuer + '/v1/holdem-auth/consent', {
      method: 'POST', redirect: 'manual', headers: { origin: bridgeOrigin, cookie: 'SolarisSession=test-' + ship },
      body: new URLSearchParams({ user: accounts[ship], state, ship }),
    });
    assert.equal(consent.status, 303);
    const targetGame = new URL(consent.headers.get('location'));
    assert.equal(targetGame.origin, gameOrigin);
    const callback = targetGame.pathname + targetGame.search;
    assert.equal((await get(callback)).status, 400, 'requires the initiating browser cookie');
    const success = await get(callback, stateCookie);
    assert.equal(success.status, 303);
    assert.equal(success.headers.get('location'), '/poker');
    assert.equal((await get(callback, stateCookie)).status, 400, 'rejects a used callback');
    const session = success.headers.getSetCookie().find(c => c.includes('-session='));
    assert.match(session, /HttpOnly/); assert.match(session, /Secure/);
    const cookie = session.split(';')[0];
    assert.deepEqual(await (await get('/poker/auth/session', cookie)).json(), { ship });
    return cookie;
  }
  async function move(cookie, fields) {
    const r = await post('/poker/api', cookie, JSON.stringify(fields));
    assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  }
  async function poll(cookie, body = '') {
    const r = await post('/poker/poll', cookie, body);
    assert.equal(r.status, 200);
    return r.json();
  }
  assert.match(await (await get('/poker')).text(), /const hostingLogin = true;/);
  assert.equal((await post('/poker/api', '', '{"op":"join"}')).status, 401);
  const a = await login('~zod'), b = await login('~divmes-davset-samhec-fasnem');
  const join = { op: 'join', token: spectator, name: 'wrong-name', ship: '~mar' };
  assert.equal((await post('/poker/api', a, JSON.stringify(join), bridgeOrigin)).status, 403);
  await move(a, join); await move(b, join);
  await move(a, { op: 'seed', seed: '12'.repeat(16) });
  await move(b, { op: 'seed', seed: '34'.repeat(16) });
  await move(a, { op: 'deal' });
  const first = await poll(a), second = await poll(b), guest = await poll('', 'ignored-browser-token');
  assert.deepEqual([first.ship, second.ship, guest.ship], ['~zod', '~divmes-davset-samhec-fasnem', null]);
  assert.deepEqual([first.view.you, second.view.you, guest.view.you], [0, 1, null]);
  assert.deepEqual(guest.view.seats.slice(0, 2).map(s => s.name), ['~zod', '~divmes-davset-samhec-fasnem']);
  for (const player of [first, second]) {
    const own = player.view.you;
    const cards = player.view.seats[own].cards;
    assert.equal(cards.length, 2);
    assert.ok(cards.every(c => /^[2-9TJQKA][cdhs]$/.test(c)));
    assert.deepEqual(player.view.seats[1 - own].cards, ['??', '??']);
    assert.deepEqual(guest.view.seats[own].cards, ['??', '??']);
  }
  assert.equal((await post('/poker/auth/logout', a)).status, 200);
  assert.equal((await poll(a)).view.you, null);
  const again = await login('~zod');
  assert.deepEqual((await poll(again)).view.seats[0].cards, first.view.seats[0].cards);
  const current = first.view.actions ? again : b;
  await move(current, { op: 'act', action: 'fold' });
  assert.equal((await poll(again)).view.stage, 'idle');
  time += 24 * 3600_000;
  assert.equal((await poll(again)).ship, null);
  protectedDealer = false;
  assert.ok((await post('/poker/poll', '')).status >= 500, 'requires dealer protection on every response');
});
