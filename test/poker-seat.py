#!/usr/bin/env python3
"""poker-seat.py TOKENFILE [act ACTION [AMOUNT] | join NAME | wait]
A seat at the ship's hold'em table for a player who is not a browser.
  join NAME   sit down
  act ...     fold / check / call / raise AMOUNT
  wait        watch the table (dealing the next hand when one ends, buying back in when broke)
              and return as soon as it is this player's turn, printing only what this player may see.
It only ever asks the ship for this token's own view."""
import hashlib, json, os, secrets, sys, time, urllib.request
URL = 'http://localhost/poker/'
token = open(sys.argv[1]).read().strip()
def post(path, body):
    with urllib.request.urlopen(urllib.request.Request(URL + path, data=body.encode()), timeout=30) as r: return json.load(r)
def api(**req): return post('api', json.dumps(dict(req, token=token)))
def show(v):
    me = v['seats'][v['you']]
    print(f"hand {v['hand']} {v['stage']} | board: {' '.join(v['board']) or '-'} | my cards: {' '.join(me['cards']) or '-'} | pot {v['pot']} | my chips {me['chips']} (bet {me['bet']})")
    for i, s in enumerate(v['seats']):
        if s and i != v['you']: print(f"  {s['name']}: chips {s['chips']}, bet {s['bet']}{', folded' if s['folded'] else ''}{', all in' if s['all_in'] else ''}{', button' if v['button'] == i else ''}{' cards ' + ' '.join(s['cards']) if s['cards'] and s['cards'][0] != '??' else ''}")
    if v['button'] == v['you']: print('  I have the button')
    if v['actions']: a = v['actions']; print(f"  my options: {'check' if a['can_check'] else 'call ' + str(a['call'])}, fold" + (f", raise to {a['min_raise_to']}..{a['max_raise_to']}" if a['can_raise'] else ''))
    print('  log: ' + ' / '.join(v['log'][-9:]))
# ---- the sealed deck: this seat's own record of each hand, and its own check of the proof.
# a third implementation of the recipe (the engine is Rust, the page is JavaScript).
BOOK = sys.argv[1] + '.hands'
book = json.load(open(BOOK)) if os.path.exists(BOOK) else {}
def note(hand): return book.setdefault(str(hand), dict(commit=None, seed=None, seat=None, cards=None, board=[]))
def deck_of(secret, hand, seeds):
    h = hashlib.sha256(b'holdem-deck-v1' + bytes.fromhex(secret) + hand.to_bytes(4, 'little'))
    for sd in seeds: b = bytes.fromhex(sd); h.update(bytes([len(b)]) + b)
    key, counter, ready, deck, top = h.digest(), 0, [], list(range(52)), 2 ** 64 - 1
    for k in range(51, 0, -1):
        n = k + 1; limit = top - top % n
        while True:
            if not ready:
                blk = hashlib.sha256(key + counter.to_bytes(4, 'little')).digest(); counter += 1
                ready = [int.from_bytes(blk[8 * i:8 * i + 8], 'little') for i in range(4)]
            x = ready.pop(0)
            if x < limit: break
        deck[k], deck[x % n] = deck[x % n], deck[k]
    return ['23456789TJQKA'[c >> 2] + 'cdhs'[c & 3] for c in deck]
def check(proof):
    m = note(proof['hand']); bad = []
    if hashlib.sha256(b'holdem-commit-v1' + bytes.fromhex(proof['secret'])).hexdigest() != proof['commit']: bad.append('secret does not match fingerprint')
    if m['commit'] and m['commit'] != proof['commit']: bad.append('fingerprint is not the one shown before the deal')
    if m['seed'] and proof['seeds'][m['seat']] != m['seed']: bad.append('my number was not used')
    deck = deck_of(proof['secret'], proof['hand'], proof['seeds'])
    if deck != proof['deck']: bad.append('recipe does not give the published deck')
    d = deck[:]; hands = {seat: [d.pop(), d.pop()] for seat in proof['dealt']}; board = [d.pop() for _ in range(5)]
    if m['cards'] and hands.get(m['seat']) != m['cards']: bad.append('my cards did not come from that deck')
    if m['board'] and board[:len(m['board'])] != m['board']: bad.append('the board did not come from that deck')
    return bad
def keep(v):
    """record what this seat can see for itself; add a number to the next deck; check a finished hand"""
    n = v['next']
    if n['commit']:
        m = note(n['hand'])
        if m['commit'] is None: m['commit'] = n['commit']
        if m['seed'] is None and not n['seeded'][v['you']]:
            m['seed'], m['seat'] = secrets.token_hex(16), v['you']; api(op='seed', seed=m['seed'])
    if v['stage'] != 'idle':
        m = note(v['hand']); me = v['seats'][v['you']]
        if len(me['cards']) == 2: m['cards'], m['seat'] = me['cards'], v['you']
        if len(v['board']) >= len(m['board']): m['board'] = v['board']
    if v['proof'] and not note(v['proof']['hand']).get('checked'):
        bad = check(v['proof']); note(v['proof']['hand'])['checked'] = True
        print('hand %d deal checked: %s' % (v['proof']['hand'], 'fair' if not bad else 'PROBLEM: ' + '; '.join(bad)), flush=True)
    json.dump(book, open(BOOK, 'w'))

cmd = sys.argv[2] if len(sys.argv) > 2 else 'wait'
if cmd == 'join': print(api(op='join', name=sys.argv[3])); sys.exit()
if cmd == 'act':
    req = dict(op='act', action=sys.argv[3])
    if len(sys.argv) > 4: req['amount'] = int(sys.argv[4])
    print(api(**req))
    sys.exit()
idle_since, last_hand, started = None, None, time.time()
while time.time() - started < 1500:
    v = post('poll', token)['view']
    if not v or v['you'] is None: print('I am not seated'); sys.exit()
    me = v['seats'][v['you']]
    others = [s for i, s in enumerate(v['seats']) if s and i != v['you']]
    keep(v)
    if v['actions']: show(v); sys.exit()
    if v['stage'] == 'idle':
        if me['busted']: api(op='rebuy'); print('NOTE: I went broke and bought back in'); continue
        if v['hand'] != last_hand and v['hand']: last_hand = v['hand']; print('hand %d over: %s' % (v['hand'], '; '.join(f"{' and '.join(r['winners'])} won {r['amount']}{' with ' + r['hand'].lower() if r['hand'] else ''}" for r in v['results'])), flush=True)
        if v['can_deal'] and others:
            idle_since = idle_since or time.time()
            if time.time() - idle_since > 6: api(op='deal'); idle_since = None   # give people a moment to see the result
        else: idle_since = None
    time.sleep(1)
print('nothing happened for 25 minutes')
