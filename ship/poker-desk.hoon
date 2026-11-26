::  :hood +poker-desk
::  Publish a separate desk from the game files staged on the local %base.
/+  *generators
:-  %ask
|=  [[now=@da eny=@uvJ bek=beak] ~ ~]
=/  base=beak  bek(q %base, r da+now)
=/  dest=beak  base(q %poker)
=/  manifest=(list path)
  :~  /sys/kelvin
      /mar/bill/hoon
      /mar/hoon/hoon
      /mar/html/hoon
      /mar/kelvin/hoon
      /mar/mime/hoon
      /mar/noun/hoon
      /mar/ship/hoon
      /mar/txt/hoon
      /mar/txt-diff/hoon
      /mar/wasm/hoon
      /lib/default-agent/hoon
      /lib/skeleton/hoon
      /lib/wasm/lia/hoon
      /lib/wasm/runner/engine/hoon
      /lib/wasm/runner/op-def/hoon
      /lib/wasm/validator/hoon
      /lib/wasm/parser/hoon
      /sur/wasm/lia/hoon
      /sur/wasm/engine/hoon
      /sur/wasm/wasm/hoon
      /lib/jose/hoon
      /lib/pkcs/hoon
      /lib/primitive-rsa/hoon
      /lib/der/hoon
      /sur/asn1/hoon
      /lib/poker-web/hoon
      /lib/poker-oidc/hoon
      /app/poker/hoon
      /bench/poker/wasm
      /bench/poker-ui/html
  ==
=/  files=(map path page:clay)
  %-  malt
  %+  turn  manifest
  |=  pax=path
  :-  pax
  ~|  [%missing-package-input pax]
  [(rear pax) .^(* %cx (en-beam base pax))]
=.  files  (~(put by files) /desk/bill [%bill ~[%poker]])
=.  files  (~(put by files) /desk/ship [%ship p.bek])
::  Retain the license of the Urbit files and the MIT notices from the
::  Rust libraries linked into the distributed Wasm binary.
=/  license=wain
  :~
      'The MIT License (MIT)'
      ''
      'Copyright (c) 2017 Urbit'
      'Rust standard library: Copyright (c) The Rust Project Developers'
      'block-buffer: Copyright (c) 2018-2019 The RustCrypto Project Developers'
      'cfg-if: Copyright (c) 2014 Alex Crichton'
      'crypto-common: Copyright (c) 2021 RustCrypto Developers'
      'digest: Copyright (c) 2017 Artyom Pavlov'
      'generic-array: Copyright (c) 2015 Bartłomiej Kamiński'
      'memchr: Copyright (c) 2015 Andrew Gallant'
      'sha2: Copyright (c) 2006-2009 Graydon Hoare'
      '      Copyright (c) 2009-2013 Mozilla Foundation'
      '      Copyright (c) 2016 Artyom Pavlov'
      'typenum: Copyright (c) 2014 Paho Lurie-Gregg'
      'The MIT license below also covers itoa, serde, serde_core, serde_json and zmij.'
      ''
      'Permission is hereby granted, free of charge, to any person obtaining a copy'
      'of this software and associated documentation files (the "Software"), to deal'
      'in the Software without restriction, including without limitation the rights'
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell'
      'copies of the Software, and to permit persons to whom the Software is'
      'furnished to do so, subject to the following conditions:'
      ''
      'The above copyright notice and this permission notice shall be included in all'
      'copies or substantial portions of the Software.'
      ''
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR'
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,'
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE'
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER'
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,'
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE'
      'SOFTWARE.'
  ==
=.  files  (~(put by files) /third-party-notices/txt [%txt license])
?.  (~(has in .^((set desk) %cd (en-beam base(q %$) /))) %poker)
  (produce [%helm-pass `note-arvo`(new-desk:cloy %poker ~ files)])
::  Adding to a fresh |new-desk is safe if its contents match the package.
::  Refuse to overwrite edits or silently distribute unrelated files.
=/  existing=(list path)  .^((list path) %ct (en-beam dest /))
=/  missing
  %+  roll  existing
  |=  [pax=path left=_files]
  =/  want  (~(get by left) pax)
  ~|  [%unexpected-or-modified-file pax]
  ?>  ?=(^ want)
  ?>  =(q.u.want .^(* %cx (en-beam dest pax)))
  (~(del by left) pax)
?:  =(~ missing)  (print leaf+"%poker already matches this release" no-product)
=/  changes=soba:clay
  %+  turn  ~(tap by missing)
  |=  [pax=path body=page:clay]
  [pax %ins p.body %noun q.body]
(produce [%helm-pass `note-arvo`[%c %info %poker %& changes]])
