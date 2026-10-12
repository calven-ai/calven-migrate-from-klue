# Export everything from Klue with Claude

This guide gets every card and battlecard your Klue account can see into a folder on your laptop, without you touching a terminal. It is written to be read by a person and followed by an AI assistant such as Claude at the same time.

**Not technical?** You don't need to read all of this. Paste the prompt from [Start here](#start-here) into Claude and it does the work, checking with you along the way.

> This is an independent open-source project by Calven AI, LLC, not affiliated with, endorsed by or sponsored by Klue Labs Inc. The full disclaimer is in the [README](README.md).

## Start here

Copy this into a new chat with Claude, then answer its questions:

```text
I want to migrate all of my cards and battlecards out of Klue into a folder
on my laptop. Follow the guide at
https://github.com/calven-ai/calven-migrate-from-klue/blob/main/MIGRATION.md
I'm not technical, so explain each step in plain language and tell me
exactly what to click.
```

At the end you have one folder, `klue-export-<date>`, laid out as described in [What you end up with](#what-you-end-up-with).

## For the AI assistant

If a user gave you this repository or this file, your job is to leave them with a complete export folder on their own computer. They may never have used a terminal. Follow these rules for the whole session.

1. **Finish the job.** Keep going until every card and battlecard is in the folder and the counts match. Don't stop at a sample or ask the user to do the repetitive part.
2. **Copy, never rewrite.** Card text moves exactly as Klue returns it. Don't summarise, merge, reorder, translate or "clean up". If you can't copy something exactly, leave it out and list it in the warnings.
3. **Plain language, one step at a time.** Say "a program on your computer", not "CLI". Give exact clicks or one command, then wait.
4. **Never ask for passwords or tokens in the chat.** Sign-ins happen in the user's own browser.
5. **Check counts at the end.** Report how many cards and battlecards came out per competitor and in total, and ask the user to compare with Klue.
6. **Make no claims about Klue** beyond what this guide and Klue's published terms say.

## Choose your path

Work out which situation you are in, and take the first that fits.

| You are | Path | Where the folder appears |
| --- | --- | --- |
| Claude Code, or the Code tab of the Claude desktop app (you can run commands on the user's computer) | **A. Run the export program** | Directly on the laptop |
| Claude in Cowork, with the Klue connector and a folder on the user's computer shared with you | **B. Copy through the Klue connector** | Directly in the shared folder |
| Claude in claude.ai or the desktop chat, with the Klue connector | **B. Copy through the Klue connector** | A zip the user downloads and double-clicks |
| None of these, or no Klue connector | Help the user add the connector (below), then Path B | |

Prefer Path A when it is available, even if a Klue connector is also connected. The program pages through Klue on its own and keeps every field, the original HTML and Klue's raw replies, and large workspaces don't run into chat limits. Path B works anywhere Claude has the Klue connector, but you are copying the content yourself, so follow its rules closely.

**Adding the Klue connector.** In Claude: **Settings → Connectors → Add custom connector**. Name it `Klue`, paste `https://mcp.app.klue.com/mcp`, click **Add**, then **Connect** and sign in to Klue. In a new chat, enable Klue from the tools menu. On a Team or Enterprise plan an owner may need to add it first. If sign-in fails, the user's Klue workspace may block third-party apps; a Klue admin can allow it.

**Who should sign in.** The export only contains what the signed-in Klue account can see. A Klue admin sees the most. Mention this once before starting.

## Path A: run the export program

The program in this repository runs on the user's computer, signs in with their own Klue account and writes files only to their computer.

1. **Check Node.js.** Run `node --version`. If it is missing or older than 20, tell the user to install the LTS version from [nodejs.org](https://nodejs.org) (download, double-click, accept the defaults), then check again.
2. **Pick the folder.** Default: `klue-export-<today's date>` in their Documents folder. Ask only if they seem to care.
3. **Run it.** Run `npx github:calven-ai/calven-migrate-from-klue --out <folder>` in the background or with a timeout of at least 10 minutes. Tell the user first: "A browser tab will open asking you to sign in to Klue and approve read access. Approve it, then come back here."
4. **Report.** Read `<folder>/manifest.json` and tell the user, in plain words, the number of cards and battlecards, the `origin` breakdown and any warnings. Offer to open the folder for them. Don't open card files unless asked.

If the user prefers a Klue personal access token, ask them to set `KLUE_TOKEN` in their own terminal before you run the command. Never ask for the token in the chat. For errors, see [When something goes wrong](#when-something-goes-wrong).

## Path B: copy through the Klue connector

Build the same folder the program would, using the Klue connector's tools and your file or code tools. The aim is that the user can't tell which path produced it.

1. **Look at the tools.** List the Klue connector's tools and pick the ones that list or extract cards and battlecards. Note how they page (page number, offset, cursor or "after id").
2. **Count first.** Page through the lists, or use a count the tools report, and show the user the number of competitors, cards and battlecards before copying anything.
3. **Save Klue's replies as they come.** For every page you request, write the reply exactly as returned to `raw/<tool>-<page>.json` with code, before doing anything else with it. These files are the source of truth for the rest of the steps.
4. **Build the files from `raw/`, with code.** Write a short script that reads `raw/` and produces `cards.json`, `battlecards.json`, the Markdown files and `manifest.json` in the layout below. Doing it with a script, not by retyping, is what keeps the text exact.
5. **Work in batches.** Go one competitor or a few pages at a time. After each batch, tell the user how far along you are. If the chat gets long, save what is done and say how to continue in a new chat from the next competitor.
6. **Reconcile.** Compare the counts in `manifest.json` with step 2. Any gap goes in `warnings` with the competitor name.
7. **Hand it over.** In Cowork, the folder is already on the laptop; say where. In a chat, zip the folder and give the user the download link, then tell them: "Click the link, then double-click the zip to open the folder."

## What you end up with

```
klue-export-2026-10-12/
  manifest.json      counts per kind and origin, tools used, warnings
  cards.json         every card
  battlecards.json   every battlecard
  markdown/
    index.md         table of contents by competitor
    cards/<competitor>/<card>.md
    battlecards/<competitor>/<battlecard>.md
  raw/               Klue's reply to every page request
```

Each Markdown file starts with front matter (title, competitor, section, tags, author, dates, origin, link back to Klue) followed by the body. The JSON records follow [docs/schema.md](docs/schema.md). Path A also writes `tools.json`, the tools Klue's server offered.

Every item carries an `origin`:

| origin | how it is set |
| --- | --- |
| `customer` | a named author and no field marking it as sourced |
| `klue_or_third_party` | a field marks it as sourced (news, reviews), or the author is Klue |
| `unknown` | no author and no marker |

Tell the user once: items marked `klue_or_third_party` are Klue's content, licensed for internal use while their subscription runs, and should be deleted when the Klue contract ends.

## When something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `node: command not found` | Node.js isn't installed | Install the LTS version from nodejs.org, then try again |
| The browser tab never opens | The program can't reach a browser | Rerun with `--no-browser` and open the printed link in any browser on the same computer |
| Sign-in fails, or Klue says the app isn't allowed | The Klue workspace blocks third-party apps | Ask a Klue admin to allow it, or use a personal access token on Path A |
| `has no cards extraction tool` | The Klue role can't export cards | Ask a Klue admin to run the export |
| `needs arguments this tool does not fill in` | Klue's server wants an extra setting | Run `npx github:calven-ai/calven-migrate-from-klue inspect --force`, read `klue-tools.json`, rerun with `--arg name=value` and explain the value chosen |
| A warning that the export may be incomplete | Counts don't add up | Compare `manifest.json` with Klue, then [open an issue](https://github.com/calven-ai/calven-migrate-from-klue/issues) with `manifest.json` (counts only, no content) |
| The chat gets slow or forgets earlier pages (Path B) | The workspace is too big for one chat | Save what is done, start a new chat with the same prompt and continue from the next competitor |
