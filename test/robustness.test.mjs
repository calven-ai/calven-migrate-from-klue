// Failure modes found in review: each one used to lose items or hang silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.mjs';
import { startLoopback, assertSafeUrl } from '../src/oauth.mjs';
import { startFakeKlue, makeCards } from './fake-klue.mjs';

function browserLog(lines) {
  return (m) => {
    lines.push(m);
    const url = m.match(/https?:\/\/\S+oauth\/authorize\S+/)?.[0];
    if (!url) return;
    setTimeout(async () => {
      const res = await fetch(url, { redirect: 'manual' });
      await fetch(res.headers.get('location'));
    }, 10);
  };
}

async function run(fakeOpts, cliArgs = [], { token = false, out } = {}) {
  const fake = await startFakeKlue(fakeOpts);
  out ||= await mkdtemp(join(tmpdir(), 'mfk-'));
  const lines = [];
  const args = ['--server', fake.url, '--out', out, '--no-browser', '--force', ...cliArgs];
  if (token) args.push('--token', fake.issueStaticToken());
  try {
    const meta = await main(args, browserLog(lines));
    return { meta, out, fake, lines };
  } finally {
    await fake.close();
  }
}
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('a server that serves smaller pages than asked still exports everything', async () => {
  const { meta, out } = await run({ paging: 'page-nomax', capSize: 50 });
  assert.equal(meta.counts.cards, 250);
  assert.deepEqual(meta.warnings, []);
  await rm(out, { recursive: true });
});

test('without paging hints, a short page does not end the export', async () => {
  const { meta, out } = await run({ paging: 'page-nomax', capSize: 30, shape: 'bare-array' });
  assert.equal(meta.counts.cards, 250);
  await rm(out, { recursive: true });
});

test('prose next to the JSON is ignored and the cursor still followed', async () => {
  const { meta, out } = await run({ paging: 'cursor', extraText: true });
  assert.equal(meta.counts.cards, 250);
  assert.equal(meta.counts.battlecards, 12);
  await rm(out, { recursive: true });
});

test('a prose-only reply is kept as one item and flagged', async () => {
  const { meta, out } = await run({ paging: 'single', textOnly: true });
  assert.equal(meta.counts.cards, 1);
  assert.match(meta.warnings.join('\n'), /extract_cards: page 1 came back as text/);
  const [card] = await readJson(join(out, 'cards.json'));
  assert.match(card.body_markdown, /- Card 1\n- Card 2/);
  await rm(out, { recursive: true });
});

test('items without ids are all kept', async () => {
  const cards = makeCards(120).map(({ id, ...rest }) => ({ ...rest, id: null }));
  const { meta, out } = await run({ paging: 'page', cards });
  assert.equal(meta.counts.cards, 120);
  await rm(out, { recursive: true });
});

test('a battlecard page that also lists cards exports battlecards', async () => {
  const { out } = await run({ battlecardsWithCards: true });
  const bcs = await readJson(join(out, 'battlecards.json'));
  assert.equal(bcs.length, 12);
  assert.ok(bcs.every((b) => String(b.id).startsWith('bc-')));
  await rm(out, { recursive: true });
});

test('zero-based pages start at page 0', async () => {
  const { meta, fake, out } = await run({ paging: 'page-zero' });
  assert.equal(meta.counts.cards, 250);
  assert.equal(fake.state.calls[0].args.page, 0);
  await rm(out, { recursive: true });
});

test('starting_after paging follows the last item id', async () => {
  const { meta, out } = await run({ paging: 'starting-after' });
  assert.equal(meta.counts.cards, 250);
  assert.deepEqual(meta.warnings, []);
  await rm(out, { recursive: true });
});

test('a server-reported total that is not reached is a warning', async () => {
  const cards = makeCards(60);
  const fake = await startFakeKlue({ paging: 'page', cards });
  const out = await mkdtemp(join(tmpdir(), 'mfk-'));
  // the server claims 60, but the first page is all it ever returns
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    if (!init?.body?.includes?.('"page":2')) return res;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(init.body).id, result: { content: [{ type: 'text', text: '{"cards":[],"meta":{"total":60}}' }] } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const meta = await main(['--server', fake.url, '--out', out, '--token', fake.issueStaticToken(), '--arg', 'per_page=20'], () => {});
    assert.equal(meta.counts.cards, 20);
    assert.match(meta.warnings.join('\n'), /reported 60 items but 20 were exported/);
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
    await rm(out, { recursive: true });
  }
});

test('--arg sets the page size, and per-tool args do not leak to the other tool', async () => {
  const { fake, out } = await run({ paging: 'page' }, ['--arg', 'per_page=20', '--arg', 'cards.only=1', '--arg', 'extract_cards.mine=2']);
  const cardCalls = fake.state.calls.filter((c) => c.name === 'extract_cards');
  const bcCalls = fake.state.calls.filter((c) => c.name === 'extract_battlecards');
  assert.ok(cardCalls.every((c) => c.args.per_page === 20 && c.args.mine === 2));
  assert.ok(bcCalls.every((c) => c.args.mine === undefined && c.args.only === undefined));
  await rm(out, { recursive: true });
});

test('an expired session is re-initialized and the call retried', async () => {
  const { meta, fake, out } = await run({ expireSessionOnce: true }, [], { token: true });
  assert.equal(meta.counts.cards, 250);
  assert.equal(fake.state.sessions, 2);
  await rm(out, { recursive: true });
});

test('a refresh without a new refresh token keeps the old one', async () => {
  const { meta, fake, out } = await run({ expireEveryCalls: 3, rotateRefresh: false });
  assert.equal(meta.counts.cards, 250);
  assert.ok(fake.state.issued >= 3, `issued ${fake.state.issued}`);
  await rm(out, { recursive: true });
});

test('the auth method the server assigns at registration is used', async () => {
  const { meta, fake, out } = await run({ assignAuthMethod: 'client_secret_basic' });
  assert.equal(meta.counts.cards, 250);
  assert.ok(fake.state.tokenAuth.length > 0 && fake.state.tokenAuth.every((m) => m === 'client_secret_basic'));
  await rm(out, { recursive: true });
});

test('a refused static token fails clearly', async () => {
  const fake = await startFakeKlue({});
  await assert.rejects(main(['--server', fake.url, '--token', 'wrong', '--out', await mkdtemp(join(tmpdir(), 'mfk-'))], () => {}), /failed with 401/);
  await fake.close();
});

test('a tool name from the server cannot steer a path outside the export', async () => {
  const { out } = await run({ toolNames: { extract_cards: '../../escape_extract_cards', extract_battlecards: 'extract_battlecards' } });
  const raw = await readdir(join(out, 'raw'));
  assert.ok(raw.includes('__.._escape_extract_cards'), raw.join());
  assert.equal((await readdir(resolve(out, '..'))).includes('escape_extract_cards'), false);
  await rm(out, { recursive: true });
});

test('--force replaces an earlier export instead of mixing with it', async () => {
  const out = await mkdtemp(join(tmpdir(), 'mfk-'));
  await run({ paging: 'page', cards: makeCards(250) }, [], { out });
  await writeFile(join(out, 'notes.txt'), 'mine');
  const { meta } = await run({ paging: 'page', cards: makeCards(60) }, [], { out });
  assert.equal(meta.counts.cards, 60);
  assert.equal((await readdir(join(out, 'raw', 'extract_cards'))).length, 2);
  assert.equal((await readJson(join(out, 'cards.json'))).length, 60);
  assert.equal(await readFile(join(out, 'notes.txt'), 'utf8'), 'mine');
  await rm(out, { recursive: true });
});

test('front matter quotes titles safely', async () => {
  const { out } = await run({});
  const dir = join(out, 'markdown', 'cards', 'globex');
  const file = (await readdir(dir)).find((f) => f.startsWith('pricing-packaging-enterprise'));
  const md = await readFile(join(dir, file), 'utf8');
  assert.match(md, /^title: "Pricing \/ Packaging: \\"Enterprise\\""$/m);
  await rm(out, { recursive: true });
});

test('the loopback page is plain text, ignores stray requests and waits for the real one', async () => {
  const loop = await startLoopback({ timeoutMs: 5000 });
  const code = loop.waitForCode('good');
  const base = `http://127.0.0.1:${loop.port}/callback`;
  const stray = await fetch(`${base}?state=bad&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  assert.equal(stray.status, 400);
  assert.match(stray.headers.get('content-type'), /^text\/plain/);
  assert.doesNotMatch(await stray.text(), /<script>/);
  await fetch(`${base}?state=good&code=abc`);
  assert.equal(await code, 'abc');
});

test('the loopback reports an error for the right state without echoing it', async () => {
  const loop = await startLoopback({ timeoutMs: 5000 });
  const code = loop.waitForCode('s');
  const res = await fetch(`http://127.0.0.1:${loop.port}/callback?state=s&error=%3Cb%3Ex`);
  assert.doesNotMatch(await res.text(), /<b>/);
  await assert.rejects(code, /Authorization failed: <b>x/);
});

test('only https sign-in links, or http on this machine, are opened', () => {
  assert.ok(assertSafeUrl('https://app.klue.com/oauth/authorize', 'x'));
  assert.ok(assertSafeUrl('http://127.0.0.1:5000/a', 'x'));
  assert.throws(() => assertSafeUrl('http://evil.example/a', 'x'), /must use https/);
  assert.throws(() => assertSafeUrl('file:///etc/passwd', 'x'), /must use https/);
  assert.throws(() => assertSafeUrl('javascript:alert(1)', 'x'), /must use https/);
});

test('inspect will not overwrite a tool list without --force', async () => {
  const fake = await startFakeKlue({});
  const out = await mkdtemp(join(tmpdir(), 'mfk-'));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'klue-tools.json'), '{}');
  await assert.rejects(main(['inspect', '--server', fake.url, '--out', out, '--token', fake.issueStaticToken()], () => {}), /already exists/);
  await fake.close();
  await rm(out, { recursive: true });
});

test('an error on a page past the end is the end of the data, not a failure', async () => {
  const { meta, out } = await run({ paging: 'page-nomax', capSize: 30, shape: 'bare-array', errorPastEnd: true });
  assert.equal(meta.counts.cards, 250);
  assert.match(meta.warnings.join('\n'), /answered with an error, treated as the end of the data/);
  assert.ok((await readdir(join(out, 'markdown', 'cards'))).length > 0);
  await rm(out, { recursive: true });
});

test('an error on the first page still fails the export', async () => {
  await assert.rejects(run({ paging: 'page', cards: [], errorPastEnd: true }), /page out of range/);
});

test('starting_after with no size or has_more pages until empty', async () => {
  const { meta, out } = await run({ paging: 'starting-after-bare' });
  assert.equal(meta.counts.cards, 250);
  assert.equal(meta.counts.battlecards, 12);
  await rm(out, { recursive: true });
});

test('a missing battlecards tool fails before any card is fetched', async () => {
  const fake = await startFakeKlue({ hideBattlecards: true });
  await assert.rejects(main(['--server', fake.url, '--token', fake.issueStaticToken(), '--out', await mkdtemp(join(tmpdir(), 'mfk-'))], () => {}), /no battlecards extraction tool/);
  assert.equal(fake.state.calls.length, 0);
  await fake.close();
});

test('--force never clears a folder this tool did not export to', async () => {
  const out = await mkdtemp(join(tmpdir(), 'mfk-'));
  await mkdir(join(out, 'markdown'));
  await writeFile(join(out, 'markdown', 'notes.md'), 'mine');
  const fake = await startFakeKlue({});
  await assert.rejects(main(['--server', fake.url, '--token', fake.issueStaticToken(), '--out', out, '--force'], () => {}), /does not hold an earlier export/);
  assert.equal(await readFile(join(out, 'markdown', 'notes.md'), 'utf8'), 'mine');
  assert.equal(fake.state.calls.length, 0);
  await fake.close();
  await rm(out, { recursive: true });
});

test('a page size that is not a positive whole number is refused', async () => {
  await assert.rejects(run({ paging: 'page' }, ['--arg', 'per_page=abc'], { token: true }), /must be a positive whole number/);
});

test('a server cycling between pages without ids stops instead of looping', async () => {
  const cards = makeCards(50).map(({ id, ...rest }) => rest);
  const fake = await startFakeKlue({ paging: 'cursor', cards });
  const out = await mkdtemp(join(tmpdir(), 'mfk-'));
  const realFetch = globalThis.fetch;
  let n = 0;
  // the cursor alternates A, B, A, B: pages repeat but never with the previous one
  globalThis.fetch = async (url, init) => {
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (body?.method !== 'tools/call' || body.params.name !== 'extract_cards') return realFetch(url, init);
    n++;
    const items = n % 2 ? cards.slice(0, 25) : cards.slice(25, 50);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ cards: items, next_cursor: n % 2 ? 'B' : 'A' }) }] } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const meta = await main(['--server', fake.url, '--out', out, '--token', fake.issueStaticToken()], () => {});
    assert.equal(meta.counts.cards, 50);
    assert.ok(n <= 4, `called ${n} times`);
  } finally {
    globalThis.fetch = realFetch;
    await fake.close();
    await rm(out, { recursive: true });
  }
});
