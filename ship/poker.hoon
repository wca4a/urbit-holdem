::  %poker: a hold'em table (bench/poker.wasm) running in urwasm
::
::    GET  /poker         the web page (bench/poker-ui.html)
::    POST /poker/api     one JSON request (join, deal, act, ...), JSON answer
::    POST /poker/poll    private view for the session (tab token in standalone)
::    POST /poker/disconnect  short reconnect window for a closing guest tab
::    GET  /poker/auth/*  native OIDC sign-in and session lookup
::    POST /poker/auth/logout  end a game session
::    POST /poker/reset   standalone tables only
::
::  the wasm program is the dealer. after every request it produces what
::  each seated player may see, one line per player, and this agent keeps
::  those lines keyed by the player's secret token. a browser only ever
::  gets its own line, so nobody receives anyone else's cards. polling
::  reads the kept lines and does not run wasm.
::
/+  default-agent, wasm-lib=wasm-lia, oidc=poker-oidc, web=poker-web
=/  lv  lia-value:lia-sur:wasm-lib
=/  cw  coin-wasm:wasm-sur:wasm-lib
=/  script  script:lia-sur:wasm-lib
|%
+$  card  card:agent:gall
+$  seed  seed:lia-sur:wasm-lib
+$  state-0  [%0 sed=(unit seed) ver=@ud views=(map @t @t)]
+$  state-1  [%1 sed=(unit seed) ver=@ud views=(map @t @t) key-hash=(unit @)]
::  A callback consumes %ready before making either Iris request.
+$  phase  $?(%ready [%keys eid=@ta code=@t] [%token eid=@ta jwks=@t])
+$  flow  [expires=@da nonce=@t verifier=@t stage=phase]
+$  session  [expires=@da who=@p]
+$  table-state
  $:  sed=(unit seed)
      ver=@ud
      views=(map @t @t)
      closed=_|
      cfg=(unit config:oidc)
      seat-key=@
      flows=(map @t flow)
      sessions=(map @t session)
  ==
+$  state-2  [%2 table-state]
+$  state-3  [%3 guests=(map @t @da) guest-wake=(unit @da) table-state]
++  spectator  '00000000000000000000000000000000'
::  Round up to five seconds so rapid polling rarely changes saved state.
++  idle-deadline
  |=  now=@da
  ^-  @da
  (add ~m2 (mul ~s5 (div (add now (dec ~s5)) ~s5)))
++  guest-alarm
  |=  [task=?(%wait %rest) at=@da]
  ^-  card
  [%pass /guest-seats/[(scot %da at)] %arvo %b ?:(=(task %rest) [%rest at] [%wait at])]
::  Track a seat when it first appears in the engine. After Leave, the engine
::  can retain a folded seat until settlement. Never re-enroll that seat.
++  track-seats
  |=  [s=state-3 before=(map @t @t) now=@da]
  ^-  state-3
  =/  tracked=(map @t @da)
    %-  malt
    %+  murn  ~(tap by views.s)
    |=  [token=@t *]
    ^-  (unit [@t @da])
    ?:  =(token spectator)  ~
    =/  due  (~(get by guests.s) token)
    ?^  due  `[token u.due]
    ?:  (~(has by before) token)  ~
    `[token (idle-deadline now)]
  s(guests tracked)
++  new-seed
  |=  =bowl:gall
  ^-  seed
  =/  arr  (arrows:wasm-lib vase)
  =/  bin=octs
    .^(octs %cx /(scot %p our.bowl)/[q.byk.bowl]/(scot %da now.bowl)/bench/poker/wasm)
  =/  imp=(import:lia-sur:wasm-lib vase)
    :-  *vase
    =/  m  (script (list cw) vase)
    %-  malt
    :~  :-  'env'^'ship_entropy'
        |=  args=(pole cw)
        ^-  form:m
        =,  arr
        ;<  res=(list lv)  try:m  (call-ext %entropy ~)
        (return:m ;;((list cw) res))
    ==
  [bin (return:runnable:wasm-lib ~) ~ imp]
::
++  ask
  |=  [sed=seed body=octs eny=@uvJ]
  ^-  [octs seed]
  =/  wasm  wasm-lib
  =/  arr  (arrows:wasm vase)
  =/  len=@  p.body
  =/  req=@  q.body
  =/  scr
    =/  m  runnable:wasm
    ^-  form:m
    =,  arr
    ;<  ptr=@     try:m  (call-1 'request' ~[len])
    ;<  ~         try:m  (memwrite ptr len req)
    ;<  n=@       try:m  (call-1 'handle' ~[len])
    ;<  loc=@     try:m  (call-1 'response' ~)
    ;<  res=octs  try:m  (memread loc n)
    (return:m ~[octs+res])
  =/  r=[[yield:runnable:wasm vase] seed]  (run:wasm &+scr sed %gent)
  =/  asked=@ud  0
  |-
  =/  yil  -<.r
  ?:  ?=(%1 -.yil)
    ::  the dealer wants random bits for the shuffle: a different slice
    ::  of the ship's entropy each time it asks
    ::
    =/  val=(list lv)  ~[i64+(cut 6 [asked 1] eny)]
    $(r (run:wasm |+val +.r %gent), asked +(asked))
  ?>  ?=([%0 [[%octs *] ~]] yil)
  =/  o=octs  +.i.p.yil
  [o +.r]
::
::  Both browser actions and timed departures use the same Wasm state update.
++  apply-move
  |=  [s=state-3 body=octs b=bowl:gall]
  ^-  [answer=@t next=state-3]
  =/  out  (ask (need sed.s) body eny.b)
  =/  lines=wain  (to-wain:format q.-.out)
  ?~  lines  !!
  =/  seen=(map @t @t)
    %-  malt
    %+  turn  t.lines
    |=  line=@t
    [(end [3 32] line) (rsh [3 32] line)]
  =/  next  s(sed `+.out, ver +(ver.s), views seen)
  [i.lines ?~(cfg.s (track-seats next views.s now.b) next)]
::  Only successful requests ever reach this decoder.
++  guest-command
  |=  body=octs
  ^-  (unit [op=@t token=@t])
  =/  obj  (de:json:html q.body)
  ?.  ?=([~ %o *] obj)  ~
  =/  op  (~(get by p.u.obj) 'op')
  =/  who  (~(get by p.u.obj) 'token')
  ?.  &(?=([~ %s *] op) ?=([~ %s *] who))  ~
  `[p.u.op p.u.who]
::
++  give
  |=  [eid=@ta status=@ud type=@t extra=header-list:http data=@t]
  ^-  (list card)
  =/  paths=(list path)  [/http-response/[eid]]~
  =/  headers=header-list:http
    %+  weld  extra
    :~  ['content-type' type]
        ['cache-control' 'no-store']
        ['referrer-policy' 'no-referrer']
        ['x-content-type-options' 'nosniff']
        ['x-frame-options' 'DENY']
    ==
  :~  [%give %fact paths %http-response-header !>(`response-header:http`[status headers])]
      [%give %fact paths %http-response-data !>(`(unit octs)`[~ (as-octs:mimes:html data)])]
      [%give %kick paths ~]
  ==
++  json-out
  |=  [eid=@ta status=@ud body=@t]
  (give eid status 'application/json' ~ body)
++  redirect
  |=  [eid=@ta loc=@t extra=header-list:http]
  (give eid 303 'text/plain' [['location' loc] extra] '')
++  opaque
  |=  [salt=@tas entropy=@]
  ^-  @ta
  (cat 3 'poker.' (scot %uv (shas salt entropy)))
++  cookie-name
  |=  [kind=@t origin=@t]
  ^-  @t
  (cat 3 ?:(=('https:' (end [3 6] origin)) '__Host-poker-' 'poker-') kind)
++  cookie-header
  |=  [kind=@t value=@t seconds=@t origin=@t]
  ^-  [@t @t]
  :-  'set-cookie'
  %+  rap  3
  :~  (cookie-name kind origin)
      '='
      value
      '; Path=/; HttpOnly; SameSite=Lax; Max-Age='
      seconds
      ?:(=('https:' (end [3 6] origin)) '; Secure' '')
  ==
++  auth-error
  |=  [eid=@ta]
  =/  body  '<p>Sign-in expired or could not be verified. <a href="/poker/auth/start">Sign in again</a> or <a href="/poker">return to the table</a>.</p>'
  (give eid 400 'text/html; charset=utf-8' ~ body)
++  join-cards
  |=  [a=(list card) b=(list card)]
  ^-  (list card)
  ?~  a  b
  [i.a $(a t.a)]
++  rest-flow
  |=  [fid=@t f=flow]
  ^-  card
  [%pass /flow/[fid] %arvo %b %rest expires.f]
++  rest-session
  |=  [sid=@t s=session]
  ^-  card
  [%pass /session/[sid] %arvo %b %rest expires.s]
++  stop-flow
  |=  [fid=@t f=flow]
  ^-  (list card)
  :-  (rest-flow fid f)
  ?@  stage.f  ~
  :_  (auth-error eid.stage.f)
  [%pass /[-.stage.f]/[fid] %arvo %i %cancel-request ~]
--
=|  state-3
=*  state  -
^-  agent:gall
=<
|_  =bowl:gall
+*  this  .
    work  ~(. +> bowl)
    def   ~(. (default-agent this %|) bowl)
++  on-init
  ^-  (quip card _this)
  :_  this(sed `(new-seed bowl))
  [%pass /eyre %arvo %e %connect [~ /poker] %poker]~
++  on-save  !>(state)
++  on-load
  |=  old=vase
  ^-  (quip card _this)
  ?:  ?=([%3 *] q.old)  [~ this(state !<(state-3 old))]
  =.  state
    ?:  ?=([%2 *] q.old)
      =/  was  !<(state-2 old)
      [%3 ~ ~ +.was]
    ?:  ?=([%1 *] q.old)
      =/  was  !<(state-1 old)
      ::  A formerly guarded dealer stays closed during the upgrade.
      state(sed sed.was, ver ver.was, views views.was, closed ?=(^ key-hash.was))
    =/  was  !<(state-0 old)
    ?~  sed.was  state(sed `(new-seed bowl))
    state(sed sed.was, ver ver.was, views views.was)
  =.  state
    ?:  |(closed ?=(^ cfg))  state
    (track-seats state ~ now.bowl)
  =^  timers  state  schedule-guests:work
  [timers this]
++  on-poke
  |=  [=mark =vase]
  ^-  (quip card _this)
  ?.  ?=(?(%handle-http-request %noun) mark)  (on-poke:def mark vase)
  =/  old-guests  guests
  =^  cards  state  (poke:work mark vase)
  ?:  =(old-guests guests)  [cards this]
  =^  timers  state  schedule-guests:work
  [(join-cards cards timers) this]
++  on-watch
  |=  =path
  ^-  (quip card _this)
  ?:  ?=([%http-response @ ~] path)
    ?>  (eyre-subscriber:work i.t.path)
    `this
  (on-watch:def path)
++  on-leave  on-leave:def
++  on-peek   on-peek:def
++  on-agent  on-agent:def
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?.  ?=(?(%iris %behn %eyre) -.sign-arvo)  (on-arvo:def wire sign-arvo)
  =^  cards  state  (receive:work wire sign-arvo)
  [cards this]
++  on-fail   on-fail:def
--
|_  =bowl:gall
+*  this  state
++  poke
  |=  [=mark =vase]
  ^-  (quip card _this)
  ?:  =(%noun mark)
    ?>  =(src.bowl our.bowl)
    ?:  =(%reset q.vase)
      [~ this(sed `(new-seed bowl), ver +(ver), views ~, guests ~)]
    =/  setup  ;;([%oidc c=config:oidc] q.vase)
    ?>  (valid-config:oidc c.setup)
    ::  An existing authenticated table can rotate its client credentials.
    =/  same=?  &(?=(^ cfg) =(issuer.u.cfg issuer.c.setup))
    ?.  |(same =(~ (~(del by views) spectator)))
      ~|  %finish-or-reset-table-before-changing-issuer  !!
    =/  clean  this(cfg `c.setup, closed |, sessions ~, flows ~, guests ~)
    =/  failed=(list card)
      %+  join-cards  (zing (turn ~(tap by flows) stop-flow))
      (turn ~(tap by sessions) rest-session)
    ?:  same  [failed clean]
    [failed clean(seat-key (shas %seat-key eny.bowl), sed `(new-seed bowl), ver +(ver), views ~)]
  =+  !<([eid=@ta req=inbound-request:eyre] vase)
  ?>  (eyre-subscriber eid)
  =/  url  url.request.req
  =/  body=octs  (fall body.request.req [0 0])
  =/  line  (rush url ;~(plug apat:de-purl:html yque:de-purl:html))
  ?~  line  [(json-out eid 400 '{"error":"invalid URL"}') this]
  =*  site  ->.u.line
  =*  args  +.u.line
  ?:  closed  [(json-out eid 503 '{"error":"configure ship sign-in"}') this]
  ?:  =(%'GET' method.request.req)
    ?:  ?=([%poker ~] site)
      =/  page=@t
        .^(@t %cx /(scot %p our.bowl)/[q.byk.bowl]/(scot %da now.bowl)/bench/poker-ui/html)
      [(give eid 200 'text/html; charset=utf-8' ~ page) this]
    ?:  ?=([%poker %auth %session ~] site)
      ?~  cfg  [(json-out eid 200 '{"standalone":true}') this]
      =/  who  (session-ship header-list.request.req)
      [(json-out eid 200 (rap 3 ~['{"ship":' (ship-json who) '}'])) this]
    ?^  cfg
      ?:  ?=([%poker %auth %start ~] site)
        (begin eid header-list.request.req)
      ?:  ?=([%poker %auth %callback ~] site)
        (callback eid header-list.request.req args)
      [(json-out eid 404 '{"error":"not found"}') this]
    [(json-out eid 404 '{"error":"not found"}') this]
  ?.  =(%'POST' method.request.req)
    [(json-out eid 405 '{"error":"method not allowed"}') this]
  ?~  cfg
    ?:  =('/poker/poll' url)  (poll eid q.body ~)
    ?:  =('/poker/disconnect' url)
      =/  due  (~(get by guests) q.body)
      :_  ?~(due this this(guests (~(put by guests) q.body (min u.due (add now.bowl ~s20)))))
      (json-out eid 200 '{"ok":true}')
    ?:  =('/poker/api' url)   (play eid body)
    ?:  =('/poker/reset' url)
      :_  this(sed `(new-seed bowl), ver +(ver), views ~, guests ~)
      (json-out eid 200 '{"ok":true}')
    [(json-out eid 404 '{"error":"not found"}') this]
  ?.  (origin-ok:web header-list.request.req origin.u.cfg)
    [(json-out eid 403 '{"error":"invalid origin"}') this]
  ?:  =('/poker/auth/logout' url)
    =/  sid  (cookie:web header-list.request.req (cookie-name 'session' origin.u.cfg))
    =/  fid  (cookie:web header-list.request.req (cookie-name 'state' origin.u.cfg))
    =/  heads  ~[(cookie-header 'session' '' '0' origin.u.cfg) (cookie-header 'state' '' '0' origin.u.cfg)]
    :_  this(sessions (~(del by sessions) (fall sid '')), flows (~(del by flows) (fall fid '')))
    =/  sess  (~(get by sessions) (fall sid ''))
    %+  join-cards  ?~(sess ~ [(rest-session (need sid) u.sess)]~)
    =/  f  (~(get by flows) (fall fid ''))
    %+  join-cards  ?~(f ~ (stop-flow (need fid) u.f))
    (give eid 200 'application/json' heads '{"ok":true}')
  =/  who  (session-ship header-list.request.req)
  =/  token  ?~(who spectator (ship-token:web seat-key u.who))
  ?:  =('/poker/poll' url)  (poll eid token who)
  ?.  =('/poker/api' url)  [(json-out eid 404 '{"error":"not found"}') this]
  ?~  who  [(json-out eid 401 '{"error":"sign in to play"}') this]
  =/  move  (move:web body token u.who)
  ?~  move  [(json-out eid 400 '{"error":"invalid move"}') this]
  (play eid u.move)
++  ship-json
  |=  who=(unit @p)
  ^-  @t
  ?~  who  'null'
  (en:json:html s+(scot %p u.who))
++  session-ship
  |=  headers=header-list:http
  ^-  (unit @p)
  =/  sid  (cookie:web headers (cookie-name 'session' origin:(need cfg)))
  ?~  sid  ~
  =/  row  (~(get by sessions) u.sid)
  ?~  row  ~
  ?:  (gte now.bowl expires.u.row)  ~
  `who.u.row
++  poll
  |=  [eid=@ta token=@t who=(unit @p)]
  ^-  (quip card _this)
  =/  mine  (fall (~(get by views) token) (fall (~(get by views) spectator) 'null'))
  =/  extra  ?~(cfg '' (cat 3 ',"ship":' (ship-json who)))
  =/  out  (rap 3 ~['{"v":' (crip (a-co:co ver)) ',"view":' mine extra '}'])
  =?  guests  (~(has by guests) token)
    (~(put by guests) token (idle-deadline now.bowl))
  [(json-out eid 200 out) this]
++  play
  |=  [eid=@ta body=octs]
  ^-  (quip card _this)
  =/  [answer=@t next=state-3]  (apply-move this body bowl)
  :-  (json-out eid 200 answer)
  ?:  |(?=(^ cfg) !=(answer '{"ok":true}'))  next
  =/  cmd  (guest-command body)
  ?~  cmd  next
  ?.  (~(has by guests.next) token.u.cmd)  next
  ?:  =('leave' op.u.cmd)  next(guests (~(del by guests.next) token.u.cmd))
  next(guests (~(put by guests.next) token.u.cmd (idle-deadline now.bowl)))
::  One Behn timer covers every guest. An existing earlier wake can safely
::  recheck renewed leases and then schedule the new earliest deadline.
++  schedule-guests
  ^-  (quip card _this)
  =/  soon=(unit @da)
    %+  roll  ~(val by guests)
    |=  [a=@da b=(unit @da)]
    ^-  (unit @da)
    `?~(b a (min a u.b))
  ?:  =(soon guest-wake)  [~ this]
  ?:  &(?=(^ soon) ?=(^ guest-wake) (lte u.guest-wake u.soon))  [~ this]
  =/  cancel=(list card)  ?~(guest-wake ~ ~[(guest-alarm %rest u.guest-wake)])
  :_  this(guest-wake soon)
  ?~  soon  cancel
  [(guest-alarm %wait u.soon) cancel]
++  expire-guests
  ^-  (quip card _this)
  =.  guest-wake  ~
  =/  tokens  ~(key by guests)
  =/  left  ~(tap in tokens)
  |-
  ?~  left  schedule-guests
  =/  due  (~(get by guests) i.left)
  ?:  |(?=(~ due) (gth u.due now.bowl))  $(left t.left)
  =/  token  i.left
  =.  guests  (~(del by guests) token)
  =/  body  (as-octs:mimes:html (rap 3 ~['{"op":"leave","token":"' token '"}']))
  =/  result  (apply-move this body bowl)
  $(left t.left, state next.result)
++  begin
  |=  [eid=@ta headers=header-list:http]
  ^-  (quip card _this)
  =/  c  (need cfg)
  =/  prev  (cookie:web headers (cookie-name 'state' origin.c))
  =/  old  (~(get by flows) (fall prev ''))
  =?  flows  ?=(^ old)  (~(del by flows) (need prev))
  ?:  (gte ~(wyt by flows) 512)
    [(json-out eid 429 '{"error":"too many sign-in attempts"}') this]
  =/  fid  (opaque %state eny.bowl)
  =/  f=flow  [(add now.bowl ~m10) (opaque %nonce eny.bowl) (opaque %pkce eny.bowl) %ready]
  =/  target  (authorize-url:oidc c fid nonce.f verifier.f)
  =/  heads  ~[(cookie-header 'state' fid '600' origin.c)]
  :_  this(flows (~(put by flows) fid f))
  %+  join-cards  ?~(old ~ (stop-flow (need prev) u.old))
  ^-  (list card)
  :_  (redirect eid target heads)
  [%pass /flow/[fid] %arvo %b %wait expires.f]
++  callback
  |=  [eid=@ta headers=header-list:http args=(list [k=@t v=@t])]
  ^-  (quip card _this)
  =/  c  (need cfg)
  =/  query  (malt args)
  ?.  =((lent args) ~(wyt by query))  [(auth-error eid) this]
  =/  fid  (fall (~(get by query) 'state') '')
  =/  f  (~(get by flows) fid)
  ?~  f  [(auth-error eid) this]
  ?.  &(=(`fid (cookie:web headers (cookie-name 'state' origin.c))) ?=(%ready stage.u.f))
    [(auth-error eid) this]
  =/  our-iss  (~(get by query) 'iss')
  =/  code  (fall (~(get by query) 'code') '')
  ?:  |((gte now.bowl expires.u.f) &(?=(^ our-iss) !=(u.our-iss issuer.c)) =('' code) (~(has by query) 'error') (gth (met 3 code) 2.048))
    [[(rest-flow fid u.f) (auth-error eid)] this(flows (~(del by flows) fid))]
  =/  until=@da  (min expires.u.f (add now.bowl ~s30))
  :_  this(flows (~(put by flows) fid u.f(expires until, stage [%keys eid code])))
  :~  (rest-flow fid u.f)
      [%pass /flow/[fid] %arvo %b %wait until]
      [%pass /keys/[fid] %arvo %i %request (jwks-request:oidc c) [0 0]]
  ==
++  finished
  |=  [fid=@ta leg=?(%keys %token) res=client-response:iris]
  ^-  (quip card _this)
  =/  f  (~(get by flows) fid)
  ?~  f  [~ this]
  ?@  stage.u.f  [~ this]
  ?.  =(leg -.stage.u.f)  [~ this]
  =/  eid  eid.stage.u.f
  =/  clean  this(flows (~(del by flows) fid))
  =/  fail  [[(rest-flow fid u.f) (auth-error eid)] clean]
  ?:  ?=(%progress -.res)
    ?.  (gth bytes-read.res 65.536)  [~ this]
    [(stop-flow fid u.f) clean]
  ?.  ?=([%finished [%200 *] [~ *]] res)  fail
  =/  file  data.u.full-file.res
  ?:  |((gte now.bowl expires.u.f) (gth p.file 65.536))  fail
  =/  c  (need cfg)
  ?:  ?=(%keys -.stage.u.f)
    =/  token-req  (exchange:oidc c code.stage.u.f verifier.u.f)
    :_  this(flows (~(put by flows) fid u.f(stage [%token eid q.file])))
    [%pass /token/[fid] %arvo %i %request token-req [0 0]]~
  =/  who  (verify:oidc c q.file jwks.stage.u.f nonce.u.f now.bowl)
  ?~  who  fail
  ?:  (gte ~(wyt by sessions) 8.192)
    [[(rest-flow fid u.f) (json-out eid 503 '{"error":"session limit"}')] clean]
  =/  sid  (opaque %session eny.bowl)
  =/  until=@da  (add now.bowl ~h12)
  =/  heads  ~[(cookie-header 'session' sid '43200' origin.c) (cookie-header 'state' '' '0' origin.c)]
  :_  clean(sessions (~(put by sessions) sid [until u.who]))
  :-  (rest-flow fid u.f)
  :_  (redirect eid '/poker' heads)
  [%pass /session/[sid] %arvo %b %wait until]
::  Gall exposes the incoming subscriber duct in sup.bowl. Eyre subscribes
::  first, then delivers the HTTP poke using the browser's guest identity.
::  Restrict response facts (including Set-Cookie) to this Eyre subscription.
++  eyre-subscriber
  |=  eid=@ta
  ^-  ?
  =/  subscribers
    %+  skim  ~(tap by sup.bowl)
    |=  entry=[duct [@p path]]
    =(/http-response/[eid] +>.entry)
  ?.  ?=([* ~] subscribers)  |
  =/  connection  i.subscribers
  ?~  p.connection  |
  &(=(/eyre/watch-response/[eid] i.p.connection) =(src.bowl p.q.connection))
++  receive
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?:  ?=([%eyre %bound *] sign-arvo)  `this
  ?:  ?=([?(%keys %token) @ ~] wire)
    ?.  ?=([%iris %http-response *] sign-arvo)  `this
    (finished i.t.wire i.wire +>.sign-arvo)
  ?:  ?=([%behn %wake *] sign-arvo)
    ?:  ?=([%guest-seats @ ~] wire)
      ?.  &(?=(^ guest-wake) =((scot %da u.guest-wake) i.t.wire))  `this
      expire-guests
    ?:  ?=([%session @ ~] wire)
      [~ this(sessions (~(del by sessions) i.t.wire))]
    ?:  ?=([%flow @ ~] wire)
      =/  f  (~(get by flows) i.t.wire)
      ?~  f  `this
      =/  clean  this(flows (~(del by flows) i.t.wire))
      [(stop-flow i.t.wire u.f) clean]
    `this
  `this
--
