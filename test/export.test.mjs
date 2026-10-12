import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { startFakeKlue, makeCards } from './fake-klue.mjs';

// Plays the browser: follows the printed sign-in URL to the fake authorize
// endpoint, then delivers its redirect to the CLI's loopback listener.
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

async function run(fakeOpts, cliArgs = [], { token = false } = {}) {
  const fake = await startFakeKlue(fakeOpts);
  const out = await mkdtemp(join(tmpdir(), 'kek-'));
  const lines = [];
  const args = ['export', '--server', fake.url, '--out', out, '--no-browser', '--force', ...cliArgs];
  if (token) args.push('--token', fake.issueStaticToken());
  try {
    const meta = await main(args, browserLog(lines));
    return { meta, out, fake, lines };
  } finally {
    await fake.close();
  }
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : e.name.endsWith('.md') && e.name !== 'index.md' ? 1 : 0;
  }
  return n;
}

for (const paging of ['page', 'cursor', 'offset', 'single']) {
  for (const shape of ['text', 'structured', 'bare-array']) {
    test(`exports every item: ${paging} paging, ${shape} payload`, async () => {
      // a bare array carries no paging hints, so the page size is the only signal
      const { meta, out, fake } = await run({ paging, shape });
      if (paging === 'cursor' && shape === 'bare-array') {
        // nowhere to carry a cursor: the tool must say the export may be incomplete
        assert.equal(meta.counts.cards, 100);
        assert.match(meta.warnings.join(), /extract_cards: page 1 looked full but carried no way to the next page/);
        return;
      }
      assert.equal(meta.counts.cards, 250);
      assert.equal(meta.counts.battlecards, 12);
      const cards = await readJson(join(out, 'cards.json'));
      assert.deepEqual(cards.map((c) => c.id).sort(), makeCards().map((c) => String(c.id)).sort());
      assert.equal(await countFiles(join(out, 'markdown')), 262);
      assert.deepEqual(fake.state.revoked.sort(), ['access_token', 'refresh_token']);
      await rm(out, { recursive: true });
    });
  }
}

test('signs in with OAuth, PKCE and dynamic registration, then revokes', async () => {
  const { fake, lines, out } = await run({});
  assert.equal(fake.state.clients.size, 1);
  assert.ok(lines.some((l) => l.includes('Signed in.')));
  assert.ok(lines.some((l) => l.includes('Access token revoked.')));
  await rm(out, { recursive: true });
});

test('a personal access token skips the browser and is not revoked', async () => {
  const { meta, fake, out } = await run({}, [], { token: true });
  assert.equal(meta.counts.cards, 250);
  assert.equal(fake.state.clients.size, 0);
  assert.deepEqual(fake.state.revoked, []);
  await rm(out, { recursive: true });
});

test('handles SSE responses, prefixed tool names, a 429 and an expired token', async () => {
  const { meta, fake, out } = await run({ transport: 'sse', prefix: 'klue-cards_', flaky: true, expireFirstToken: true });
  assert.equal(meta.counts.cards, 250);
  assert.equal(meta.tools.cards.tool, 'klue-cards_extract_cards');
  assert.ok(fake.state.issued >= 2, 'refreshed the token');
  await rm(out, { recursive: true });
});

test('respects the page size maximum from the schema', async () => {
  const { fake, out } = await run({ paging: 'page' });
  const sizes = new Set(fake.state.calls.map((c) => c.args.per_page));
  assert.deepEqual([...sizes], [50]);
  await rm(out, { recursive: true });
});

test('Markdown keeps the content, front matter and grouping by competitor', async () => {
  const { out } = await run({});
  assert.ok((await readdir(join(out, 'markdown', 'cards', 'initech-co'))).length > 80);
  const files = await readdir(join(out, 'markdown', 'cards', 'globex'));
  const tricky = files.find((f) => f.startsWith('pricing-packaging-enterprise'));
  assert.ok(tricky, 'slugged a title with punctuation');
  const acme = join(out, 'markdown', 'cards', 'acme-analytics');
  const md = await readFile(join(acme, (await readdir(acme))[0]), 'utf8');
  assert.match(md, /^---\nschema: "calven-export\/v1"/);
  assert.match(md, /competitor: "Acme Analytics"/);
  assert.match(md, /## Talk track \d+/);
  assert.match(md, /\*\*price\*\*/);
  assert.match(md, /value\* & proof/);
  assert.match(md, /- Point A\n- Point B/);
  assert.match(md, /\[Source\]\(https:\/\/example\.com\/\d+\)/);
  const index = await readFile(join(out, 'markdown', 'index.md'), 'utf8');
  assert.match(index, /## Cards \(250\)/);
  assert.match(index, /### Initech & Co/);
  await rm(out, { recursive: true });
});

test('battlecards without a body field keep the full item in Markdown', async () => {
  const { out, meta } = await run({});
  assert.equal(meta.unmapped.battlecards, 12);
  const dir = join(out, 'markdown', 'battlecards', 'globex');
  const md = await readFile(join(dir, (await readdir(dir))[0]), 'utf8');
  assert.match(md, /```json\n\{\n {2}"id": "bc-/);
  assert.match(md, /"card_ids"/);
  await rm(out, { recursive: true });
});

test('archives every raw page verbatim', async () => {
  const { out } = await run({ paging: 'page' });
  const pages = await readdir(join(out, 'raw', 'extract_cards'));
  assert.equal(pages.length, 5); // 250 cards at 50 per page
  const first = await readJson(join(out, 'raw', 'extract_cards', pages[0]));
  assert.deepEqual(first.arguments, { per_page: 50, page: 1 });
  assert.equal(JSON.parse(first.result.content[0].text).cards.length, 50);
  await rm(out, { recursive: true });
});

test('an unknown required argument stops with a clear message, and --arg fills it', async () => {
  await assert.rejects(run({ required: ['board_id'] }), /needs arguments this tool does not fill in: board_id/);
  const { meta, fake, out } = await run({ required: ['board_id'] }, ['--arg', 'board_id=all']);
  assert.equal(meta.counts.cards, 250);
  assert.ok(fake.state.calls.every((c) => c.args.board_id === 'all'));
  await rm(out, { recursive: true });
});

test('refuses to write into a folder that is not empty', async () => {
  const fake = await startFakeKlue({});
  const out = await mkdtemp(join(tmpdir(), 'kek-'));
  await writeFile(join(out, 'keep.txt'), 'x');
  await assert.rejects(main(['export', '--server', fake.url, '--out', out, '--token', fake.issueStaticToken()], () => {}), /is not empty/);
  await fake.close();
  await rm(out, { recursive: true });
});

test('inspect writes the tool list and exports nothing', async () => {
  const fake = await startFakeKlue({});
  const out = await mkdtemp(join(tmpdir(), 'kek-'));
  const tools = await main(['inspect', '--server', fake.url, '--out', out, '--token', fake.issueStaticToken()], () => {});
  assert.equal(tools.length, 4); // two pages of tools/list
  const file = await readJson(join(out, 'klue-tools.json'));
  assert.deepEqual(file.tools.map((t) => t.name), ['search', 'fetch', 'extract_cards', 'extract_battlecards']);
  assert.equal(fake.state.calls.length, 0);
  await fake.close();
  await rm(out, { recursive: true });
});

test('a server without extraction tools fails and names the tools it has', async () => {
  await assert.rejects(run({ hideExtract: true }), /no cards or battlecards extraction tool\. Tools available: search, fetch/);
});

test('flags the origin of each item', async () => {
  const cards = makeCards(6);
  cards[1].source_url = 'https://news.example.com/a';
  cards[2].author = { name: 'Klue Research' };
  delete cards[3].author;
  const { meta, out } = await run({ cards });
  assert.deepEqual(meta.origin.cards, { customer: 3, klue_or_third_party: 2, unknown: 1 });
  assert.deepEqual(meta.origin.battlecards, { unknown: 12 });
  const saved = await readJson(join(out, 'cards.json'));
  assert.equal(saved[1].origin, 'klue_or_third_party');
  await rm(out, { recursive: true });
});
