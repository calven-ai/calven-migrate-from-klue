// Maps a vendor item onto the neutral calven-export schema and renders it as
// Markdown. The original item is always kept under `source`, so nothing the
// mapping misses is lost.

import { itemId } from './extract.mjs';

export const SCHEMA = 'calven-export/v1';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function pick(obj, paths) {
  for (const path of paths) {
    let v = obj;
    for (const k of path.split('.')) v = isObj(v) ? v[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const str = (v) => (v === undefined || v === null ? null : isObj(v) ? pick(v, ['name', 'title', 'email', 'id']) ?? null : String(v));

const looksLikeHtml = (s) => typeof s === 'string' && /<\/?[a-z][\s\S]*>/i.test(s);

const THIRD_PARTY_KEYS = [
  'source_url', 'sourceUrl', 'source', 'publisher', 'news', 'review', 'third_party', 'thirdParty',
  'is_third_party', 'isThirdParty', 'klue_content', 'klueContent', 'feed_item', 'feedItem',
];

// Customer data is what the team wrote; Klue Content is what Klue wrote or
// sourced (news, reviews). The split decides what may leave Klue later, so an
// item is only called customer-written when an author is named and nothing
// marks it as sourced.
export function originOf(item, author) {
  if (THIRD_PARTY_KEYS.some((k) => isObj(item) && item[k] !== undefined && item[k] !== null && item[k] !== false && item[k] !== '')) {
    return 'klue_or_third_party';
  }
  if (author && /\bklue\b/i.test(author)) return 'klue_or_third_party';
  if (author) return 'customer';
  return 'unknown';
}

export function normalize(item, kind) {
  const body = pick(item, [
    'html', 'body_html', 'bodyHtml', 'content_html', 'contentHtml', 'data.textHtml', 'data.html',
    'content', 'body', 'markdown', 'body_markdown', 'text', 'plain_text', 'plainText', 'content_text', 'data.text', 'summary', 'description',
  ]);
  const bodyText = typeof body === 'string' ? body : null;
  const competitorName = str(pick(item, ['competitor', 'rival', 'board', 'competitor_name', 'competitorName', 'rival_name', 'rivalName', 'board_name', 'boardName']));
  const competitorId = str(pick(item, ['competitor.id', 'rival.id', 'board.id', 'competitor_id', 'competitorId', 'rival_id', 'rivalId', 'board_id', 'boardId']));
  const tags = pick(item, ['tags', 'labels']);
  const author = str(pick(item, ['author', 'created_by', 'createdBy', 'author_name', 'authorName', 'owner'])) ?? null;

  return {
    schema: SCHEMA,
    source_system: 'klue',
    kind,
    id: itemId(item) ?? null,
    title: str(pick(item, ['title', 'name', 'headline', 'card_title', 'cardTitle', 'data.name'])) ?? null,
    competitor: competitorName || competitorId ? { id: competitorId ?? null, name: competitorName ?? null } : null,
    section: str(pick(item, ['section', 'lane', 'lane_name', 'laneName', 'tab', 'category'])) ?? null,
    body_html: looksLikeHtml(bodyText) ? bodyText : null,
    body_markdown: bodyText === null ? null : looksLikeHtml(bodyText) ? htmlToMarkdown(bodyText) : bodyText,
    tags: Array.isArray(tags) ? tags.map(str).filter(Boolean) : [],
    url: str(pick(item, ['url', 'permalink', 'link', 'web_url', 'webUrl', 'app_url', 'appUrl'])) ?? null,
    author,
    origin: originOf(item, author),
    created_at: str(pick(item, ['created_at', 'createdAt', 'created'])) ?? null,
    updated_at: str(pick(item, ['updated_at', 'updatedAt', 'last_updated', 'lastUpdated', 'modified_at', 'modifiedAt'])) ?? null,
    source: item,
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// Covers the HTML a card editor produces. Anything unusual is still in body_html.
export function htmlToMarkdown(html) {
  let s = html.replace(/\r/g, '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.trim()}\n\n`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `**${t.trim()}**` : ''));
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => (t.trim() ? `*${t.trim()}*` : ''));
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `[${t.trim() || href}](${href})`);
  s = s.replace(/<img\b[^>]*src="([^"]*)"[^>]*>/gi, (m, src) => `![${(m.match(/alt="([^"]*)"/i) || [])[1] || ''}](${src})`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t.replace(/<\/?p[^>]*>/gi, '').trim()}`);
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n\n> ${t.trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|table)>/gi, '\n\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function slug(s, max = 60) {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  // names Windows reserves for devices cannot be file names
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(out)) return `_${out}`;
  return out || 'untitled';
}

// JSON strings are valid YAML double-quoted scalars.
const yaml = (v) => JSON.stringify(v);

export function toMarkdown(record) {
  const front = [
    '---',
    `schema: ${yaml(record.schema)}`,
    `source_system: ${yaml(record.source_system)}`,
    `kind: ${yaml(record.kind)}`,
    `id: ${yaml(record.id)}`,
    `title: ${yaml(record.title)}`,
    `competitor: ${yaml(record.competitor?.name ?? null)}`,
    `section: ${yaml(record.section)}`,
    `tags: ${yaml(record.tags)}`,
    `url: ${yaml(record.url)}`,
    `author: ${yaml(record.author)}`,
    `origin: ${yaml(record.origin)}`,
    `created_at: ${yaml(record.created_at)}`,
    `updated_at: ${yaml(record.updated_at)}`,
    '---',
    '',
  ];
  const lines = [...front, `# ${record.title || `Untitled ${record.kind} ${record.id ?? ''}`.trim()}`, ''];
  if (record.body_markdown) {
    lines.push(record.body_markdown, '');
  } else {
    // No recognised body field: show the whole item so the file is complete.
    lines.push('The export did not recognise a body field for this item. The full item follows.', '', '```json', JSON.stringify(record.source, null, 2), '```', '');
  }
  return lines.join('\n');
}
