::  Copy to /gen/poker-web-check/hoon and run +poker-web-check in Dojo.
/+  poker-web
:-  %say
|=  *
:-  %noun
=/  token  (ship-token:poker-web 42 ~zod)
?>  =((met 3 token) 32)
?>  !=(token (ship-token:poker-web 42 ~nec))
?>  !=(token (ship-token:poker-web 43 ~zod))
=/  headers=header-list:http  ~[['cookie' 'other=A; table=B'] ['origin' 'https://table.test']]
?>  =(`@t`'B' (need (cookie:poker-web headers 'table')))
?>  =(~ (cookie:poker-web [['cookie' 'table=A'] headers] 'table'))
?>  (origin-ok:poker-web headers 'https://table.test')
?>  !(origin-ok:poker-web headers 'https://other.test')
?>  !(origin-ok:poker-web [['origin' 'https://table.test'] headers] 'https://table.test')
=/  input  (as-octs:mimes:html '{"op":"join","name":"wrong","token":"wrong"}')
=/  req  (need (move:poker-web input token ~zod))
=/  want=json  [%o (malt ~[['op' s+'join'] ['token' s+token] ['name' s+'~zod']])]
?>  =(want (need (de:json:html q.req)))
=/  act  (as-octs:mimes:html '{"op":"act","action":"raise","amount":25}')
=/  paid  (need (move:poker-web act token ~zod))
=/  expected=json  [%o (malt `(list [@t json])`~[['op' s+'act'] ['token' s+token] ['action' s+'raise'] ['amount' n+'25']])]
?>  =(expected (need (de:json:html q.paid)))
?>  =(~ (move:poker-web (as-octs:mimes:html '{"op":"reset"}') token ~zod))
?>  =(~ (move:poker-web (as-octs:mimes:html 'invalid') token ~zod))
%passed
