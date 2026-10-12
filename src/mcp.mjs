// A minimal MCP client for the Streamable HTTP transport: JSON-RPC over POST,
// answered as JSON or as a server-sent event stream.

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRY_WAIT_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class McpClient {
  constructor({ url, getToken, onUnauthorized, clientInfo, retries = 4, timeoutMs = REQUEST_TIMEOUT_MS }) {
    this.url = url;
    this.getToken = getToken;
    this.onUnauthorized = onUnauthorized;
    this.clientInfo = clientInfo;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const token = this.getToken();
    if (token) h.Authorization = `Bearer ${token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion;
    return h;
  }

  // Each attempt gets its own timer; retries go back through post().
  async post(message, state = {}) {
    // the timeout restarts whenever data arrives, so a long streamed reply is fine
    const controller = new AbortController();
    let timer;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`no response within ${this.timeoutMs / 1000}s`)), this.timeoutMs);
    };
    touch();
    try {
      return await this.send(message, state, controller, touch);
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message, state, controller, touch) {
    const { refreshed = false, reinitialized = false, attempt = 0 } = state;
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (err) {
      if (attempt < this.retries) {
        await sleep(1000 * 2 ** attempt);
        return this.post(message, { ...state, attempt: attempt + 1 });
      }
      throw new Error(`MCP ${message.method} failed: ${err.message}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401 && !refreshed && this.onUnauthorized && (await this.onUnauthorized())) {
      await res.body?.cancel();
      return this.post(message, { ...state, refreshed: true });
    }
    // an expired session answers 404: start a new one and send the request again
    if (res.status === 404 && this.sessionId && !reinitialized && message.method !== 'initialize') {
      await res.body?.cancel();
      this.sessionId = null;
      await this.initialize();
      return this.post(message, { ...state, reinitialized: true });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
      await res.body?.cancel();
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
      return this.post(message, { ...state, attempt: attempt + 1 });
    }
    if (res.status === 202) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`MCP ${message.method} failed with ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const type = res.headers.get('content-type') || '';
    try {
      if (type.includes('text/event-stream')) return await readSseStream(res, message.id, touch);
      return parseJsonReply(await res.text(), message.id);
    } catch (err) {
      throw new Error(`MCP ${message.method} failed while reading the reply: ${err.message}`);
    }
  }

  async request(method, params) {
    const id = this.nextId++;
    const reply = await this.post({ jsonrpc: '2.0', id, method, params });
    if (!reply) throw new Error(`MCP ${method} returned no response`);
    if (reply.error) {
      const err = new Error(`MCP ${method} error ${reply.error.code}: ${reply.error.message}`);
      err.rpc = reply.error;
      throw err;
    }
    return reply.result;
  }

  async notify(method, params) {
    await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    this.protocolVersion = result.protocolVersion || PROTOCOL_VERSION;
    this.serverInfo = result.serverInfo;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch {
      // the server expires idle sessions anyway
    }
  }
}

function matchEvent(block, id) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  for (const m of Array.isArray(msg) ? msg : [msg]) if (m.id === id && ('result' in m || 'error' in m)) return m;
  return null;
}

// Reads events as they arrive and stops at the response, so a server that
// keeps the stream open afterwards does not stall the export.
function parseJsonReply(text, id) {
  if (!text) return null;
  const body = JSON.parse(text);
  return Array.isArray(body) ? body.find((m) => m.id === id) : body;
}

export async function readSseStream(res, id, onData = () => {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) onData();
      if (value) buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : blocks.pop();
      for (const block of blocks) {
        const m = matchEvent(block, id);
        if (m) return m;
      }
      if (done) return null;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function readSse(text, id) {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const m = matchEvent(block, id);
    if (m) return m;
  }
  return null;
}
