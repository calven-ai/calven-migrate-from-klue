# calven-export/v1 schema

`cards.json` and `battlecards.json` are arrays of records. Every field is present; a value Klue did not provide is `null` (or `[]` for tags).

| field | type | notes |
| --- | --- | --- |
| `schema` | string | `calven-export/v1` |
| `source_system` | string | `klue` |
| `kind` | string | `card` or `battlecard` |
| `id` | string | Klue's id |
| `title` | string | |
| `competitor` | object | `{ id, name }`, from Klue's board or rival |
| `section` | string | lane, tab or category |
| `body_html` | string | the body exactly as Klue returned it, when it is HTML |
| `body_markdown` | string | the body as Markdown |
| `tags` | string[] | |
| `url` | string | link to the item in Klue |
| `author` | string | |
| `origin` | string | `customer`, `klue_or_third_party` or `unknown`; see the README |
| `created_at`, `updated_at` | string | as Klue formats them |
| `source` | object | the full item as Klue returned it |

Fields are matched by name across the spellings vendors use (`updated_at`, `updatedAt`, `last_updated`). When no body field is found, `body_markdown` is `null`, the Markdown file shows the whole item as JSON, and `manifest.json` counts it under `unmapped`.
