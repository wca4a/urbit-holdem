::  HTTP and engine boundaries for a table hosted by the dealer ship.
|%
++  cookie
  |=  [headers=header-list:http name=@t]
  ^-  (unit @t)
  =/  found=(list @t)  ~
  |-
  ?~  headers  ?:(?=([@ ~] found) [~ i.found] ~)
  ?.  =('cookie' key.i.headers)  $(headers t.headers)
  =/  pairs  (rush value.i.headers cock:de-purl:html)
  ?~  pairs  ~
  =.  found
    %+  weld  found
    %+  murn  u.pairs
    |=  [key=@t val=@t]
    ^-  (unit @t)
    ?:(=(name key) [~ val] ~)
  $(headers t.headers)
::
++  origin-ok
  |=  [headers=header-list:http origin=@t]
  ^-  ?
  =/  origins  (skim headers |=([key=@t val=@t] =('origin' key)))
  =(origins ~[['origin' origin]])
::
++  ship-token
  |=  [secret=@ ship=@p]
  ^-  @t
  (en:base16:mimes:html 16 (shaf secret ship))
::
++  move
  |=  [body=octs token=@t ship=@p]
  ^-  (unit octs)
  ?.  &((lte p.body 2.048) =(p.body (met 3 q.body)))  ~
  =/  obj  (de:json:html q.body)
  ?.  ?=([~ %o *] obj)  ~
  =/  args  p.u.obj
  =/  op  (~(get by args) 'op')
  ?.  ?=([~ %s *] op)  ~
  =/  base=(map @t json)
    (malt ~[['op' u.op] ['token' s+token]])
  =/  keys=(unit (list @t))
    ?+  p.u.op  ~
        %join   [~ ~]
        %leave  [~ ~]
        %rebuy  [~ ~]
        %deal   [~ ~]
        %act    [~ ~['action' 'amount']]
        %seed   [~ ~['seed']]
    ==
  ?~  keys  ~
  =?  base  =(%join p.u.op)  (~(put by base) 'name' s+(scot %p ship))
  =/  rest  u.keys
  |-
  ?~  rest  `(as-octs:mimes:html (en:json:html o+base))
  =/  val  (~(get by args) i.rest)
  ?~  val  $(rest t.rest)
  $(rest t.rest, base (~(put by base) i.rest u.val))
--
