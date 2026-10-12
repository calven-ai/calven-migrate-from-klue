// A stand-in for Klue's MCP server and OAuth server, used by the tests. It
// mirrors the published metadata of mcp.app.klue.com (401 challenge, RFC 9728
// resource metadata, dynamic registration, PKCE, client_secret_post). The card
// payload shape is a guess, so each shape option is tested.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const COMPETITORS = [
  { id: 101, name: 'Acme Analytics' },
  { id: 102, name: 'Globex' },
  { id: 103, name: 'Initech & Co' },
];

export function makeCards(n = 250) {
  return Array.from({ length: n }, (_, i) => {
    const c = COMPETITORS[i % COMPETITORS.length];
    return {
      id: 5000 + i,
      title: i === 7 ? 'Pricing / Packaging: "Enterprise"' : `Card ${i + 1}`,
      board: { id: c.id, name: c.name },
      lane: i % 2 ? 'Strengths' : 'Objections',
      html: `<h2>Talk track ${i + 1}</h2><p>When they say <strong>price</strong>, say <em>value</em> &amp; proof.</p><ul><li>Point A</li><li>Point B</li></ul><p><a href="https://example.com/${i}">Source</a></p>`,
      tags: [{ name: 'tier-1' }],
      author: { name: 'Curator' },
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-09-01T00:00:00Z',
      url: `https://app.klue.com/card/${5000 + i}`,
    };
  });
}

export function makeBattlecards(n = 12) {
  return Array.from({ length: n }, (_, i) => ({
    id: `bc-${i}`,
    name: `${COMPETITORS[i % 3].name} battlecard`,
    rival: COMPETITORS[i % 3],
    sections: [{ title: 'Why we win', card_ids: [5000 + i] }],
  }));
}

const PAGING_SCHEMA = {
  page: { page: { type: 'integer', minimum: 1 }, per_page: { type: 'integer', maximum: 50 } },
  'page-nomax': { page: { type: 'integer', minimum: 1 }, per_page: { type: 'integer' } },
  'page-zero': { page: { type: 'integer', default: 0 }, per_page: { type: 'integer', maximum: 50 } },
  cursor: { cursor: { type: 'string' }, limit: { type: 'integer' } },
  'starting-after': { starting_after: { type: 'string' }, limit: { type: 'integer', maximum: 40 } },
  'starting-after-bare': { starting_after: { type: 'string' } },
  offset: { offset: { type: 'integer' }, limit: { type: 'integer', maximum: 40 } },
  single: {},
};

export async function startFakeKlue(options = {}) {
  const opts = {
    paging: 'page', // page | cursor | offset | single
    shape: 'text', // text (JSON in a text block) | structured | bare-array
    transport: 'json', // json | sse
    prefix: '', // e.g. 'klue-cards_' as listed in the Claude directory
    cards: makeCards(),
    battlecards: makeBattlecards(),
    expireFirstToken: false,
    invalidTokens: 0, // the first N access tokens are refused, to force refreshes
    rotateRefresh: true, // false: refresh responses omit refresh_token
    assignAuthMethod: null, // registration answers with this token_endpoint_auth_method
    flaky: false, // first tools/call answers 429
    expireEveryCalls: 0, // every Nth tools/call finds all access tokens expired
    expireSessionOnce: false, // first tools/call answers 404, as for an expired session
    capSize: null, // the server returns at most this many per page, whatever is asked
    extraText: false, // a prose block next to the JSON
    textOnly: false, // the tool answers in prose only
    battlecardsWithCards: false, // battlecard pages also list the cards they reference
    toolNames: null, // override the two extraction tool names
    errorPastEnd: false, // a page past the end answers with a tool error
    hideBattlecards: false, // the role has cards but no battlecards tool
    required: [],
    ...options,
  };
  const state = { clients: new Map(), codes: new Map(), tokens: new Set(), refresh: new Set(), revoked: [], calls: [], flakyLeft: opts.flaky ? 1 : 0, issued: 0, sessions: 0, expireLeft: opts.expireSessionOnce ? 1 : 0, tokenAuth: [] };
  if (opts.expireFirstToken) opts.invalidTokens = Math.max(opts.invalidTokens, 1);
  let base;

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });

  function issueTokens({ withRefresh = true } = {}) {
    state.issued++;
    const access = `at_${randomBytes(8).toString('hex')}`;
    if (state.issued > opts.invalidTokens) state.tokens.add(access);
    const out = { access_token: access, token_type: 'Bearer', expires_in: 7200, scope: 'content:read' };
    if (withRefresh) {
      out.refresh_token = `rt_${randomBytes(8).toString('hex')}`;
      state.refresh.add(out.refresh_token);
    }
    return out;
  }

  function page(list, args) {
    const cap = (n) => (opts.capSize ? Math.min(n, opts.capSize) : n);
    if (opts.paging === 'page' || opts.paging === 'page-nomax') {
      const size = cap(args.per_page || 25);
      const p = args.page || 1;
      return { items: list.slice((p - 1) * size, p * size), extra: { meta: { total: list.length, page: p } } };
    }
    if (opts.paging === 'page-zero') {
      const size = cap(args.per_page || 25);
      const p = args.page ?? 0;
      return { items: list.slice(p * size, (p + 1) * size), extra: {} };
    }
    if (opts.paging === 'starting-after-bare') {
      const start = args.starting_after ? list.findIndex((c) => String(c.id) === args.starting_after) + 1 : 0;
      return { items: list.slice(start, start + 25), extra: {} };
    }
    if (opts.paging === 'starting-after') {
      const size = cap(args.limit || 25);
      const start = args.starting_after ? list.findIndex((c) => String(c.id) === args.starting_after) + 1 : 0;
      return { items: list.slice(start, start + size), extra: { has_more: start + size < list.length } };
    }
    if (opts.paging === 'cursor') {
      const size = args.limit || 25;
      const start = args.cursor ? Number(Buffer.from(args.cursor, 'base64url').toString()) : 0;
      const end = start + size;
      return { items: list.slice(start, end), extra: { next_cursor: end < list.length ? Buffer.from(String(end)).toString('base64url') : null } };
    }
    if (opts.paging === 'offset') {
      const size = args.limit || 25;
      const off = args.offset || 0;
      return { items: list.slice(off, off + size), extra: { has_more: off + size < list.length } };
    }
    return { items: list, extra: {} };
  }

  function toolResult(key, items, extra) {
    if (opts.textOnly) return { content: [{ type: 'text', text: `## ${key}\n\n${items.map((i) => `- ${i.title || i.name}`).join('\n')}` }] };
    if (key === 'battlecards' && opts.battlecardsWithCards) extra = { ...extra, cards: opts.cards.slice(0, 3) };
    if (opts.extraText) return { content: [{ type: 'text', text: JSON.stringify({ [key]: items, ...extra }) }, { type: 'text', text: `Showing ${items.length} ${key}.` }] };
    if (opts.shape === 'structured') return { content: [{ type: 'text', text: `${items.length} ${key}` }], structuredContent: { [key]: items, ...extra } };
    if (opts.shape === 'bare-array') return { content: [{ type: 'text', text: JSON.stringify(items) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ [key]: items, ...extra }) }] };
  }

  async function handleMcp(req, res) {
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!state.tokens.has(auth)) {
      await readBody(req);
      return json(res, 401, { error: 'You need to sign in or sign up before continuing.' }, {
        'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    if (req.method === 'DELETE') return res.writeHead(200).end();
    const msg = JSON.parse(await readBody(req));
    if (!msg.id && msg.id !== 0) return res.writeHead(202).end();

    let result;
    const headers = {};
    if (msg.method === 'initialize') {
      state.sessions++;
      headers['Mcp-Session-Id'] = `sess-${state.sessions}`;
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-klue', version: '0' } };
    } else if (msg.method === 'tools/list') {
      const props = PAGING_SCHEMA[opts.paging];
      const names = opts.toolNames || { extract_cards: 'extract_cards', extract_battlecards: 'extract_battlecards' };
      const tool = (name) => ({ name: opts.prefix + (names[name] || name), inputSchema: { type: 'object', properties: { ...props, ...Object.fromEntries(opts.required.map((r) => [r, { type: 'string', description: `required ${r}` }])) }, required: opts.required } });
      // two pages of tools/list, to exercise its cursor
      result = msg.params?.cursor
        ? { tools: opts.hideExtract ? [] : opts.hideBattlecards ? [tool('extract_cards')] : [tool('extract_cards'), tool('extract_battlecards')] }
        : { tools: [tool('search'), tool('fetch')], nextCursor: 'more' };
    } else if (msg.method === 'tools/call') {
      state.toolCalls = (state.toolCalls || 0) + 1;
      if (opts.expireEveryCalls && state.toolCalls % opts.expireEveryCalls === 0) {
        state.tokens.clear();
        return json(res, 401, { error: 'expired' });
      }
      if (state.expireLeft > 0) {
        state.expireLeft--;
        return json(res, 404, { error: 'session not found' });
      }
      if (state.flakyLeft > 0) {
        state.flakyLeft--;
        return json(res, 429, { error: 'slow down' }, { 'Retry-After': '0' });
      }
      const { name, arguments: args = {} } = msg.params;
      state.calls.push({ name, args });
      const names = opts.toolNames || {};
      const reverse = Object.fromEntries(Object.entries(names).map(([k, v]) => [opts.prefix + v, k]));
      const bare = reverse[name] || name.slice(opts.prefix.length);
      if (bare === 'extract_cards' || bare === 'extract_battlecards') {
        const key = bare === 'extract_cards' ? 'cards' : 'battlecards';
        const { items, extra } = page(key === 'cards' ? opts.cards : opts.battlecards, args);
        result = opts.errorPastEnd && items.length === 0
          ? { content: [{ type: 'text', text: 'page out of range' }], isError: true }
          : toolResult(key, items, extra);
      } else {
        result = { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
      }
    } else {
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }

    const reply = { jsonrpc: '2.0', id: msg.id, result };
    if (opts.transport === 'sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } else {
      json(res, 200, reply, headers);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    try {
      if (url.pathname === '/mcp') return await handleMcp(req, res);
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['content:read'] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          revocation_endpoint: `${base}/oauth/revoke`,
          registration_endpoint: `${base}/oauth/register`,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/oauth/register') {
        const body = JSON.parse(await readBody(req));
        if (!body.redirect_uris?.length) return json(res, 400, { error: 'invalid_redirect_uri' });
        const client = { client_id: `c_${randomBytes(4).toString('hex')}`, client_secret: `s_${randomBytes(8).toString('hex')}`, ...body };
        if (opts.assignAuthMethod) client.token_endpoint_auth_method = opts.assignAuthMethod;
        state.clients.set(client.client_id, client);
        return json(res, 201, client);
      }
      if (url.pathname === '/oauth/authorize') {
        const p = url.searchParams;
        const client = state.clients.get(p.get('client_id'));
        if (!client || !client.redirect_uris.includes(p.get('redirect_uri')) || p.get('code_challenge_method') !== 'S256') {
          return json(res, 400, { error: 'invalid_request' });
        }
        const code = `code_${randomBytes(6).toString('hex')}`;
        state.codes.set(code, { client: client.client_id, challenge: p.get('code_challenge'), redirect: p.get('redirect_uri') });
        res.writeHead(302, { Location: `${p.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(p.get('state'))}` });
        return res.end();
      }
      if (url.pathname === '/oauth/token') {
        const p = new URLSearchParams(await readBody(req));
        let id = p.get('client_id');
        let secret = p.get('client_secret');
        let method = 'client_secret_post';
        const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
        if (basic) {
          [id, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent);
          method = 'client_secret_basic';
        }
        const client = state.clients.get(id);
        if (!client || client.client_secret !== secret) return json(res, 401, { error: 'invalid_client' });
        if ((client.token_endpoint_auth_method || 'client_secret_post') !== method) return json(res, 401, { error: 'invalid_client', error_description: `expected ${client.token_endpoint_auth_method}` });
        state.tokenAuth.push(method);
        if (p.get('grant_type') === 'authorization_code') {
          const entry = state.codes.get(p.get('code'));
          state.codes.delete(p.get('code'));
          const challenge = createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
          if (!entry || entry.challenge !== challenge || entry.redirect !== p.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, issueTokens());
        }
        if (p.get('grant_type') === 'refresh_token' && state.refresh.has(p.get('refresh_token'))) {
          if (opts.rotateRefresh) state.refresh.delete(p.get('refresh_token'));
          return json(res, 200, issueTokens({ withRefresh: opts.rotateRefresh }));
        }
        return json(res, 400, { error: 'invalid_grant' });
      }
      if (url.pathname === '/oauth/revoke') {
        const p = new URLSearchParams(await readBody(req));
        state.revoked.push(p.get('token_type_hint'));
        state.tokens.delete(p.get('token'));
        state.refresh.delete(p.get('token'));
        return res.writeHead(200).end();
      }
      res.writeHead(404).end();
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    state,
    issueStaticToken() {
      const t = `pat_${randomBytes(6).toString('hex')}`;
      state.tokens.add(t);
      return t;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
