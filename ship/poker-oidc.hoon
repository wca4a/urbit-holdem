::  Native confidential client for Tlon Hosting's /v1/oidc issuer.
/+  jose, pkcs
|%
+$  config  [origin=@t issuer=@t client-id=@t client-secret=@t]
++  valid-origin
  |=  txt=@t
  =/  parsed  (rush txt ;~(plug htts:de-purl:html thor:de-purl:html))
  ?~  parsed  |
  =/  host=hart:eyre  u.parsed
  |(p.host =(r.host [%& [%localhost ~]]) =(r.host [%| %.127.0.0.1]))
++  valid-config
  |=  cfg=config
  =/  tail=@t  '/v1/oidc'
  =/  len=@ud  (met 3 issuer.cfg)
  ?.  (gth len (met 3 tail))  |
  =/  base=@ud  (sub len (met 3 tail))
  ?&  =((rsh [3 base] issuer.cfg) tail)
      (valid-origin (end [3 base] issuer.cfg))
      (valid-origin origin.cfg)
      !=((end [3 base] issuer.cfg) origin.cfg)
      !=('' client-id.cfg)
      (gte (met 3 client-secret.cfg) 32)
  ==
++  quoted
  |=(x=@t (crip (en-urlt:html (trip x))))
++  callback
  |=(cfg=config (cat 3 origin.cfg '/poker/auth/callback'))
++  authorize-url
  |=  [cfg=config state=@t nonce=@t verifier=@t]
  ^-  @t
  =/  challenge=@t  (en-base64url:jose 32 (shax verifier))
  %+  rap  3
  :~  issuer.cfg
      '/auth?response_type=code&scope=openid%20ship&client_id='
      (quoted client-id.cfg)
      '&redirect_uri='  (quoted (callback cfg))
      '&state='  (quoted state)
      '&nonce='  (quoted nonce)
      '&code_challenge_method=S256&code_challenge='  challenge
  ==
++  exchange
  |=  [cfg=config code=@t verifier=@t]
  ^-  request:http
  =/  basic=@t  (rap 3 ~[(quoted client-id.cfg) ':' (quoted client-secret.cfg)])
  =/  body=@t
    (rap 3 ~['grant_type=authorization_code&redirect_uri=' (quoted (callback cfg)) '&code=' (quoted code) '&code_verifier=' (quoted verifier)])
  :^  %'POST'  (cat 3 issuer.cfg '/token')
    :~  ['authorization' (cat 3 'Basic ' (en:base64:mimes:html (as-octs:mimes:html basic)))]
        ['content-type' 'application/x-www-form-urlencoded']
        ['accept' 'application/json']
    ==
  `(as-octs:mimes:html body)
++  jwks-request
  |=  cfg=config
  ^-  request:http
  [%'GET' (cat 3 issuer.cfg '/jwks') ~[['accept' 'application/json']] ~]
::
++  field
  |=  [obj=json key=@t]
  ?>  ?=([%o *] obj)
  (~(got by p.obj) key)
++  unpack
  |=  txt=@t
  ^-  octs
  =/  raw  (need (de-base64url:jose txt))
  ?>  =(txt (en-base64url:jose raw))
  raw
++  matches-key
  |=  [key=json kid=@t]
  ?.  ?=([%o *] key)  |
  =(`[%s kid] (~(get by p.key) 'kid'))
++  checked-ship
  |=  [cfg=config token-response=@t jwks-response=@t nonce=@t now=@da]
  ^-  @p
  ?>  &((lte (met 3 token-response) 32.768) (lte (met 3 jwks-response) 65.536))
  =/  response  (need (de:json:html token-response))
  =/  token  (so:dejs:format (field response 'id_token'))
  =/  parts=(list @t)  (rash token (most dot (cook crip (plus ;~(pose low hig nud hep cab)))))
  =/  chunks  ;;([header=@t payload=@t signature=@t ~] parts)
  =/  hdr  (need (de:json:html q:(unpack header.chunks)))
  ?>  ?=([%o *] hdr)
  ?>  =([%s 'RS256'] (field hdr 'alg'))
  ?>  !(~(has by p.hdr) 'crit')  ::  no extension headers implemented
  ?>  !(~(has by p.hdr) 'b64')
  =/  kid  (so:dejs:format (field hdr 'kid'))
  ?>  !=('' kid)
  =/  set  (need (de:json:html jwks-response))
  =/  keys  (field set 'keys')
  ?>  ?=([%a *] keys)
  =/  match  (skim p.keys |=(key=json (matches-key key kid)))
  ?>  ?=([^ ~] match)
  =/  key  i.match
  ?>  ?=([%o *] key)
  ?>  =([%s 'RSA'] (field key 'kty'))
  =/  alg  (~(get by p.key) 'alg')
  ?>  |(?=(~ alg) =(u.alg [%s 'RS256']))
  =/  use  (~(get by p.key) 'use')
  ?>  |(?=(~ use) =(u.use [%s 'sig']))
  =/  ops  (~(get by p.key) 'key_ops')
  ?>  |(?=(~ ops) =(u.ops [%a ~[[%s 'verify']]]))
  =/  pub  (need (pass:de:jwk:jose key))
  ?>  &((gte (met 0 n.pub.pub) 2.048) (lte (met 0 n.pub.pub) 4.096) =(65.537 e.pub.pub))
  =/  sig  (unpack signature.chunks)
  ?>  =(p.sig (met 3 n.pub.pub))
  =/  number  (rev 3 p.sig q.sig)
  ?>  (lth number n.pub.pub)
  =/  message=@t  (rap 3 ~[header.chunks '.' payload.chunks])
  ?>  (~(verify rs256:pkcs pub) number (as-octs:mimes:html message))
  =/  claims  (need (de:json:html q:(unpack payload.chunks)))
  ?>  ?=([%o *] claims)
  ?>  =([%s issuer.cfg] (field claims 'iss'))
  =/  aud  (field claims 'aud')
  ?>  |(=([%s client-id.cfg] aud) =([%a ~[[%s client-id.cfg]]] aud))
  =/  azp  (~(get by p.claims) 'azp')
  ?>  |(?=(~ azp) =(u.azp [%s client-id.cfg]))
  ?>  =([%s nonce] (field claims 'nonce'))
  ?>  !=('' (so:dejs:format (field claims 'sub')))
  =/  sec=@ud  (div (sub now ~1970.1.1) ~s1)
  =/  exp=@ud  (ni:dejs:format (field claims 'exp'))
  =/  iat=@ud  (ni:dejs:format (field claims 'iat'))
  ?>  &((gth exp sec) (gth exp iat) (lte iat (add sec 30)))
  =/  nbf  (~(get by p.claims) 'nbf')
  ?>  |(?=(~ nbf) (lte (ni:dejs:format u.nbf) sec))
  =/  name  (so:dejs:format (field claims 'ship'))
  =/  ship=@p  (slav %p name)
  ?>  =(name (scot %p ship))
  ship
++  verify
  |=  [cfg=config token-response=@t jwks-response=@t nonce=@t now=@da]
  ^-  (unit @p)
  (mole |.((checked-ship cfg token-response jwks-response nonce now)))
--
