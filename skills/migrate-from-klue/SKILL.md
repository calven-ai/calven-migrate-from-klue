---
name: migrate-from-klue
description: Export the user's own Klue cards and battlecards to Markdown and JSON files on their machine with calven-migrate-from-klue. Use when the user asks to export, back up, download or migrate their Klue cards or battlecards.
---

# Export Klue cards and battlecards

Run the export as a command. Do not read cards one by one through a Klue connector and write them out yourself: that paraphrases, drops fields and runs out of context on large workspaces.

1. Check `node --version` is 20 or later. If not, tell the user to install Node.js and stop.
2. Ask where to save the export if the user has not said. Default: `./klue-export-<date>`.
3. Run `npx github:calven-ai/calven-migrate-from-klue --out <folder>` in the background, or with a timeout of at least 10 minutes: the browser sign-in alone can take minutes. A browser tab opens for the Klue sign-in; tell the user to approve it. If the user prefers a personal access token, ask them to set `KLUE_TOKEN` in their own shell first. Never ask for the token in the chat or put it on the command line.
4. When it finishes, read `<folder>/manifest.json` and report the counts, the `origin` breakdown and any warnings. Do not open card files unless the user asks.
5. If it fails with `needs arguments this tool does not fill in`, run `npx github:calven-ai/calven-migrate-from-klue inspect --force`, read `klue-tools.json`, and rerun with `--arg name=value`. Explain the value you chose.

Tell the user once: items marked `klue_or_third_party` are Klue's content, licensed for internal use while their subscription runs, and should be deleted when the Klue contract ends.
