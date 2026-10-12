// Pages through one extraction tool without knowing its exact schema ahead of
// time: the pagination style is read from the tool's input schema, and the
// item list and the next-page hint are read from each response.

import { createHash } from 'node:crypto';

const SERVER_CURSOR_KEYS = ['cursor', 'next_cursor', 'nextCursor', 'page_token', 'pageToken'];
const ITEM_CURSOR_KEYS = ['after', 'starting_after', 'startingAfter'];
const PAGE_KEYS = ['page', 'page_number', 'pageNumber'];
const OFFSET_KEYS = ['offset', 'skip', 'start'];
const SIZE_KEYS = ['per_page', 'perPage', 'page_size', 'pageSize', 'limit', 'size', 'count', 'max_results', 'maxResults'];
const LIST_KEYS = ['items', 'data', 'results', 'records', 'entries', 'nodes'];
const ID_KEYS = ['id', 'card_id', 'cardId', 'battlecard_id', 'battlecardId', 'uuid'];
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 5_000;

export class MissingArgumentsError extends Error {
  constructor(tool, missing) {
    super(
      `${tool.name} needs arguments this tool does not fill in: ${missing.map((m) => m.name).join(', ')}. ` +
        'Run `calven-migrate-from-klue inspect` and pass them with --arg name=value.',
    );
    this.missing = missing;
  }
}

const has = (obj, k) => obj && Object.prototype.hasOwnProperty.call(obj, k);
const first = (keys, obj) => keys.find((k) => has(obj, k));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function planPaging(tool, extraArgs = {}) {
  const props = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];
  const plan = {
    cursorKey: first(SERVER_CURSOR_KEYS, props) ?? first(ITEM_CURSOR_KEYS, props),
    pageKey: first(PAGE_KEYS, props),
    offsetKey: first(OFFSET_KEYS, props),
    sizeKey: first(SIZE_KEYS, props),
  };
  plan.itemCursor = ITEM_CURSOR_KEYS.includes(plan.cursorKey);
  plan.mode = plan.cursorKey ? 'cursor' : plan.pageKey ? 'page' : plan.offsetKey ? 'offset' : 'single';
  if (plan.sizeKey) {
    const max = props[plan.sizeKey].maximum;
    // an explicit --arg for the page size wins, for servers with an undeclared cap
    if (has(extraArgs, plan.sizeKey)) {
      const n = Number(extraArgs[plan.sizeKey]);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--arg ${plan.sizeKey} must be a positive whole number`);
      plan.size = n;
    } else {
      plan.size = Number.isFinite(max) ? Math.min(max, DEFAULT_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    }
  }
  if (plan.pageKey) {
    const p = props[plan.pageKey];
    plan.firstPage = p.minimum === 0 || p.default === 0 ? 0 : 1;
  }

  const handled = new Set([plan.cursorKey, plan.pageKey, plan.offsetKey, plan.sizeKey, ...Object.keys(extraArgs)]);
  const missing = required
    .filter((name) => !handled.has(name))
    .map((name) => ({ name, schema: props[name] || {} }));
  if (missing.length) throw new MissingArgumentsError(tool, missing);
  return plan;
}

// A tool result carries JSON as structuredContent or as text blocks. Prose
// next to JSON (a "Showing 100 cards" line) is dropped; a reply that is only
// prose is flagged, since it cannot be paged or mapped reliably.
export function parseToolResult(result) {
  if (result?.isError) {
    const text = (result.content || []).map((c) => c.text).filter(Boolean).join('\n');
    const err = new Error(`Tool returned an error: ${text || 'no detail'}`);
    err.toolError = true;
    throw err;
  }
  if (result?.structuredContent !== undefined && result.structuredContent !== null) {
    return { payload: result.structuredContent, textOnly: false };
  }

  const json = [];
  const prose = [];
  for (const block of result?.content || []) {
    const text = block.type === 'text' ? block.text : block.type === 'resource' ? block.resource?.text : undefined;
    if (typeof text !== 'string') continue;
    try {
      json.push(JSON.parse(text));
    } catch {
      prose.push(text);
    }
  }
  if (json.length) return { payload: json.length === 1 ? json[0] : json, textOnly: false };
  if (prose.length) return { payload: { text: prose.join('\n\n') }, textOnly: true };
  return { payload: null, textOnly: false };
}

export const itemId = (item) => {
  if (!isObj(item)) return undefined;
  for (const k of ID_KEYS) {
    const v = item[k];
    if (typeof v === 'string' && v !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
};

const listKeysFor = (kind) => [`${kind}s`, ...LIST_KEYS];
const hasListKey = (v, keys) => isObj(v) && keys.some((k) => Array.isArray(v[k]));

// kind is 'card' or 'battlecard': the matching list key wins, so a battlecard
// response that also lists the cards it references exports battlecards.
export function extractItems(payload, kind, depth = 0) {
  const keys = listKeysFor(kind);
  if (Array.isArray(payload)) {
    // several JSON blocks, each a page object: collapse into their items
    if (payload.length && payload.every((p) => hasListKey(p, keys))) {
      return payload.flatMap((p) => extractItems(p, kind, depth + 1));
    }
    return payload.filter(isObj);
  }
  if (!isObj(payload)) return [];
  const key = keys.find((k) => Array.isArray(payload[k]));
  if (key) return payload[key].filter(isObj);
  if (depth < 2) {
    for (const k of keys) {
      if (isObj(payload[k])) {
        const nested = extractItems(payload[k], kind, depth + 1);
        if (nested.length) return nested;
      }
    }
  }
  if (itemId(payload) !== undefined || has(payload, 'title') || has(payload, 'name')) return [payload];
  return [];
}

function dig(obj, paths) {
  for (const path of paths) {
    let v = obj;
    for (const k of path.split('.')) v = isObj(v) ? v[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const pageObject = (payload) => (Array.isArray(payload) ? payload.find(isObj) : payload);

export function nextCursorOf(payload) {
  const p = pageObject(payload);
  if (!isObj(p)) return undefined;
  const v = dig(p, [
    'nextCursor', 'next_cursor', 'next_page_token', 'nextPageToken',
    'pagination.next_cursor', 'pagination.nextCursor', 'meta.next_cursor', 'meta.nextCursor',
    'page_info.end_cursor', 'pageInfo.endCursor',
  ]);
  return typeof v === 'string' || typeof v === 'number' ? v : undefined;
}

export function totalsOf(payload) {
  const p = pageObject(payload);
  if (!isObj(p)) return {};
  const num = (v) => (v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return {
    total: num(dig(p, ['total', 'total_count', 'totalCount', 'meta.total', 'meta.total_count', 'pagination.total', 'pagination.total_count'])),
    totalPages: num(dig(p, ['total_pages', 'totalPages', 'meta.total_pages', 'pagination.total_pages', 'pagination.totalPages'])),
    hasMore: dig(p, ['has_more', 'hasMore', 'has_next_page', 'hasNextPage', 'pagination.has_more', 'meta.has_more', 'page_info.has_next_page', 'pageInfo.hasNextPage']),
  };
}

const isClientError = (err) => err.toolError || err.rpc || (err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status));
const pagesPastEnd = (plan, n, err) => n > 1 && (plan.mode === 'page' || plan.mode === 'offset' || plan.itemCursor) && isClientError(err);

// Calls the tool page by page. onPage receives each raw result before it is
// interpreted, so the archive is complete even if parsing fails.
export async function extractAll(client, tool, { kind, extraArgs = {}, onPage = () => {}, log = () => {} } = {}) {
  const plan = planPaging(tool, extraArgs);
  const items = [];
  const seen = new Set();
  const warnings = [];
  let cursor;
  let page = plan.firstPage;
  let offset = 0;
  const signatures = new Set();
  let reportedTotal;
  let stopped = false;

  for (let n = 1; n <= MAX_PAGES; n++) {
    const args = { ...extraArgs };
    if (plan.sizeKey) args[plan.sizeKey] = plan.size;
    if (plan.mode === 'cursor' && cursor !== undefined) args[plan.cursorKey] = cursor;
    if (plan.mode === 'page') args[plan.pageKey] = page;
    if (plan.mode === 'offset') args[plan.offsetKey] = offset;

    let result;
    let parsed;
    try {
      result = await client.callTool(tool.name, args);
      parsed = parseToolResult(result);
    } catch (err) {
      // Asking past the last page is how page and offset paging finds the end;
      // a server may answer that with an error rather than an empty page.
      if (!pagesPastEnd(plan, n, err)) throw err;
      warnings.push(`${tool.name}: page ${n} answered with an error, treated as the end of the data (${err.message.slice(0, 120)})`);
      stopped = true;
      break;
    } finally {
      if (result !== undefined) await onPage(n, args, result);
    }
    const { payload, textOnly } = parsed;
    if (textOnly && n > 1) {
      // prose after real pages ("No more results") marks the end, not a card
      warnings.push(`${tool.name}: page ${n} came back as text, not data, so it was treated as the end. Check raw/.`);
      stopped = true;
      break;
    }
    if (textOnly) warnings.push(`${tool.name}: page ${n} came back as text, not data. It is saved as one item; check raw/ for the full reply.`);
    const batch = textOnly ? [payload] : extractItems(payload, kind);

    // a server that ignores the paging argument returns a page seen before
    const signature = createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    if (batch.length && signatures.has(signature)) {
      warnings.push(`${tool.name}: page ${n} repeated an earlier page, so paging stopped there`);
      stopped = true;
      break;
    }
    signatures.add(signature);

    let fresh = 0;
    for (const item of batch) {
      const id = itemId(item);
      if (id !== undefined && seen.has(id)) continue;
      if (id !== undefined) seen.add(id);
      items.push(item);
      fresh++;
    }
    log(`  ${tool.name}: page ${n}, ${batch.length} items (${items.length} total)`);

    const next = nextCursorOf(payload);
    const { total, totalPages, hasMore } = totalsOf(payload);
    if (total !== undefined) reportedTotal = total;

    if (batch.length === 0 || textOnly) {
      stopped = true;
      break;
    }
    if (fresh === 0) {
      warnings.push(`${tool.name}: page ${n} repeated earlier items, so paging stopped there`);
      stopped = true;
      break;
    }
    if (plan.mode === 'single') {
      if (next !== undefined || hasMore === true) warnings.push(`${tool.name}: the response says there is more, but the tool takes no paging argument`);
      stopped = true;
      break;
    }
    if (plan.mode === 'cursor') {
      if (hasMore === false) { stopped = true; break; }
      let nextCursor = next;
      // after / starting_after take the id of the last item seen; keep going
      // until a page comes back empty unless the server says it is done
      if (nextCursor === undefined && plan.itemCursor) nextCursor = itemId(batch[batch.length - 1]);
      if (nextCursor === undefined || nextCursor === cursor) {
        if (hasMore === true || (plan.sizeKey && batch.length >= plan.size)) {
          warnings.push(`${tool.name}: page ${n} looked full but carried no way to the next page, so the export may be incomplete. Check raw/.`);
        }
        stopped = true;
        break;
      }
      cursor = nextCursor;
      continue;
    }

    // page and offset modes: trust the server's hints, then ask for the next
    // page until one comes back empty
    if (hasMore === false) { stopped = true; break; }
    if (total !== undefined && items.length >= total) { stopped = true; break; }
    if (totalPages !== undefined && page - plan.firstPage + 1 >= totalPages) { stopped = true; break; }
    page++;
    offset += batch.length;
  }

  if (!stopped) warnings.push(`${tool.name}: stopped at the ${MAX_PAGES}-page safety limit`);
  if (reportedTotal !== undefined && items.length < reportedTotal) {
    warnings.push(`${tool.name}: the server reported ${reportedTotal} items but ${items.length} were exported`);
  }
  return { items, plan, warnings };
}
