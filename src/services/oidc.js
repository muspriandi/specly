// Single sign-on with OpenID Connect: authorization code flow with PKCE, state and nonce, using the maintained openid-client
// library (it validates the issuer, audience, signature, expiry and nonce of the ID token). openid-client is ESM-only, hence
// the dynamic import. A sign-in is only accepted for an email address the identity provider has VERIFIED, and, when
// OIDC_ALLOWED_DOMAINS is set, only for those domains.
const config = require('../config');
const secrets = require('../lib/secrets');
const { cookieBase, baseUrl } = require('../lib/http');

const COOKIE = 'oidc', COOKIE_PATH = '/auth/oidc', TTL_MS = 10 * 60 * 1000;
const lib = () => import('openid-client');
let discovered = null;

async function discover() {
  if (!discovered) {
    discovered = (async () => {
      const c = await lib();
      return c.discovery(new URL(config.oidc.issuer), config.oidc.clientId, config.oidc.clientSecret, undefined, config.oidc.allowInsecure ? { execute: [c.allowInsecureRequests] } : undefined);
    })();
    discovered.catch(() => { discovered = null; }); // try again next time if the provider was unreachable
  }
  return discovered;
}

// OpenID Connect lets a client skip checking the signature of an ID token that came straight from the token endpoint over TLS.
// We check it anyway, against the provider's published keys: one less thing that depends on the transport being right.
// Only asymmetric algorithms are accepted (never "none", never a shared-secret HMAC).
const keySets = new Map();
async function verifySignature(idToken, cfg) {
  const jose = await import('jose');
  const meta = cfg.serverMetadata();
  if (!keySets.has(meta.jwks_uri)) keySets.set(meta.jwks_uri, jose.createRemoteJWKSet(new URL(meta.jwks_uri)));
  const algorithms = (meta.id_token_signing_alg_values_supported || ['RS256']).filter((a) => /^(RS|PS|ES)(256|384|512)$|^EdDSA$/.test(a));
  await jose.jwtVerify(idToken, keySets.get(meta.jwks_uri), { issuer: meta.issuer, audience: config.oidc.clientId, algorithms: algorithms.length ? algorithms : ['RS256'] });
}

const callbackUrl = (req) => `${baseUrl(req)}/auth/oidc/callback`;

// Starts a sign-in: remembers state, nonce and the PKCE verifier in a short-lived httpOnly cookie, and returns the provider URL.
async function begin(req, res) {
  const c = await lib(), cfg = await discover();
  const verifier = c.randomPKCECodeVerifier(), state = c.randomState(), nonce = c.randomNonce();
  const url = c.buildAuthorizationUrl(cfg, { redirect_uri: callbackUrl(req), scope: config.oidc.scope, code_challenge: await c.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce });
  res.cookie(COOKIE, secrets.seal(JSON.stringify({ verifier, state, nonce })), { ...cookieBase, maxAge: TTL_MS, path: COOKIE_PATH });
  return url.href;
}

// Completes it: returns the ID token's claims. Throws if anything does not check out.
async function finish(req, res) {
  const raw = req.cookies && req.cookies[COOKIE];
  res.clearCookie(COOKIE, { ...cookieBase, path: COOKIE_PATH });
  if (!raw) throw new Error('missing sign-in state');
  const { verifier, state, nonce } = JSON.parse(secrets.open(raw));
  const c = await lib(), cfg = await discover();
  const current = new URL(`${baseUrl(req)}${req.originalUrl}`);
  const tokens = await c.authorizationCodeGrant(cfg, current, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
  await verifySignature(tokens.id_token, cfg);
  return tokens.claims();
}

const domainAllowed = (email) => !config.oidc.allowedDomains.length || config.oidc.allowedDomains.includes(String(email).split('@').pop());

module.exports = { begin, finish, domainAllowed };
