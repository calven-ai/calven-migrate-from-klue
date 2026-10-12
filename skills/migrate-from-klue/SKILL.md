---
name: migrate-from-klue
description: Export every Klue card and battlecard the user can see into a klue-export-<date> folder on their machine, as Markdown and JSON, with calven-migrate-from-klue or through the Klue MCP connector. Use when the user asks to export, back up, download, move or migrate their Klue cards, battlecards or content, including users who are not technical.
---

# Export everything from Klue

The goal is a complete `klue-export-<date>` folder on the user's computer. The user may not be technical: explain each step in plain language, give exact clicks, never ask for passwords or tokens in the chat, and keep going until the counts match. The full guide, with the folder layout and troubleshooting, is https://github.com/calven-ai/calven-migrate-from-klue/blob/main/MIGRATION.md

## If you can run commands on the user's computer (preferred)

Use this even when a Klue connector is also connected: it keeps every field and does not run into chat limits.

1. Check `node --version` is 20 or later. If not, walk the user through installing the LTS version from nodejs.org, then check again.
2. Save to `klue-export-<date>` in their Documents folder unless they named a place.
3. Run `npx github:calven-ai/calven-migrate-from-klue --out <folder>` in the background, or with a timeout of at least 10 minutes: the browser sign-in alone can take minutes. Tell the user first that a browser tab will open for the Klue sign-in and to approve it. If they prefer a personal access token, ask them to set `KLUE_TOKEN` in their own shell first. Never put the token on the command line.
4. When it finishes, read `<folder>/manifest.json` and report the counts, the `origin` breakdown and any warnings in plain words. Do not open card files unless the user asks.
5. If it fails with `needs arguments this tool does not fill in`, run `npx github:calven-ai/calven-migrate-from-klue inspect --force`, read `klue-tools.json`, and rerun with `--arg name=value`. Explain the value you chose.

## If you can only use the Klue connector

Build the same folder from the connector's replies. Copy, never rewrite: no summarising, merging, reordering or cleaning up.

1. Find the connector tools that list or extract cards and battlecards, and how they page.
2. Count competitors, cards and battlecards first and show the user the totals.
3. Write every page reply exactly as returned to `raw/<tool>-<page>.json` with code before using it.
4. Build `cards.json`, `battlecards.json`, `markdown/` (front matter plus body, one file per item, grouped by competitor, with an `index.md`) and `manifest.json` from `raw/` with a script, not by retyping. Records follow the `calven-export/v1` schema in the repo's `docs/schema.md`.
5. Work one competitor or a few pages at a time and report progress. If the chat runs long, save what is done and continue in a new chat.
6. Compare the final counts with step 2 and list any gap in `manifest.json` warnings.
7. If the folder is not already on the user's computer (as it is in Cowork), zip it and give them the download link.

Tell the user once: items marked `klue_or_third_party` are Klue's content, licensed for internal use while their subscription runs, and should be deleted when the Klue contract ends.
