# Changelog

## 0.1.0

- Klue export: cards and battlecards to Markdown and JSON, raw responses archived, origin flag per item.
- Browser sign-in with OAuth and PKCE, or a personal access token. Tokens revoked after export.
- `inspect` writes the server's tool list without exporting content.
- Paging adapts to page, offset, cursor and last-item-id styles, trusts the server's totals, and warns when the export looks incomplete.
