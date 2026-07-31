# Apps Script setup (one-time, manual)

Apps Script binds directly to the Reporting Sheet — it can't be deployed by pushing to GitHub. The `.gs` files in this folder are kept here only so the source has real version history; the Apps Script editor is where it actually runs.

## Setup steps

1. Open the Reporting Sheet: https://docs.google.com/spreadsheets/d/1493uG00bGYh2ONXz1Ct-6FNQ45HBQ12kGOxiD1S_uYQ/edit
2. Rename the first tab from its default name to **`Reporting`** (the scripts look it up by this exact name).
3. Extensions > Apps Script.
4. Delete the default `Code.gs` contents and paste in this folder's `Code.gs`.
5. Project Settings (gear icon) > Script Properties > add:
   - `DASHBOARD_SECRET` = a password you choose (this is what gates every dashboard request)
6. Deploy > New deployment > type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Copy the deployment URL — you'll need it in `docs/app.js` as the API endpoint.

## Updating the deployment after a code change

Editing and saving `Code.gs` in the editor is not enough — the live URL keeps serving the old version until you:
**Deploy > Manage deployments > (pencil icon on the existing deployment) > Version: New version > Deploy**.

## API contract

**GET** `?key=<secret>&resource=reporting` (resource defaults to `reporting` if omitted)
→ `{ items: [...] }` — every row of the Reporting sheet.

**GET** `?key=<secret>&resource=pendingplan`
→ `{ items: [...] }` — every row of the PendingPlan tab (auto-created on first use if it doesn't exist yet, no manual setup needed).

**POST** body `{ "key": "<secret>", "action": "pendingplan_upsert", "row": { "id": "...", "title": "...", ... } }`
→ Creates a new PendingPlan row if `row.id` is blank/unmatched, otherwise updates the matching row in place. `last_modified` is set server-side automatically.

**POST** body `{ "key": "<secret>", "action": "pendingplan_delete", "id": "PP..." }`
→ Removes that row from PendingPlan.

To avoid a CORS preflight from GitHub Pages, send POST requests with `Content-Type: text/plain` (Apps Script still parses the body as JSON via `e.postData.contents`) — see `docs/app.js`.

### PendingPlan columns
`id, source_item_id, title, date, start_time, duration_minutes, block_type, include, notes, status, calendar_event_id, last_modified`

- `source_item_id` — the Reporting Sheet `id` this block traces back to (e.g. `PE01`), for lineage.
- `include` — `true`/`false`; whether this block should be written to the real Calendar on Approve.
- `status` — `proposed` / `approved` / `written`.
- `calendar_event_id` — filled in by the Approve endpoint once it's actually written to the real Calendar.

## Status

- [x] Read-only JSON endpoint (`doGet`) — returns all Reporting Sheet rows as `{ items: [...] }`, gated by `?key=<DASHBOARD_SECRET>`
- [x] PendingPlan read/write endpoint (`resource=pendingplan`, `pendingplan_upsert`, `pendingplan_delete`)
- [ ] Chat-edit endpoint (needs `ANTHROPIC_API_KEY` script property)
- [ ] Approve / real-Calendar-write endpoint
