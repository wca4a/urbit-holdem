import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { createGateway } from '../login/gateway.mjs';

const gameOrigin = 'https://game.example';
const issuer = 'https://identity.example/v1/oidc';
const dealerOrigin = 'https://dealer.example';
const clientId = 'holdem';
const clientSecret = 'b'.repeat(32);
const dealerKey = 'd'.repeat(32);
const seatSecret = 's'.repeat(32);
const spectator = '0'.repeat(32);

// The issuer fixture implements discovery, one-time codes with S256, JWKS and signed ID tokens.
function testIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', kid: 'test-key', use: 'sig' };
  const codes = new Map();
  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const authorize = (target, ship, overrides, invalidSignature) => {
    const p = target.searchParams;
    assert.equal(target.origin + target.pathname, issuer + '/authorize');
    assert.equal(p.get('scope'), 'openid ship');
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('client_id'), clientId);
    assert.equal(p.get('redirect_uri'), gameOrigin + '/poker/auth/callback');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok(p.get('nonce'));
    const code = randomUUID();
    codes.set(code, { ship, nonce: p.get('nonce'), challenge: p.get('code_challenge'), overrides, invalidSignature });
    return '/poker/auth/callback?' + new URLSearchParams({ state: p.get('state'), code, iss: issuer });
  };
  const serve = (url, options) => {
    if (url === issuer + '/.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/keys', response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], authorization_response_iss_parameter_supported: true,
    });
    if (url === issuer + '/keys') return Response.json({ keys: [jwk] });
    assert.equal(url, issuer + '/token');
    assert.equal(new Headers(options.headers).get('authorization'), 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'));
    const p = new URLSearchParams(options.body);
    assert.equal(p.get('grant_type'), 'authorization_code');
    assert.equal(p.get('redirect_uri'), gameOrigin + '/poker/auth/callback');
    const grant = codes.get(p.get('code'));
    assert.ok(grant);
    codes.delete(p.get('code'));
    assert.equal(createHash('sha256').update(p.get('code_verifier')).digest('base64url'), grant.challenge);
    const iat = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: clientId, sub: 'player-' + grant.ship, iat, exp: iat + 300,
      nonce: grant.nonce, ship: grant.ship, ...grant.overrides };
    const payload = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode(claims);
    const signature = sign('RSA-SHA256', Buffer.from(grant.invalidSignature ? 'invalid test signature' : payload), privateKey);
    return Response.json({ token_type: 'Bearer', access_token: 'test-access-token', id_token: payload + '.' + signature.toString('base64url') });
  };
  return { authorize, serve };
}

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
  const idp = testIssuer();
  const base = await listen(t, createGateway({
    gameOrigin, oidcIssuer: issuer, clientId, clientSecret, dealerOrigin, seatSecret, dealerKey, now: () => time,
    fetchImpl: async (input, options) => {
      const url = new URL(input), headers = new Headers(options.headers);
      if (url.origin === dealerOrigin) {
        assert.equal(headers.get('x-poker-dealer-key'), dealerKey);
        return Response.json(deal(url.pathname, options.body), {
          headers: protectedDealer ? { 'X-Poker-Protected': '1' } : {},
        });
      }
      return idp.serve(url.href, options);
    },
  }));
  function get(path, cookie = '') {
    return fetch(base + path, { redirect: 'manual', headers: { cookie } });
  }
  function post(path, cookie, body = '', origin = gameOrigin) {
    return fetch(base + path, { method: 'POST', headers: { cookie, origin }, body });
  }
  async function grant(ship, overrides, invalidSignature) {
    const start = await get('/poker/auth/start');
    assert.equal(start.status, 303);
    const target = new URL(start.headers.get('location'));
    const stateCookie = start.headers.getSetCookie()[0].split(';')[0];
    return { callback: idp.authorize(target, ship, overrides, invalidSignature), stateCookie };
  }
  async function login(ship) {
    const { callback, stateCookie } = await grant(ship);
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
  for (const [reason, overrides] of Object.entries({
    audience: { aud: 'another-app' }, issuer: { iss: 'https://another.example' },
    nonce: { nonce: 'wrong-nonce' }, expiration: { exp: 1000 }, signature: {},
  })) {
    const { callback, stateCookie } = await grant('~zod', overrides, reason === 'signature');
    const denied = await get(callback, stateCookie);
    assert.equal(denied.status, 400, 'invalid ' + reason);
    assert.ok(!denied.headers.getSetCookie().some(c => c.startsWith('__Host-holdem-session=')));
  }
  const a = await login('~zod'), b = await login('~divmes-davset-samhec-fasnem');
  const join = { op: 'join', token: spectator, name: 'wrong-name', ship: '~mar' };
  assert.equal((await post('/poker/api', a, JSON.stringify(join), 'https://elsewhere.example')).status, 403);
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
