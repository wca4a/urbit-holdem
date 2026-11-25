::  %poker: a hold'em table (bench/poker.wasm) running in urwasm
::
::    GET  /poker         the web page (bench/poker-ui.html)
::    POST /poker/api     one JSON request (join, deal, act, ...), JSON answer
::    POST /poker/poll    body is a player token; answers that player's view
::    POST /poker/reset   clear the table
::
::  the wasm program is the dealer. after every request it produces what
::  each seated player may see, one line per player, and this agent keeps
::  those lines keyed by the player's secret token. a browser only ever
::  gets its own line, so nobody receives anyone else's cards. polling
::  reads the kept lines and does not run wasm.
::
/+  default-agent, wasm-lib=wasm-lia
=/  lv  lia-value:lia-sur:wasm-lib
=/  cw  coin-wasm:wasm-sur:wasm-lib
=/  script  script:lia-sur:wasm-lib
|%
+$  card  card:agent:gall
+$  seed  seed:lia-sur:wasm-lib
+$  state-0  [%0 sed=(unit seed) ver=@ud views=(map @t @t)]
+$  state-1  [%1 sed=(unit seed) ver=@ud views=(map @t @t) key-hash=(unit @)]
++  spectator  '00000000000000000000000000000000'
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
++  give
  |=  [protected=? eyre-id=@ta status=@ud type=@t data=octs]
  ^-  (list card)
  =/  paths=(list path)  [/http-response/[eyre-id]]~
  =/  headers=header-list:http  ~[['content-type' type] ['cache-control' 'no-store']]
  =?  headers  protected  [['x-poker-protected' '1'] headers]
  :~  [%give %fact paths %http-response-header !>(`response-header:http`[status headers])]
      [%give %fact paths %http-response-data !>(`(unit octs)`[~ data])]
      [%give %kick paths ~]
  ==
--
=|  state-1
=*  state  -
^-  agent:gall
|_  =bowl:gall
+*  this  .
    def   ~(. (default-agent this %|) bowl)
++  on-init
  ^-  (quip card _this)
  :_  this(sed `(new-seed bowl))
  [%pass /eyre %arvo %e %connect [~ /poker] %poker]~
++  on-save  !>(state)
++  on-load
  |=  old=vase
  ^-  (quip card _this)
  ?:  ?=([%1 *] q.old)
    [~ this(state !<(state-1 old))]
  =/  was  !<(state-0 old)
  ?~  sed.was  [~ this(sed `(new-seed bowl), ver 0, views ~)]
  [~ this(sed sed.was, ver ver.was, views views.was)]
++  on-poke
  |=  [=mark =vase]
  ^-  (quip card _this)
  ?:  =(%noun mark)
    ?>  =(src.bowl our.bowl)
    ::  Local Dojo: :poker &noun [%gateway-key (shax '...')]
    ::  Only the SHA-256 digest needs to be passed to the ship.
    =/  conf  ;;([%gateway-key hash=@] q.vase)
    ?>  &((gth hash.conf 0) (lte (met 0 hash.conf) 256))
    ?^  key-hash  [~ this(key-hash `hash.conf)]
    ::  Guest seats cannot carry their unverified names into hosted play.
    ?>  =(~ (~(del by views) spectator))
    [~ this(key-hash `hash.conf, sed `(new-seed bowl), ver +(ver), views ~)]
  ?.  ?=(%handle-http-request mark)  (on-poke:def mark vase)
  =+  !<([eyre-id=@ta req=inbound-request:eyre] vase)
  =/  protected=?  ?=(^ key-hash)
  =/  authed=?
    ?~  key-hash  &
    =/  key  (get-header:http 'x-poker-dealer-key' header-list.request.req)
    ?~  key  |
    &((lte (met 3 u.key) 256) =(u.key-hash (shax u.key)))
  ?.  authed
    [(give | eyre-id 403 'application/json' (as-octs:mimes:html '{"error":"forbidden"}')) this]
  =/  reply  (cury give protected)
  =/  url=@t  url.request.req
  =/  body=octs  (fall body.request.req [0 0])
  ?:  ?=(%'GET' method.request.req)
    ?:  =('/poker/gateway-status' url)
      =/  out  ?:(protected '{"protected":true}' '{"protected":false}')
      [(reply eyre-id 200 'application/json' (as-octs:mimes:html out)) this]
    =/  page=@t
      .^(@t %cx /(scot %p our.bowl)/[q.byk.bowl]/(scot %da now.bowl)/bench/poker-ui/html)
    [(reply eyre-id 200 'text/html; charset=utf-8' (as-octs:mimes:html page)) this]
  ?:  =('/poker/poll' url)
    =/  mine=@t
      %+  fall  (~(get by views) q.body)
      (fall (~(get by views) spectator) 'null')
    =/  out=@t  (rap 3 ~['{"v":' (crip (a-co:co ver)) ',"view":' mine '}'])
    [(reply eyre-id 200 'application/json' (as-octs:mimes:html out)) this]
  ?:  =('/poker/reset' url)
    :_  this(sed `(new-seed bowl), ver +(ver), views ~)
    (reply eyre-id 200 'application/json' (as-octs:mimes:html '{"ok":true}'))
  =/  out  (ask (need sed) body eny.bowl)
  =/  lines=wain  (to-wain:format q.-.out)
  ?~  lines  !!
  =/  seen=(map @t @t)
    %-  malt
    %+  turn  t.lines
    |=  line=@t
    [(end [3 32] line) (rsh [3 32] line)]
  :_  this(sed `+.out, ver +(ver), views seen)
  (reply eyre-id 200 'application/json' (as-octs:mimes:html i.lines))
++  on-watch
  |=  =path
  ^-  (quip card _this)
  ?:  ?=([%http-response @ ~] path)  `this
  (on-watch:def path)
++  on-leave  on-leave:def
++  on-peek   on-peek:def
++  on-agent  on-agent:def
++  on-arvo
  |=  [=wire =sign-arvo]
  ^-  (quip card _this)
  ?:  ?=([%eyre %bound *] sign-arvo)  `this
  (on-arvo:def wire sign-arvo)
++  on-fail   on-fail:def
--
