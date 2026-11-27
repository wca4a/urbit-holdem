// Print a disposable %say generator for the /lib/poker-oidc verifier.
// node test/oidc-verifier.mjs > <mounted-desk>/gen/test-poker-oidc.hoon
import { generateKeyPairSync, sign } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const issuer = 'https://hosting.example/v1/oidc';
const header = { alg: 'RS256', kid: key.kid };
const timestamp = 1704067200;
const claims = { iss: issuer, aud: 'poker', sub: 'opaque-id', ship: '~zod', nonce: 'n', iat: timestamp, exp: timestamp + 60 };
const raw = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function idToken(payload, protectedHeader, signatureKey) {
  const signed = raw(protectedHeader) + '.' + raw(payload);
  return signed + '.' + sign('RSA-SHA256', Buffer.from(signed), signatureKey).toString('base64url');
}

const vectors = [
  ['valid', true, claims],
  ['other issuer', false, { ...claims, iss: 'https://other.example/v1/oidc' }],
  ['other audience', false, { ...claims, aud: 'another-app' }],
  ['wrong nonce', false, { ...claims, nonce: 'stale' }],
  ['already expired', false, { ...claims, exp: timestamp }],
  ['not yet valid', false, { ...claims, nbf: timestamp + 1 }],
  ['future issuance', false, { ...claims, iat: timestamp + 31 }],
  ['wrong authorized party', false, { ...claims, azp: 'other' }],
  ['invalid ship', false, { ...claims, ship: '~poker' }],
  ['unknown key', false, claims, { ...header, kid: 'other' }],
  ['wrong algorithm', false, claims, { ...header, alg: 'HS256' }],
  ['changed signing key', false, claims, header, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey],
];
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const wantChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
console.log(`/+  poker-oidc
:-  %say
|=  *
:-  %noun
=/  cfg=config:poker-oidc  ['https://poker.example' '${issuer}' 'poker' '01234567890123456789012345678901']
?>  (valid-config:poker-oidc cfg)
?>  !(valid-config:poker-oidc cfg(issuer 'http://hosting.example/v1/oidc'))
=/  auth  (authorize-url:poker-oidc cfg 'state' 'n' '${verifier}')
?>  =(auth 'https://hosting.example/v1/oidc/auth?response_type=code&scope=openid%20ship&client_id=poker&redirect_uri=https%3A%2F%2Fpoker.example%2Fpoker%2Fauth%2Fcallback&state=state&nonce=n&code_challenge_method=S256&code_challenge=${wantChallenge}')
=/  keys=@t  '${JSON.stringify({ keys: [key] })}'
=/  check  |=(txt=@t (verify:poker-oidc cfg txt keys 'n' ~2024.1.1))`);
for (const [label, valid, data, hdr = header, k = privateKey] of vectors) {
  const response = JSON.stringify({ id_token: idToken(data, hdr, k) });
  console.log(`~|  '${label}'
?>  =(${valid ? '`~zod' : '~'} (check '${response}'))`);
}
console.log("?>  =(~ (check '{}'))\n%oidc-passed");
