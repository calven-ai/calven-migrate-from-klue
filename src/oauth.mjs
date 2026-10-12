// OAuth 2.1 for a remote MCP server: protected-resource discovery, dynamic
// client registration, authorization code with PKCE on a loopback redirect,
// token exchange, refresh and revocation. Tokens live in memory only.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const b64url = (buf) => buf.toString('base64url');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const detail = body.error_description || body.error || text.slice(0, 200);
    throw new Error(`${init?.method || 'GET'} ${url} failed with ${res.status}: ${detail}`);
  }
  return body;
}

async function firstJson(urls) {
  let last;
  for (const url of urls) {
    try {
      return { json: await getJson(url) };
    } catch (err) {
      last = err; // try the next candidate
    }
  }
  return { json: null, error: last };
}

const sameResource = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
const isLoopback = (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);

// Only https, or http on this machine (used by the tests), may be opened.
export function assertSafeUrl(raw, what) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`The server's ${what} is not a valid URL`);
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u))) return u;
  throw new Error(`The server's ${what} must use https: ${raw}`);
}

// Reads the resource metadata URL from the 401 challenge, falling back to the
// RFC 9728 well-known paths, then the authorization server metadata (RFC 8414,
// then OpenID discovery).
export async function discover(serverUrl) {
  const probe = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    signal: AbortSignal.timeout(30_000),
  });
  await probe.body?.cancel();
  const challenge = probe.headers.get('www-authenticate') || '';
  const match = challenge.match(/resource_metadata="([^"]+)"/);
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');

  const { json: resource, error: resourceError } = await firstJson([
    match?.[1],
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean));
  if (!resource?.authorization_servers?.length) {
    throw new Error(`Could not find OAuth metadata for ${serverUrl}${resourceError ? ` (${resourceError.message})` : ''}`);
  }
  if (resource.resource && !sameResource(resource.resource, serverUrl)) {
    throw new Error(`OAuth metadata is for ${resource.resource}, not ${serverUrl}`);
  }

  const issuer = new URL(resource.authorization_servers[0]);
  const ipath = issuer.pathname.replace(/\/+$/, '');
  const { json: as, error: asError } = await firstJson([
    `${issuer.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${issuer.origin}${ipath}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration${ipath}`,
    `${issuer.origin}${ipath}/.well-known/openid-configuration`,
  ]);
  if (!as?.authorization_endpoint || !as?.token_endpoint) {
    throw new Error(`Could not read the authorization server metadata at ${issuer.href}${asError ? ` (${asError.message})` : ''}`);
  }
  // the client secret and tokens travel to these, so they must be https too
  for (const [key, what] of [['token_endpoint', 'token endpoint'], ['registration_endpoint', 'registration endpoint'], ['revocation_endpoint', 'revocation endpoint']]) {
    if (as[key]) assertSafeUrl(as[key], what);
  }
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) {
    throw new Error('The authorization server does not support PKCE with S256');
  }
  return { resource, as };
}

export function openBrowser(url) {
  // rundll32 hands the URL to the default browser without a shell, so the
  // query string's & is never read as a command separator.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the URL is printed as well, so a missing opener is not fatal
  }
}

// Listens on 127.0.0.1 before registration, so the registered redirect URI
// points at a port this process already holds. Requests without the right
// state are answered and ignored, so a stray request cannot end the sign-in.
export async function startLoopback({ timeoutMs }) {
  let settle;
  const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => {}); // a cancel before anyone waits must not crash the process
  let expectedState = null;
  let timer;
  let done = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const reply = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      res.end(text);
    };
    if (url.pathname !== '/callback') return reply(404, 'Not found');
    if (!expectedState || url.searchParams.get('state') !== expectedState) {
      return reply(400, 'This sign-in link is not the one the export is waiting for. Return to the terminal.');
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (error || !code) {
      reply(400, 'Sign-in failed. Return to the terminal.');
      finish(new Error(`Authorization failed: ${error || 'no code returned'}`));
    } else {
      reply(200, 'Signed in. You can close this tab and return to the terminal.');
      finish(null, code);
    }
  });

  function finish(err, code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    if (err) settle.reject(err);
    else settle.resolve(code);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    waitForCode(state) {
      expectedState = state;
      timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in')), timeoutMs);
      return result;
    },
    close: () => finish(new Error('Sign-in cancelled')),
  };
}

export async function authorize({ serverUrl, scope, clientName, browser = true, log, timeoutMs = 300_000 }) {
  const { resource, as } = await discover(serverUrl);
  if (!as.registration_endpoint) {
    throw new Error('The server does not allow app registration. Use a personal access token (KLUE_TOKEN) instead.');
  }
  const authEndpoint = assertSafeUrl(as.authorization_endpoint, 'authorization endpoint');

  const loopback = await startLoopback({ timeoutMs });
  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
    const authMethods = as.token_endpoint_auth_methods_supported || ['client_secret_basic'];
    const requested = authMethods.includes('none') ? 'none' : authMethods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
    const client = await getJson(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: requested,
        scope,
      }),
    });
    // the server may assign a different method than the one asked for
    const authMethod = client.token_endpoint_auth_method || requested;

    const { verifier, challenge } = pkcePair();
    const state = b64url(randomBytes(16));
    const authUrl = new URL(authEndpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: resource.resource || serverUrl,
    })) authUrl.searchParams.set(k, v);

    const codePromise = loopback.waitForCode(state);
    log(`Sign in to Klue in your browser. If it does not open, visit:\n\n  ${authUrl}\n`);
    if (browser) openBrowser(authUrl.toString());
    const code = await codePromise;

    const session = { as, client, authMethod, resource: resource.resource || serverUrl };
    session.token = await tokenRequest(session, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: session.resource,
    });
    return session;
  } catch (err) {
    loopback.close();
    throw err;
  }
}

async function tokenRequest(session, params, endpoint = session.as.token_endpoint) {
  const { client, authMethod } = session;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const body = new URLSearchParams(params);
  if (authMethod === 'client_secret_basic') {
    const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    body.set('client_id', client.client_id);
    if (authMethod === 'client_secret_post') body.set('client_secret', client.client_secret);
  }
  return getJson(endpoint, { method: 'POST', headers, body });
}

export async function refresh(session) {
  const old = session?.token?.refresh_token;
  if (!old) return null;
  const fresh = await tokenRequest(session, { grant_type: 'refresh_token', refresh_token: old, resource: session.resource });
  // a server may omit the refresh token when it does not rotate it
  session.token = { refresh_token: old, ...fresh };
  return session.token;
}

// An export is a one-off, so the access granted for it is revoked.
// Returns 'revoked', 'failed' or 'unsupported'.
export async function revoke(session) {
  if (!session?.token) return 'failed';
  if (!session.as?.revocation_endpoint) return 'unsupported';
  let ok = true;
  for (const [hint, value] of [
    ['refresh_token', session.token.refresh_token],
    ['access_token', session.token.access_token],
  ]) {
    if (!value) continue;
    try {
      await tokenRequest(session, { token: value, token_type_hint: hint }, session.as.revocation_endpoint);
    } catch {
      ok = false;
    }
  }
  return ok ? 'revoked' : 'failed';
}
