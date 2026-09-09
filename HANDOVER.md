# Handover documentation

The full handover document does not live in this repository. It is at:

```
E:\Handover_DocS\Shopify Store Tracker\
```

| File | |
|---|---|
| `Shopify-Store-Tracker-Handover.html` | The document. Open in a browser — the diagrams are sharpest here |
| `Shopify-Store-Tracker-Handover.docx` | The same thing in Word |
| `Shopify-Store-Tracker-Handover.md` | The same thing in Markdown |
| `images/` | Every diagram as a PNG |
| `CREDENTIALS.local.md` | The actual secret values. **Never committed** — hand it over separately |
| `_source/` | The generators. Edit the pieces there and rebuild; do not edit the `.docx` or `.md` |

It covers both halves of the project:

- **Phase 1** — the three UiPath robots on the Windows VM that collect the CSVs,
  the Google Sheet they coordinate through, and a flow diagram for each bot
- **Phase 2** — this repository: the ingest, PostgreSQL, the API and the site
- Frontend, backend, database schema, credentials, deployment paths, and a
  command reference

The two halves meet in one place only: a dated folder of CSVs on Google Drive.

The deeper technical documents stay here in `tracker/`: **README.md**,
**INGEST.md**, **DEPLOY.md**, **DRIVE.md**, **N8N.md**.
