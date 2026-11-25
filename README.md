# Hold'em on urwasm

A multiplayer Texas hold'em table where the dealer is a Rust program compiled to
Wasm, running inside an Urbit ship through urwasm (`run:wasm` in `lib/wasm/lia`).
Players are browser tabs talking to the ship over HTTP. Play chips only.

The ship is the referee. It holds the deck, the chips and the rules, and sends
each browser only that player's two cards. Every deck is sealed before the deal
and opened after the hand, so each player's browser can check for itself that
the ship did not pick or change the cards.

## What is here

| Path | What it is |
|---|---|
| `engine/` | The game: rules, hand ranking, pots, per-player views. Rust, depends only on serde and serde_json. |
| `poker.wasm` | A prebuilt copy of the engine (about 300 KB). |
| `ship/poker.hoon` | Gall agent: serves the page, runs the engine in urwasm, keeps each player's view. |
| `ship/poker-ui.html` | The table page. One plain HTML file, no build step. |
| `ship/replay.hoon` | Generator that feeds a file of recorded requests to the engine on a ship, for testing. |
| `test/mkpoker.mjs` | Bots play against the engine in Node and record every request they make. |
| `test/node-ref.mjs` | Replays recorded requests in Node and fingerprints each reply, to compare with a ship. |
| `test/verify.mjs` | Runs the page's own checking code against hundreds of bot hands, then against tampered proofs. |
| `test/poker-seat.py` | A seat for a player that is not a browser (a script, or an AI): join, act, and wait for your turn. It only asks the ship for its own token's view. |

## How it works

The engine has three exports: `request(len)` reserves a buffer, the host writes a
JSON request into it, `handle(len)` runs it, and `response()` says where the
reply is. It imports one function, `env.ship_entropy`, which it calls four times
per deal for the secret half of the next shuffle. In urwasm that import blocks:
the run stops, the agent answers from `eny.bowl`, and the run resumes.

Every reply is a few lines of text:

1. the answer to whoever sent the request
2. one line per seated player: their 32-character secret token, then the table as that player may see it
3. one line for spectators

The agent keeps lines 2 and 3 in a map keyed by token. A browser polls with its
token and gets its own line. Polling does not run Wasm, so idle players cost
nothing in the engine.

Rules covered: up to 8 seats, blinds of 5 and 10, 1,000 starting chips, minimum
raises, all-ins, side pots, split pots with odd chips, joining and leaving
mid-hand, buying back in.

## Play on a website with a Tlon ship

The optional website gateway lets spectators watch and Tlon Hosting users sit as
a ship they own. **Sign in with Tlon to play** opens the hosting site. If needed,
the player completes the usual OTP and MFA flow in another tab, returns to the
consent screen, chooses a ship, and comes back to the table. Signing in again as
the same ship recovers its seat and chips while the dealer keeps that seat.

This integration includes a small service that **Tlon must mount on its hosting
origin**. A standalone deployment of the poker website cannot use Tlon's existing
login page as an identity callback. The game receives a one-time code and a ship
name. The OTP, hosting cookie, account profile and ship access code stay outside
the game. The poker seat token stays between the website gateway and the dealer.

### Run the hosted table

Use Node 22 or newer. Both services use Node built-ins. Configure three
independent secrets (for example, generate each with `openssl rand -hex 32`)
in the service environment.

| Setting | Where | Value |
| --- | --- | --- |
| `GAME_ORIGIN` | Both services | Public HTTPS origin of the poker website, on a separate hostname from Tlon Hosting |
| `BRIDGE_ORIGIN` | Both services | Horizon's HTTPS origin, where the player ordinarily signs in |
| `BRIDGE_SECRET` | Both services | Shared secret for redeeming one-time codes |
| `SOLARIS_ORIGIN` | Bridge | Optional trusted Solaris API origin, defaults to `BRIDGE_ORIGIN` |
| `DEALER_ORIGIN` | Gateway | Dedicated ship origin (HTTPS, or HTTP on loopback) |
| `DEALER_KEY` | Gateway | Random secret whose SHA-256 digest is configured on the ship |
| `SEAT_SECRET` | Gateway | Stable secret used to derive a separate private seat token for each ship |

1. Install the agent, engine and page as described in **Run it on a ship**. Start
   with an empty table. At the local Dojo, configure the dealer with
   `:poker &noun [%gateway-key (shax 'YOUR-DEALER-KEY')]`. Use a hex key as above.
   This locks the dealer's page, API, polling and reset routes to the gateway.
2. On the Tlon side run `node login/bridge.mjs` behind the **same browser origin
   as Horizon**. Route `/holdem-auth/authorize`, `/holdem-auth/redeem`,
   `/v1/holdem-auth/ships` and `/v1/holdem-auth/consent` to its loopback
   listener (`BRIDGE_PORT`, default 7881). Preserve the existing Horizon
   `/login` and Solaris `/v1` routes. The two form routes live under `/v1` to
   receive the hosting cookie. The bridge checks the current-user/MFA guard on
   `/v1/users/<id>/pending-lures` with HEAD, then reads the owned ship list
   from the account. It repeats those checks when the player confirms.
3. Run `node login/gateway.mjs` behind the game website's HTTPS proxy and route
   the game origin to its loopback listener (`PORT`, default 3000). Open
   `/poker`. The gateway requires the protected-dealer response before opening
   play. It exposes no table reset operation.
4. Use one instance of each Node service. Login state, one-minute exchange codes
   and twelve-hour website sessions live in memory. After a restart, signing
   in again recovers a seat if the gateway kept its `SEAT_SECRET`. Keep login
   query strings and authentication headers out of reverse-proxy logs.

Test the gateway and identity exchange locally with
`node --test test/bridge.test.mjs test/gateway.test.mjs`. The tests run the
real services and Wasm engine with simulated Solaris responses. A live OTP
smoke test requires the hosting-side routes and a test hosting account.

## The sealed deck

The worry with any online card game is that the house stacks the deck. Here it
cannot, and each player can check that without trusting the ship.

1. **Seal.** Before a hand, the engine picks a 32-byte secret (from the ship's
   entropy) and publishes only its SHA-256 fingerprint.
2. **Everyone adds a number.** Each player's browser sends 16 random bytes of
   its own. The secret was fixed before these existed, so the ship cannot choose
   it to suit them; the players never see the secret in time, so they cannot
   steer the deck either.
3. **Deal.** The deck order is computed from the secret, the players' numbers
   and the hand number by a public recipe (`shuffled_deck` in the engine: a
   SHA-256 keyed stream driving a shuffle with no modulo bias).
4. **Open.** When the hand is over, the engine publishes the secret, the
   numbers and the full deck. Each browser checks that the secret matches the
   fingerprint it saw before the deal, that its own number was used, that the
   recipe gives exactly that deck, and that its cards and the board came from it.

The recipe is implemented three times, independently: in Rust (the engine), in
JavaScript with its own SHA-256 (the page, so it also works where browsers
withhold their built-in crypto, such as plain HTTP on a local network), and in
Python (`test/poker-seat.py`). They agree on every hand tested.

What this does not do:

- **The ship can still see the cards.** Sealing proves the deck was not chosen
  or changed; it does not hide it from whoever runs the ship. Removing that
  needs a dealerless protocol (mental poker), which this is not.
- **A player colluding with the ship** could send their number last, after the
  ship has tried many candidates for it. Having players seal their numbers too
  would close that; it is not done here.
- A browser that was not watching before a deal cannot check the timing of that
  hand, and says so.

## Build and test

```sh
cd engine
cargo test --release                                   # rules, natively
cargo build --release --target wasm32-unknown-unknown  # the Wasm program
cp target/wasm32-unknown-unknown/release/poker.wasm ../poker.wasm
```

The native tests check hand ranking, pot splitting, the sealed deck (the
fingerprint never moves, the secret never shows during a hand, the cards dealt
are the cards in the opened deck), and 20,000 random hands with players coming
and going: chips are always conserved, the game never gets stuck, and no
player's view contains another player's cards.

```sh
cd test
node verify.mjs 300      # the page's checker against 300 bot hands, then against six kinds of tampering
```

To compare a ship against Node:

```sh
cd test
node mkpoker.mjs 700                                   # writes poker-work.txt
node node-ref.mjs ../poker.wasm poker-work.txt > poker-ref.json
```

Then on the ship run `+replay %poker %poker-work %gent` and compare its
`[length fingerprint]` pairs with `poker-ref.json`. The replay answers the
entropy import with the same fixed value Node uses.

## Run it on a ship

With the `%base` desk mounted:

```
ship/poker.hoon      ->  <pier>/base/app/poker.hoon
poker.wasm           ->  <pier>/base/bench/poker.wasm
ship/poker-ui.html   ->  <pier>/base/bench/poker-ui.html
```

Then `|commit %base` and `|start %poker`, and open `http://<ship>/poker`. Each
browser tab is one player (the token lives in the tab's session storage).

For the replay test also copy `ship/replay.hoon` to `<pier>/base/gen/replay.hoon`
and `test/poker-work.txt` to `<pier>/base/bench/poker-work.txt`.

## Known limits

- No turn timer: if a player walks away mid-hand, the table waits for them.
- Browsers poll about twice a second; there is no live push.
- In standalone mode the page is served without login. Fine on a local test ship; think before
  putting it on a ship that matters.
- Tested on a local fake ship only.

## Two notes on the runtime

- `engine/.cargo/config.toml` links with `--growable-table`. Without it, this
  program's function table has a maximum of 102, and urbit/wasm3 rejects it as
  malformed (it reads the table maximum as a signed number). Fix proposed in
  urbit/wasm3 pull request 5.
- It runs on the runtime as it stands; nothing here needs a patched vere. A
  move costs about 6 to 7 ms of Wasm work there and a deal about 20 to 25 ms.
  With the patches on the `urwasm-fast-clean` branch of wca4a/vere, that is
  about 3.5 ms and 7 ms.
