// Run only against an empty disposable dealer on this machine (Node 22+).
// In its Dojo:
//   :poker &noun [%oidc 'http://localhost:34721' 'http://127.0.0.1:34725/v1/oidc' 'holdem' 'holdem-native-local-disposable-key']
// Then run: node test/native-login.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';

const dealer = 'http://localhost:34721';
const issuer = 'http://127.0.0.1:34725/v1/oidc';
const client = 'holdem';
const secret = 'holdem-native-local-disposable-key';
const callback = dealer + '/poker/auth/callback';
const codes = new Map();
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-rsa', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let holdNextKeys = false;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, issuer);
  if (req.method === 'GET' && url.href === issuer + '/jwks') {
    if (holdNextKeys) {
      holdNextKeys = false;
      server.emit('waiting-for-keys', res);
      return;
    }
    return res.end(JSON.stringify({ keys: [jwk] }));
  }
  try {
    assert.equal(req.method, 'POST'); assert.equal(url.href, issuer + '/token');
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from(client + ':' + secret).toString('base64'));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(params.get('grant_type'), 'authorization_code'); assert.equal(params.get('redirect_uri'), callback);
    const grant = codes.get(params.get('code'));
    assert.ok(grant, 'unknown or used code');
    codes.delete(params.get('code'));
    assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), grant.challenge);
    const iat = Math.floor(Date.now() / 1000);
    const claims = { sub: grant.ship, ship: grant.ship, iss: issuer, aud: client, iat, exp: iat + 300, nonce: grant.nonce };
    const payload = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode(claims);
    const signature = sign('RSA-SHA256', Buffer.from(grant.valid ? payload : 'invalid'), privateKey);
    res.end(JSON.stringify({ token_type: 'Bearer', access_token: randomUUID(), id_token: payload + '.' + signature.toString('base64url') }));
  } catch (error) {
    console.error('Test issuer rejected request:', error.message);
    res.statusCode = 400; res.end('{"error":"invalid_grant"}');
  }
});
function request(path, cookie = '', method = 'GET', body, origin = dealer) {
  return fetch(dealer + path, { method, body, headers: { cookie, origin }, redirect: 'manual', signal: AbortSignal.timeout(35000) });
}
async function beginLogin(ship, valid) {
  const start = await request('/poker/auth/start');
  assert.equal(start.status, 303, 'configure the disposable dealer with the test issuer first');
  const target = new URL(start.headers.get('location')), p = target.searchParams;
  assert.equal(target.origin + target.pathname, issuer + '/auth');
  assert.equal(p.get('client_id'), client); assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), 'openid ship'); assert.equal(p.get('redirect_uri'), callback);
  assert.equal(p.get('code_challenge_method'), 'S256'); assert.ok(p.get('nonce'));
  const state = p.get('state'), code = randomUUID();
  const stateCookie = start.headers.getSetCookie().find(c => c.startsWith('poker-state=')).split(';')[0];
  codes.set(code, { ship, valid, challenge: p.get('code_challenge'), nonce: p.get('nonce') });
  const path = '/poker/auth/callback?' + new URLSearchParams({ state, code, iss: issuer });
  assert.equal((await request(path)).status, 400, 'requires the original browser state cookie');
  return { path, stateCookie, code };
}
async function login(ship, valid = true) {
  const { path, stateCookie } = await beginLogin(ship, valid);
  const result = await request(path, stateCookie);
  assert.equal(result.status, valid ? 303 : 400);
  assert.equal((await request(path, stateCookie)).status, 400, 'cannot replay callback');
  if (!valid) return;
  const session = result.headers.getSetCookie().find(c => c.startsWith('poker-session='));
  assert.match(session, /HttpOnly/i);
  const cookie = session.split(';')[0];
  assert.deepEqual(await (await request('/poker/auth/session', cookie)).json(), { ship });
  return cookie;
}
async function cancelWhileLoadingKeys() {
  const { path, stateCookie, code } = await beginLogin('~zod', true);
  holdNextKeys = true;
  const waiting = once(server, 'waiting-for-keys', { signal: AbortSignal.timeout(5000) });
  const callbackResponse = fetch(dealer + path, {
    redirect: 'manual', headers: { cookie: stateCookie }, signal: AbortSignal.timeout(8000),
  });
  const [keys] = await Promise.race([waiting, callbackResponse.then(() => {
    throw new Error('callback completed before requesting test keys');
  })]);
  try {
    const logout = await request('/poker/auth/logout', stateCookie, 'POST', '');
    assert.equal(logout.status, 200);
    const result = await callbackResponse;
    assert.equal(result.status, 400, 'logout promptly closes the outstanding callback');
    assert.ok(!result.headers.getSetCookie().some(c => c.startsWith('poker-session=')));
  } finally {
    keys.end(JSON.stringify({ keys: [jwk] }));
  }
  assert.equal((await request(path, stateCookie)).status, 400);
  assert.ok(codes.has(code), 'the cancelled login did not redeem its code');
}
const poll = async cookie => (await request('/poker/poll', cookie, 'POST', '')).json();
async function move(cookie, action) {
  const response = await request('/poker/api', cookie, 'POST', JSON.stringify(action));
  assert.equal(response.status, 200);
  const answer = await response.json(); assert.equal(answer.ok, true, answer.error);
}
const players = [];
try {
  server.listen(34725, '127.0.0.1'); await once(server, 'listening');
  const guest = await poll('');
  assert.equal(guest.ship, null);
  assert.ok(!guest.view?.seats.some(Boolean), 'requires an empty test table');
  assert.equal((await request('/poker/api', '', 'POST', '{"op":"join"}')).status, 401);
  await login('~zod', false);
  for (const ship of ['~zod', '~sampel-palnet']) {
    const cookie = await login(ship);
    assert.equal((await request('/poker/api', cookie, 'POST', '{"op":"join"}', 'https://elsewhere.example')).status, 403);
    await move(cookie, { op: 'join', name: 'ignored', token: '0'.repeat(32) });
    players.push(cookie);
  }
  await move(players[0], { op: 'deal' });
  const [a, b, spectator] = await Promise.all([...players, ''].map(poll));
  assert.deepEqual([a.view.you, b.view.you, spectator.view.you], [0, 1, null]);
  assert.deepEqual(a.view.seats.slice(0, 2).map(s => s.name), ['~zod', '~sampel-palnet']);
  for (const player of [a, b]) {
    const i = player.view.you, cards = player.view.seats[i].cards;
    assert.equal(cards.length, 2); assert.ok(cards.every(c => /^[2-9TJQKA][cdhs]$/.test(c)));
    assert.deepEqual(player.view.seats[1 - i].cards, ['??', '??']);
    assert.deepEqual(spectator.view.seats[i].cards, ['??', '??']);
  }
  assert.equal((await request('/poker/auth/logout', players[0], 'POST', '')).status, 200);
  assert.equal((await poll(players[0])).view.you, null);
  players[0] = await login('~zod');
  assert.deepEqual((await poll(players[0])).view.seats[0].cards, a.view.seats[0].cards);
  await move(players[a.view.actions ? 0 : 1], { op: 'act', action: 'fold' });
  await cancelWhileLoadingKeys();
  console.log('Passed native Eyre login, Iris token exchange, PKCE, signed identity, play, private cards, logout, seat recovery and cancellation during JWKS retrieval.');
} finally {
  for (const cookie of players) {
    await request('/poker/api', cookie, 'POST', '{"op":"leave"}');
    await request('/poker/auth/logout', cookie, 'POST', '');
  }
  server.close();
}
