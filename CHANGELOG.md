# Changelog

## Unreleased

- `MIGRATION.md`: a guide Claude follows end to end, so a user with no terminal experience ends up with the export folder on their laptop. Covers running the CLI, and copying through the Klue MCP connector in Cowork, claude.ai or the desktop chat.
- README: a copy-paste prompt for non-technical users and the three ways Claude can run the export.
- migrate-from-klue skill: adds the connector path, copied from saved replies with code rather than retyped.

## 0.1.0

- Klue export: cards and battlecards to Markdown and JSON, raw responses archived, origin flag per item.
- Browser sign-in with OAuth and PKCE, or a personal access token. Tokens revoked after export.
- `inspect` writes the server's tool list without exporting content.
- Paging adapts to page, offset, cursor and last-item-id styles, trusts the server's totals, and warns when the export looks incomplete.
