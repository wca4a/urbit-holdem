// Public website for a dealer configured with a gateway key.
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const spectator = '0'.repeat(32);
const nonce = () => randomBytes(32).toString('base64url');
const allowed = new Set(['join', 'leave', 'rebuy', 'deal', 'act', 'seed']);
const defaultPage = readFileSync(new URL('../ship/poker-ui.html', import.meta.url), 'utf8');

function checkedOrigin(value, name) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== value || !(url.protocol === 'https:' || loopback && url.protocol === 'http:')) {
    throw new Error(name + ' must be an origin (HTTPS required outside loopback for public sites)');
  }
  return value;
}

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readAction(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 2048) throw bad(413, 'request too large');
    chunks.push(chunk);
  }
  let action;
  try { action = JSON.parse(Buffer.concat(chunks)); } catch { throw bad(400, 'invalid move'); }
  if (!allowed.has(action?.op)) throw bad(400, 'unknown move');
  return action;
}

export function createGateway({ gameOrigin, bridgeOrigin, dealerOrigin, bridgeSecret, seatSecret, dealerKey, fetchImpl = fetch, now = Date.now }) {
  checkedOrigin(gameOrigin, 'GAME_ORIGIN');
  checkedOrigin(bridgeOrigin, 'BRIDGE_ORIGIN');
  checkedOrigin(dealerOrigin, 'DEALER_ORIGIN');
  const secrets = [bridgeSecret, seatSecret, dealerKey];
  if (gameOrigin === dealerOrigin || bridgeOrigin === dealerOrigin ||
      new URL(gameOrigin).hostname === new URL(bridgeOrigin).hostname ||
      secrets.some(s => !s || s.length < 32) || new Set(secrets).size !== 3) {
    throw new Error('Use separate game and hosting hostnames, a dedicated dealer origin, and three independent secrets of at least 32 characters');
  }
  const secure = gameOrigin.startsWith('https:');
  const prefix = secure ? '__Host-holdem-' : 'holdem-';
  const marker = 'const hostingLogin = false;';
  if (!defaultPage.includes(marker)) throw new Error('Missing hosting login switch in table page');
  const page = defaultPage.replace(marker, 'const hostingLogin = true;');

  const sessions = new Map();
  const activeFlows = new Map();
  function lookup(map, key) {
    const value = map.get(key);
    if (value && value.until > now()) return value;
    map.delete(key);
    return null;
  }
  function store(map, key, data, ttl) {
    if (map.size >= 10000) {
      for (const existing of map.keys()) lookup(map, existing);
      if (map.size >= 10000) throw bad(503, 'please try again later');
    }
    map.set(key, { ...data, until: now() + ttl * 1000 });
  }
  function cookie(name, value, seconds) {
    return prefix + name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + seconds + (secure ? '; Secure' : '');
  }
  async function upstream(url, options, protectedDealer = false) {
    const r = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw bad(502, 'upstream service unavailable');
    if (protectedDealer && r.headers.get('X-Poker-Protected') !== '1') throw bad(503, 'dealer login protection is unavailable');
    return r.json();
  }

  const dealerHeaders = { 'X-Poker-Dealer-Key': dealerKey };
  let dealerCheck;
  async function callDealer(path, body) {
    // Probe before the first move. Older agents accept arbitrary POST paths.
    dealerCheck ??= upstream(dealerOrigin + '/poker/gateway-status', { headers: dealerHeaders }, true)
      .then(status => { if (status.protected !== true) throw bad(503, 'dealer login protection is unavailable'); });
    try {
      await dealerCheck;
      return await upstream(dealerOrigin + path, { method: 'POST', headers: dealerHeaders, body }, true);
    } catch (error) {
      dealerCheck = null;
      throw error;
    }
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    function json(status, data) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    function redirect(location) {
      res.writeHead(303, { Location: location });
      res.end();
    }
    try {
      const url = new URL(req.url, gameOrigin);
      const path = url.pathname;
      const cookies = (req.headers.cookie ?? '').split(/;\s*/);
      const get = name => cookies.find(c => c.startsWith(prefix + name + '='))?.split('=')[1];
      const sessionKey = get('session');
      const ship = lookup(sessions, sessionKey)?.ship ?? null;
      if (req.method === 'GET') {
        if (path === '/') return redirect('/poker');
        if (path === '/poker' || path === '/poker/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(page);
        }
        if (path === '/poker/auth/session') return json(200, { ship });
        if (path === '/poker/auth/start') {
          const state = nonce();
          const ttl = 600;
          activeFlows.delete(get('state'));
          store(activeFlows, state, {}, ttl);
          res.setHeader('Set-Cookie', cookie('state', state, ttl));
          return redirect(bridgeOrigin + '/holdem-auth/authorize?state=' + state);
        }
        if (path === '/poker/auth/callback') {
          const state = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          if (!state || state !== get('state') || !lookup(activeFlows, state) || !code || code.length > 256) {
            throw bad(400, 'login expired or invalid. Return to /poker to sign in again');
          }
          activeFlows.delete(state);
          res.setHeader('Set-Cookie', cookie('state', '', 0));
          const identity = await upstream(bridgeOrigin + '/holdem-auth/redeem', {
            method: 'POST', headers: { Authorization: 'Bearer ' + bridgeSecret, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, code }),
          });
          if (typeof identity?.ship !== 'string' || identity.ship.length > 128 || !/^~(?:[a-z]{3}|[a-z]{6})(?:-{1,2}[a-z]{6})*$/.test(identity.ship)) {
            throw bad(502, 'identity service returned an invalid ship');
          }
          const key = nonce();
          const ttl = 12 * 3600;
          store(sessions, key, { ship: identity.ship }, ttl);
          sessions.delete(sessionKey);
          res.setHeader('Set-Cookie', [cookie('session', key, ttl), cookie('state', '', 0)]);
          return redirect('/poker');
        }
      }
      if (req.method !== 'POST') throw bad(404, 'not found');
      if (req.headers.origin !== gameOrigin) throw bad(403, 'invalid request origin');
      if (path === '/poker/auth/logout') {
        sessions.delete(sessionKey);
        activeFlows.delete(get('state'));
        res.setHeader('Set-Cookie', [cookie('session', '', 0), cookie('state', '', 0)]);
        return json(200, { ok: true });
      }
      const token = ship ? createHmac('sha256', seatSecret).update(ship).digest('hex').slice(0, 32) : spectator;
      if (path === '/poker/poll') {
        const { v, view } = await callDealer(path, token);
        return json(200, { v, view, ship });
      }
      if (path !== '/poker/api') throw bad(404, 'not found');
      if (!ship) throw bad(401, 'sign in to play');
      const { op, action, amount, seed } = await readAction(req);
      const move = { op, token };
      if (op === 'join') move.name = ship;
      if (op === 'act') Object.assign(move, { action, amount });
      if (op === 'seed') move.seed = seed;
      return json(200, await callDealer(path, JSON.stringify(move)));
    } catch (error) {
      if (req.method === 'GET' && req.url.split('?')[0] === '/poker/auth/callback') {
        res.writeHead(error.status ?? 503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Hold’em sign-in</title><p>Could not complete sign-in. <a href="/poker/auth/start">Try again with Tlon</a> or <a href="/poker">return to the table</a>.</p>');
      } else {
        json(error.status ?? 503, { ok: false, error: error.status ? error.message : 'service temporarily unavailable' });
      }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GAME_ORIGIN: gameOrigin, BRIDGE_ORIGIN: bridgeOrigin, DEALER_ORIGIN: dealerOrigin,
    BRIDGE_SECRET: bridgeSecret, SEAT_SECRET: seatSecret, DEALER_KEY: dealerKey, PORT: port = 3000 } = process.env;
  createGateway({ gameOrigin, bridgeOrigin, dealerOrigin, bridgeSecret, seatSecret, dealerKey })
    .listen(Number(port), '127.0.0.1', () => console.log('Hold’em gateway listening on loopback port ' + port));
}
