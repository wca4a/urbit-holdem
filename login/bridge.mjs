// Runs behind Tlon's hosting ingress, on the same origin as Horizon.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const nonce = () => randomBytes(32).toString('base64url');
const validNonce = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const validUser = /^use-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cookiePath = '/v1/holdem-auth';
const hash = value => createHash('sha256').update(value).digest();

function origin(value) {
  const url = new URL(value);
  if (url.origin !== value || !(url.protocol === 'https:' ||
    (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Set an HTTPS origin (HTTP is allowed on loopback).');
  }
  return url.origin;
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readBody(req, type) {
  if (req.headers['content-type']?.split(';')[0].trim() !== type)
    throw new RequestError(415, 'Unsupported content type.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw new RequestError(413, 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Forward only the hosting cookie to a fixed operator-supplied Solaris origin.
function sessionCookie(header = '') {
  const cookies = header.split(';').map(s => s.trim()).filter(s => s.startsWith('SolarisSession='));
  return cookies.length === 1 && cookies[0].length > 'SolarisSession='.length ? cookies[0] : null;
}

const escape = value => value.replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

function page(res, status, body, script = '') {
  const key = nonce();
  res.setHeader('Content-Security-Policy', res.getHeader('Content-Security-Policy') + "; script-src 'nonce-" + key + "'");
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Hold’em</title><main><h1>Sign in to Hold’em</h1>' +
    body + '</main>' + (script ? '<script nonce="' + key + '">' + script + '</script>' : '') + '</html>');
}

export function createBridge({ gameOrigin, bridgeOrigin, solarisOrigin = bridgeOrigin, secret, fetchImpl = fetch, now = Date.now }) {
  gameOrigin = origin(gameOrigin);
  bridgeOrigin = origin(bridgeOrigin);
  solarisOrigin = origin(solarisOrigin);
  if ([bridgeOrigin, solarisOrigin].some(o => new URL(o).hostname === new URL(gameOrigin).hostname) || typeof secret !== 'string' || secret.length < 32)
    throw new Error('Use separate hosting and game hostnames and a random BRIDGE_SECRET of at least 32 characters.');
  const codes = new Map();
  const signIn = '<p><a href="/login" target="_blank" rel="noopener noreferrer">Sign in to Tlon Hosting</a> in a new tab. Finish signing in, then return here.</p>';

  function startPage(res, state) {
    page(res, 200, signIn +
      '<form method="post" action="' + cookiePath + '/ships"><input type="hidden" name="state" value="' + state +
      '"><input type="hidden" name="user"><button>Continue with my hosting account</button></form>',
      `const form = document.querySelector('form');
       function selectUser() { form.elements.user.value = localStorage.getItem('X-SESSION-ID') || ''; }
       form.onsubmit = selectUser;
       selectUser(); if (form.elements.user.value) form.submit();`);
  }

  async function ownedShips(req, user) {
    const cookie = sessionCookie(req.headers.cookie);
    if (!cookie || !validUser.test(user)) return null;
    const path = solarisOrigin + '/v1/users/' + user;
    const options = { headers: { Cookie: cookie, Accept: 'application/json' }, redirect: 'error' };
    // GET /users/<id> permits admin reads of other profiles. The pending-lures
    // read is strictly current-user-only and refuses MFA-pending sessions.
    // Check its authorization status without consuming invite data.
    const gate = await fetchImpl(path + '/pending-lures', { ...options, method: 'HEAD', signal: AbortSignal.timeout(8000) });
    await gate.body?.cancel();
    if ([401, 403, 404].includes(gate.status)) return null;
    if (gate.status !== 200 || gate.headers.get('content-type')?.split(';')[0] !== 'application/json')
      throw new Error('Unexpected Solaris response');
    const profile = await fetchImpl(path, { ...options, signal: AbortSignal.timeout(8000) });
    if ([401, 403, 404].includes(profile.status)) return null;
    if (profile.status !== 200) throw new Error('Solaris unavailable');
    const account = await profile.json();
    if (account.id !== user || account.deletedAt || account.blockedReason || !Array.isArray(account.ships)) return null;
    return account.ships.filter(s => typeof s === 'string' && /^~?[a-z]+(?:-{1,2}[a-z]+)*$/.test(s) && s.length <= 64)
      .map(s => s.startsWith('~') ? s : '~' + s);
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' " + gameOrigin);
    try {
      const url = new URL(req.url, bridgeOrigin);
      if (req.method === 'GET' && url.pathname === '/holdem-auth/authorize') {
        const state = url.searchParams.get('state');
        if (!validNonce(state)) throw new RequestError(400, 'Invalid login state.');
        return startPage(res, state);
      }
      if (req.method === 'POST' && [cookiePath + '/ships', cookiePath + '/consent'].includes(url.pathname)) {
        if (req.headers.origin !== bridgeOrigin) throw new RequestError(403, 'Open this form on Tlon Hosting.');
        const data = new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'));
        const state = data.get('state');
        const user = data.get('user');
        if (!validNonce(state)) throw new RequestError(400, 'Invalid login state.');
        const ships = await ownedShips(req, user);
        if (!ships) return page(res, 401, signIn + '<p><a href="/holdem-auth/authorize?state=' + state + '">Continue after signing in</a></p>');
        if (!ships.length) return page(res, 403, '<p>Your hosting account has no ships available to play.</p>');
        if (url.pathname.endsWith('/ships')) {
          const options = ships.map(s => '<option>' + escape(s) + '</option>').join('');
          return page(res, 200, '<p>Share your ship name with ' + escape(gameOrigin) + ' to claim your poker seat.</p>' +
            '<form method="post" action="' + cookiePath + '/consent"><input type="hidden" name="state" value="' + state +
            '"><input type="hidden" name="user" value="' + user + '"><label>Ship <select name="ship">' + options +
            '</select></label> <button>Share ship and play</button></form>');
        }
        const ship = data.get('ship');
        if (!ships.includes(ship)) throw new RequestError(403, 'Choose a ship on this account.');
        const ts = now();
        for (const [id, grant] of codes) {
          if (grant.expires > ts) break;
          codes.delete(id);
        }
        if (codes.size >= 10000) throw new RequestError(503, 'Try again shortly.');
        const code = nonce();
        codes.set(code, { state, ship, expires: ts + 60000 });
        const target = new URL('/poker/auth/callback', gameOrigin);
        target.search = new URLSearchParams({ code, state });
        res.writeHead(303, { Location: target.href });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/holdem-auth/redeem') {
        if (!timingSafeEqual(hash(req.headers.authorization || ''), hash('Bearer ' + secret)))
          throw new RequestError(401, 'Invalid client.');
        const body = await readBody(req, 'application/json');
        let params;
        try { params = JSON.parse(body); } catch { throw new RequestError(400, 'Invalid request.'); }
        const grant = codes.get(params?.code);
        if (!grant || grant.expires <= now() || grant.state !== params.state)
          throw new RequestError(400, 'Invalid or expired login.');
        codes.delete(params.code);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ship: grant.ship }));
      }
      throw new RequestError(404, 'Not found.');
    } catch (err) {
      res.writeHead(err instanceof RequestError ? err.status : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err instanceof RequestError ? err.message : 'Tlon Hosting is temporarily unavailable.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createBridge({ gameOrigin: process.env.GAME_ORIGIN, bridgeOrigin: process.env.BRIDGE_ORIGIN,
    solarisOrigin: process.env.SOLARIS_ORIGIN, secret: process.env.BRIDGE_SECRET })
    .listen(Number(process.env.BRIDGE_PORT || 7881), '127.0.0.1');
}
