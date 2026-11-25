#!/usr/bin/env python3
"""poker-seat.py TOKENFILE [act ACTION [AMOUNT] | join NAME | wait]
A seat at the ship's hold'em table for a player who is not a browser.
  join NAME   sit down
  act ...     fold / check / call / raise AMOUNT
  wait        watch the table (dealing the next hand when one ends, buying back in when broke)
              and return as soon as it is this player's turn, printing only what this player may see.
It only ever asks the ship for this token's own view."""
import json, sys, time, urllib.request
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
