import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createBridge } from '../login/bridge.mjs';

const gameOrigin = 'https://poker.example';
const bridgeOrigin = 'https://hosting.example';
const secret = 'b'.repeat(48);
const user = 'use-00000000-0000-0000-0000-000000000001';
const anotherUser = 'use-00000000-0000-0000-0000-000000000002';
const state = 'a'.repeat(43);

async function fixture(t) {
  let ts = 10000;
  let mfaPending = false;
  let ships = ['zod', 'sampel-palnet'];
  const calls = [];
  const server = createBridge({ gameOrigin, bridgeOrigin, secret, now: () => ts,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Cookie, 'SolarisSession=local-test-only');
      assert.equal(options.redirect, 'error');
      const suffix = url.slice(bridgeOrigin.length);
      if (suffix.endsWith('/pending-lures')) {
        assert.equal(options.method, 'HEAD');
        return new Response(null, { headers: { 'Content-Type': 'application/json' },
          status: suffix === '/v1/users/' + user + '/pending-lures' && !mfaPending ? 200 : 403 });
      }
      assert.equal(suffix, '/v1/users/' + user);
      return Response.json({ id: user, ships, email: 'unused@example.test' });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const form = (path, extra, headers) => fetch(base + '/v1/holdem-auth/' + path, {
    method: 'POST', body: new URLSearchParams({ user, state, ...extra }), redirect: 'manual',
    headers: { origin: bridgeOrigin, cookie: 'irrelevant=unused; SolarisSession=local-test-only', ...headers },
  });
  const redeem = (payload, key = secret) => fetch(base + '/holdem-auth/redeem', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const grant = async () => {
    const res = await form('consent', { ship: '~zod' });
    assert.equal(res.status, 303);
    const redirect = new URL(res.headers.get('location'));
    assert.equal(redirect.origin + redirect.pathname, gameOrigin + '/poker/auth/callback');
    assert.equal(redirect.searchParams.get('state'), state);
    return redirect.searchParams.get('code');
  };
  return { base, calls, form, redeem, grant, expire: () => ts += 61000,
    requireMfa: () => { mfaPending = true; }, removeShip: () => { ships = []; } };
}

test('Tlon hosts the consent page and exchanges a code for only the chosen ship', async t => {
  const { base, form, redeem, grant } = await fixture(t);
  const start = await fetch(base + '/holdem-auth/authorize?state=' + state);
  assert.equal(start.status, 200);
  assert.match(await start.text(), /X-SESSION-ID/);
  const picker = await form('ships');
  assert.equal(picker.status, 200);
  assert.match(await picker.text(), /~sampel-palnet/);
  const code = await grant();
  assert.equal((await redeem({ state, code }, 'invalid')).status, 401);
  assert.equal((await redeem({ state: 'b'.repeat(43), code })).status, 400);
  const results = await Promise.all([redeem({ state, code }), redeem({ state, code })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  assert.deepEqual(await results.find(r => r.ok).json(), { ship: '~zod' });
});

test('consent requires same-origin submission, a current-user session and completed MFA', async t => {
  const { calls, form, requireMfa } = await fixture(t);
  assert.equal((await form('consent', { ship: '~zod' }, { origin: gameOrigin })).status, 403);
  assert.equal((await form('ships', {}, { cookie: 'other=unused' })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await form('consent', { ship: '~zod', user: anotherUser })).status, 401);
  requireMfa();
  assert.equal((await form('consent', { ship: '~zod' })).status, 401);
  assert.ok(calls.every(url => url.endsWith('/pending-lures')));
});

test('redeem expires and ownership is rechecked before issuing every code', async t => {
  const { form, redeem, grant, expire, removeShip } = await fixture(t);
  const code = await grant();
  expire();
  assert.equal((await redeem({ code, state })).status, 400);
  assert.equal((await form('consent', { ship: '~nec' })).status, 403);
  assert.equal((await form('ships')).status, 200);
  removeShip();
  assert.equal((await form('consent', { ship: '~zod' })).status, 403);
});
