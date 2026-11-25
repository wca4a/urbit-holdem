# Hold'em on urwasm

A multiplayer Texas hold'em table where the dealer is a Rust program compiled to
Wasm, running inside an Urbit ship through urwasm (`run:wasm` in `lib/wasm/lia`).
Players are browser tabs talking to the ship over HTTP. Play chips only.

The ship is the referee. It holds the deck, the chips and the rules, shuffles
with its own entropy, and sends each browser only that player's two cards.

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

## How it works

The engine has three exports: `request(len)` reserves a buffer, the host writes a
JSON request into it, `handle(len)` runs it, and `response()` says where the
reply is. It imports one function, `env.ship_entropy`, which it calls twice per
deal to seed the shuffle. In urwasm that import blocks: the run stops, the agent
answers from `eny.bowl`, and the run resumes.

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

## Build and test

```sh
cd engine
cargo test --release                                   # rules, natively
cargo build --release --target wasm32-unknown-unknown  # the Wasm program
cp target/wasm32-unknown-unknown/release/poker.wasm ../poker.wasm
```

The native tests check hand ranking, pot splitting, and 20,000 random hands with
players coming and going: chips are always conserved, the game never gets stuck,
and no player's view contains another player's cards.

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
- The page is served without login. Fine on a local test ship; think before
  putting it on a ship that matters.
- Tested on a local fake ship only.

## Two notes on the runtime

- `engine/.cargo/config.toml` links with `--growable-table`. Without it, this
  program's function table has a maximum of 102, and urbit/wasm3 rejects it as
  malformed (it reads the table maximum as a signed number). Fix proposed in
  urbit/wasm3 pull request 5.
- On the runtime as it stands, a move costs about 5 ms of Wasm work and a deal
  about 11 ms. With the patches on the `urwasm-fast-clean` branch of
  wca4a/vere, that is about 3 ms and 4 ms.
