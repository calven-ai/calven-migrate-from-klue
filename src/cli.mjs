import { parseArgs } from 'node:util';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { authorize, refresh, revoke } from './oauth.mjs';
import { McpClient } from './mcp.mjs';
import { extractAll, MissingArgumentsError } from './extract.mjs';
import { normalize, slug, toMarkdown, SCHEMA } from './normalize.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_SERVER = 'https://mcp.app.klue.com/mcp';
const DEFAULT_SCOPE = 'content:read';
const KINDS = [
  { kind: 'card', plural: 'cards', match: /(^|[_.\-])extract_cards$/ },
  { kind: 'battlecard', plural: 'battlecards', match: /(^|[_.\-])extract_battlecards$/ },
];

export const DISCLAIMER = `This is an independent open-source project by Calven AI, LLC. It is not affiliated with, endorsed by or sponsored by Klue Labs Inc. Klue is a trademark of Klue Labs Inc., used here only to identify the service this tool works with. The tool runs on your machine, signs in with your own Klue account through Klue's official MCP server, and writes files only to your computer. Nothing is sent to Calven. Use it in line with your agreement with Klue: content that Klue wrote or sourced for you (for example news and review excerpts) is licensed to you for internal use during your subscription, not owned by you. Provided under the MIT License, without warranty; check the export against your Klue workspace before relying on it.`;

const HELP = `calven-migrate-from-klue ${pkg.version}

Migrate from Klue: export your Klue cards and battlecards to Markdown and JSON files on your own machine.

Usage
  calven-migrate-from-klue [export] [options]   export everything (default)
  calven-migrate-from-klue inspect [options]    write the server's tool list to a file, export nothing

Options
  --out <dir>          output folder (default ./klue-export-<date>)
  --token <token>      use a Klue personal access token instead of browser sign-in;
                       prefer setting KLUE_TOKEN, which stays out of shell history
  --arg <name=value>   extra tool argument; prefix with a tool name to target one tool,
                       e.g. --arg extract_cards.include_drafts=true (repeatable)
  --no-browser         print the sign-in URL instead of opening it
  --server <url>       MCP server URL (default ${DEFAULT_SERVER})
  --scope <scopes>     OAuth scopes (default ${DEFAULT_SCOPE})
  --force              replace an earlier export in the --out folder, or an existing klue-tools.json
  -h, --help           show this help
  -v, --version        show the version

${DISCLAIMER}
`;

function parseExtraArgs(list) {
  const shared = Object.create(null);
  const perTool = Object.create(null);
  for (const entry of list || []) {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new Error(`--arg expects name=value, got "${entry}"`);
    const key = entry.slice(0, eq);
    const raw = entry.slice(eq + 1);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    const dot = key.lastIndexOf('.');
    if (dot > 0) (perTool[key.slice(0, dot)] ||= Object.create(null))[key.slice(dot + 1)] = value;
    else shared[key] = value;
  }
  // extract_cards.x targets klue-cards_extract_cards too, but never extract_battlecards
  const matches = (toolName, t) => toolName === t || toolName.endsWith(`_${t}`) || toolName.endsWith(`.${t}`) || toolName.endsWith(`-${t}`);
  return (toolName) =>
    Object.entries(perTool)
      .filter(([t]) => matches(toolName, t))
      .reduce((acc, [, values]) => ({ ...acc, ...values }), { ...shared });
}

const OUTPUTS = ['raw', 'markdown', 'cards.json', 'battlecards.json', 'manifest.json', 'tools.json'];
const MARKER = '.calven-migrate-from-klue';

// --force replaces only an earlier export, recognised by the marker file this
// tool writes first, so stale pages cannot mix with a new run and an unrelated
// folder is never touched.
async function prepareOutDir(dir, force) {
  await mkdir(dir, { recursive: true });
  const entries = (await readdir(dir)).filter((e) => e !== MARKER && e !== '.DS_Store');
  if (entries.length) {
    const ours = await stat(join(dir, MARKER)).catch(() => null);
    if (!force || !ours) {
      throw new Error(
        ours
          ? `${dir} holds an earlier export. Pass --force to replace it, or choose another --out folder.`
          : `${dir} is not empty and does not hold an earlier export. Choose another --out folder.`,
      );
    }
    for (const name of OUTPUTS) await rm(join(dir, name), { recursive: true, force: true });
  }
  await writeFile(join(dir, MARKER), 'Written by calven-migrate-from-klue. --force may replace this folder\'s export.\n');
}

const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);

// One record at a time, so a large workspace never builds one giant string.
async function writeJsonArray(path, records) {
  const fh = await open(path, 'w');
  try {
    await fh.write('[\n');
    for (let i = 0; i < records.length; i++) {
      const json = JSON.stringify(records[i], null, 2).replace(/^/gm, '  ');
      await fh.write(`${json}${i < records.length - 1 ? ',' : ''}\n`);
    }
    await fh.write(']\n');
  } finally {
    await fh.close();
  }
}

// Tool names come from the server; never let one steer a path.
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_') || 'tool';
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

async function connect(opts, log) {
  let session = null;
  let staticToken = opts.token || process.env.KLUE_TOKEN || null;
  if (!staticToken) {
    session = await authorize({
      serverUrl: opts.server,
      scope: opts.scope,
      clientName: 'calven-migrate-from-klue',
      browser: opts.browser,
      log,
    });
    log('Signed in.');
  }
  const client = new McpClient({
    url: opts.server,
    clientInfo: { name: 'calven-migrate-from-klue', version: pkg.version },
    getToken: () => staticToken || session?.token?.access_token,
    onUnauthorized: async () => {
      if (!session) return false;
      try {
        return Boolean(await refresh(session));
      } catch (err) {
        log(`Refreshing the access token failed: ${err.message}`);
        return false;
      }
    },
  });
  try {
    await client.initialize();
  } catch (err) {
    await disconnect({ client, session }, log);
    throw err;
  }
  return { client, session };
}

async function disconnect({ client, session }, log) {
  await client?.close();
  if (!session) return;
  const outcome = await revoke(session);
  if (outcome === 'revoked') log('Access token revoked.');
  else if (outcome === 'unsupported') log('Note: the server offers no way to revoke the access token; it expires on its own.');
  else log('Note: revoking the access token failed; it expires on its own.');
}

async function writeExport(outDir, groups, meta) {
  const mdRoot = join(outDir, 'markdown');
  const usedPaths = new Set();
  const index = ['# Klue export', '', `Exported ${meta.exported_at} with calven-migrate-from-klue ${pkg.version}.`, ''];

  for (const { kind, plural, records } of groups) {
    await writeJsonArray(join(outDir, `${plural}.json`), records);
    index.push(`## ${plural[0].toUpperCase()}${plural.slice(1)} (${records.length})`, '');
    const byCompetitor = new Map();
    for (const r of records) {
      const group = oneLine(r.competitor?.name || r.competitor?.id || 'No competitor');
      if (!byCompetitor.has(group)) byCompetitor.set(group, []);
      byCompetitor.get(group).push(r);
    }
    for (const [competitor, list] of [...byCompetitor].sort(([a], [b]) => a.localeCompare(b))) {
      const dir = join(mdRoot, plural, slug(competitor));
      await mkdir(dir, { recursive: true });
      index.push(`### ${competitor}`, '');
      for (const r of list) {
        let name = `${slug(r.title || kind)}${r.id ? `-${slug(r.id, 40)}` : ''}`;
        let rel = join(plural, slug(competitor), `${name}.md`);
        for (let i = 2; usedPaths.has(rel); i++) rel = join(plural, slug(competitor), `${name}-${i}.md`);
        usedPaths.add(rel);
        await writeFile(join(mdRoot, rel), toMarkdown(r));
        index.push(`- [${oneLine(r.title || `Untitled ${kind}`).replace(/[[\]]/g, '')}](${rel.split('\\').join('/')})`);
      }
      index.push('');
    }
  }
  await mkdir(mdRoot, { recursive: true });
  await writeFile(join(mdRoot, 'index.md'), `${index.join('\n')}\n`);
}

async function runExport(opts, log) {
  const outDir = resolve(opts.out || `klue-export-${new Date().toISOString().slice(0, 10)}`);
  await prepareOutDir(outDir, opts.force);
  const argsFor = parseExtraArgs(opts.arg);

  const conn = await connect(opts, log);
  try {
    const tools = await conn.client.listTools();
    await writeJson(join(outDir, 'tools.json'), tools);

    // find both tools before exporting anything, so a missing one costs nothing
    const plan = KINDS.map((k) => ({ ...k, tool: tools.find((t) => k.match.test(t.name)) }));
    const absent = plan.filter((k) => !k.tool).map((k) => k.plural);
    if (absent.length) {
      throw new Error(
        `The server has no ${absent.join(' or ')} extraction tool. Tools available: ${tools.map((t) => t.name).join(', ') || 'none'}. ` +
          'Your Klue role may not include it; ask a Klue admin to run the export.',
      );
    }

    const groups = [];
    const warnings = [];
    const toolsUsed = {};
    for (const { kind, plural, tool } of plan) {
      log(`Exporting ${plural} with ${tool.name}...`);
      const rawDir = join(outDir, 'raw', safeName(tool.name));
      await mkdir(rawDir, { recursive: true });
      const result = await extractAll(conn.client, tool, {
        kind,
        extraArgs: argsFor(tool.name),
        log,
        onPage: (n, args, res) => writeJson(join(rawDir, `page-${String(n).padStart(4, '0')}.json`), { arguments: args, result: res }),
      });
      warnings.push(...result.warnings);
      toolsUsed[plural] = { tool: tool.name, paging: result.plan.mode, items: result.items.length };
      groups.push({ kind, plural, records: result.items.map((item) => normalize(item, kind)) });
    }

    const meta = {
      schema: SCHEMA,
      exporter: `calven-migrate-from-klue ${pkg.version}`,
      exported_at: new Date().toISOString(),
      server: opts.server,
      server_info: conn.client.serverInfo || null,
      counts: Object.fromEntries(groups.map((g) => [g.plural, g.records.length])),
      tools: toolsUsed,
      origin: Object.fromEntries(
        groups.map((g) => [g.plural, g.records.reduce((acc, r) => ({ ...acc, [r.origin]: (acc[r.origin] || 0) + 1 }), {})]),
      ),
      unmapped: Object.fromEntries(groups.map((g) => [g.plural, g.records.filter((r) => !r.body_markdown).length])),
      warnings,
    };
    await writeExport(outDir, groups, meta);
    await writeJson(join(outDir, 'manifest.json'), meta);

    log(`\nDone. ${groups.map((g) => `${g.records.length} ${g.plural}`).join(', ')} written to ${outDir}`);
    for (const w of warnings) log(`Warning: ${w}`);
    return meta;
  } finally {
    await disconnect(conn, log);
  }
}

async function runInspect(opts, log) {
  const outDir = resolve(opts.out || '.');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, 'klue-tools.json');
  if (!opts.force && (await stat(file).catch(() => null))) {
    throw new Error(`${file} already exists. Pass --force to replace it.`);
  }
  const conn = await connect(opts, log);
  try {
    const tools = await conn.client.listTools();
    await writeJson(file, { server: opts.server, server_info: conn.client.serverInfo || null, tools });
    log(`${tools.length} tools written to ${file}. It holds tool names and argument schemas, no card content.`);
    return tools;
  } finally {
    await disconnect(conn, log);
  }
}

export async function main(argv = process.argv.slice(2), log = (m) => process.stderr.write(`${m}\n`)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      token: { type: 'string' },
      arg: { type: 'string', multiple: true },
      browser: { type: 'boolean', default: true },
      'no-browser': { type: 'boolean' },
      server: { type: 'string', default: DEFAULT_SERVER },
      scope: { type: 'string', default: DEFAULT_SCOPE },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values['no-browser']) values.browser = false;
  if (values.help) return log(HELP);
  if (values.version) return log(pkg.version);

  const args = [...positionals];
  if (args[0] === 'klue') args.shift(); // accepted for symmetry with the vendor name
  const command = args[0] || 'export';
  try {
    if (command === 'export') return await runExport(values, log);
    if (command === 'inspect') return await runInspect(values, log);
    throw new Error(`Unknown command "${command}". Run with --help.`);
  } catch (err) {
    if (err instanceof MissingArgumentsError) {
      for (const m of err.missing) log(`  ${m.name}: ${m.schema.description || JSON.stringify(m.schema)}`);
    }
    throw err;
  }
}
