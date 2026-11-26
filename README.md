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
| `ship/poker-oidc.hoon` | Builds the hosting authorization and token requests and verifies the signed ship identity. |
| `ship/poker-web.hoon` | Reads the dealer session cookie and binds moves and private views to the player's seat. |
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

The agent keeps lines 2 and 3 in a map keyed by token. At a signed-in table
the dealer picks the token from the player's session and returns that player's
view. Standalone guest tabs supply their own tokens. Polling does not run Wasm, so idle players cost
nothing in the engine.

Rules covered: up to 8 seats, blinds of 5 and 10, 1,000 starting chips, minimum
raises, all-ins, side pots, split pots with odd chips, joining and leaving
mid-hand, buying back in.

## Sign in to a dealer ship with Tlon

Open `https://<dealer-host>/poker`. The dealer ship's Eyre endpoint serves the
page, receives game actions and returns each player's view. **Sign in with
Tlon to play** opens the hosting site. Complete the usual hosting login if
needed, select an owned ship, and approve the return to this dealer. The
dealer handles `/poker/auth/callback`, exchanges the code through Iris, and
checks the signed ID token before creating a table session. The hosting OTP
and ship access code stay at Hosting. Spectators can watch without a login.

### Set up one staging table

1. Install the desk under **Host a table**. Choose a dedicated dealer
   with a stable, publicly accessible HTTPS origin. The player can use any
   ship listed on their staging Hosting account.
2. Have the staging Hosting operator enable the issuer at
   `https://test.tlon.systems/v1/oidc` and register a confidential client
   for this dealer. Register **exactly**
   `https://<dealer-host>/poker/auth/callback`. Use authorization code flow,
   PKCE S256, the `openid ship` scopes and `client_secret_basic`. Give the
   dealer operator the registered client ID and secret privately.
3. With an empty table, enable sign-in in the dealer's local Dojo. Substitute
   the real values in this command. Use origins without a trailing slash.

   ```hoon
   :poker &noun [%oidc 'https://<dealer-host>' 'https://test.tlon.systems/v1/oidc' '<client-id>' '<client-secret>']
   ```

4. Open the dealer's `/poker` in a signed-out browser and check that it opens
   as a spectator. Choose **Sign in with Tlon to play** and select your
   staging ship at Hosting. Check that the browser returns to the dealer's origin,
   the seat shows the selected ship, and signing out and back in restores
   that ship's seat. A second player should see only their own hole cards.

The dealer talks to the Tlon issuer's fixed `/auth`, `/token` and `/jwks`
paths. The token exchange and signature checks run on the dealer. Each dealer
has its own client registration and table sessions. Keep the registered
secret, Dojo history and pier private. Exclude callback query strings from
HTTP access logs.

An upgrade preserves an existing game. If the previous version required a
gateway key, the upgraded table stays closed until the operator configures
OIDC. To retire an old table and clear its hands and seats deliberately, run
`:poker &noun %reset` in the dealer's Dojo before configuring the issuer.

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

To check the native login helpers on a mounted disposable ship, copy
`test/poker-web-check.hoon` to `<pier>/base/gen/poker-web-check.hoon`. Run
`node test/oidc-verifier.mjs > <pier>/base/gen/test-poker-oidc.hoon` to generate
fresh signed token fixtures. After `|commit %base`, run `+poker-web-check` and
`+test-poker-oidc` in Dojo. To exercise the full HTTP callback and play a hand
with two test identities, configure an empty disposable dealer using the
command at the top of `test/native-login.mjs` and run `node test/native-login.mjs`.

To compare a ship against Node:

```sh
cd test
node mkpoker.mjs 700                                   # writes poker-work.txt
node node-ref.mjs ../poker.wasm poker-work.txt > poker-ref.json
```

Then on the ship run `+replay %poker %poker-work %gent` and compare its
`[length fingerprint]` pairs with `poker-ref.json`. The replay answers the
entropy import with the same fixed value Node uses.

## Host a table

Run this in the host ship's Dojo, substituting the distributing ship's name
for `~publisher`:

```hoon
|install ~publisher %poker
```

Once the desk is installed, open `https://<your-ship-host>/poker`. Share
that URL with players. They can pick nicknames, sit down and play from their
browsers. Each ship that installs the desk runs its own table, with its own
seats, deck and game state. The release targets the Zuse Kelvin recorded
in the distributor's `sys.kelvin` file and needs a runtime with urwasm.

## Build the publishing desk

On a development or distributing ship, stage the app and the packaging
generator on a mounted `%base` desk:

```
ship/poker-web.hoon  ->  <pier>/base/lib/poker-web.hoon
ship/poker-oidc.hoon ->  <pier>/base/lib/poker-oidc.hoon
ship/poker.hoon      ->  <pier>/base/app/poker.hoon
ship/poker-desk.hoon ->  <pier>/base/gen/poker-desk.hoon
poker.wasm           ->  <pier>/base/bench/poker.wasm
ship/poker-ui.html   ->  <pier>/base/bench/poker-ui.html
```

Run `|commit %base` and then `:hood +poker-desk` in Dojo. The generator
assembles a separate `%poker` desk containing the game, the Wasm and
cryptography libraries it imports, and the Clay marks needed by those files.
Its `desk.bill` starts the poker agent when someone installs the desk on
their own ship. The generator also accepts an existing matching
`|new-desk %poker` skeleton and refuses to overwrite divergent files.

Run `|public %poker` on the distributor so other ships can fetch the desk.
Share `|install ~publisher %poker` using the distributor's actual ship name.

For the replay test also copy `ship/replay.hoon` to `<pier>/base/gen/replay.hoon`
and `test/poker-work.txt` to `<pier>/base/bench/poker-work.txt`.

## Known limits

- No turn timer: if a player walks away mid-hand, the table waits for them.
- Browsers poll about twice a second; there is no live push.
- In standalone mode the page is served without login. Fine on a local test ship; think before
  putting it on a ship that matters.
- The guest game has also been played in two browsers on a Tlon-hosted staging ship.

## Two notes on the runtime

- `engine/.cargo/config.toml` links with `--growable-table`. Without it, this
  program's function table has a maximum of 102, and urbit/wasm3 rejects it as
  malformed (it reads the table maximum as a signed number). Fix proposed in
  urbit/wasm3 pull request 5.
- It runs on the runtime as it stands; nothing here needs a patched vere. A
  move costs about 6 to 7 ms of Wasm work there and a deal about 20 to 25 ms.
  With the patches on the `urwasm-fast-clean` branch of wca4a/vere, that is
  about 3.5 ms and 7 ms.
