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

**GET** `?key=<secret>&action=pendingplan_upsert&row=<URL-encoded JSON, e.g. {"id":"...","title":"...",...}>`
→ Creates a new PendingPlan row if `row.id` is blank/unmatched, otherwise updates the matching row in place. `last_modified` is set server-side automatically.

**GET** `?key=<secret>&action=pendingplan_delete&id=PP...`
→ Removes that row from PendingPlan.

**GET** `?key=<secret>&action=reporting_update&id=<Reporting id, e.g. PE01>&fields=<URL-encoded JSON, e.g. {"status":"in progress"}>`
→ Updates only the given fields on the matching Reporting row (no row creation — this is for inline dashboard edits, not adding new tracked items). `last_updated` is refreshed server-side automatically.

**GET** `?key=<secret>&action=reporting_create&fields=<URL-encoded JSON, e.g. {"life_area":"other"}>`
→ Appends a brand-new Reporting row. `id` is always server-generated (`NEW<timestamp>`), ignoring any client-supplied id. Defaults: `title: "New task"`, `type: "project"`, `life_area: "other"`, `status: "not started"`, `priority: "medium"`, `flexibility: "flexible"` — anything in `fields` overrides these. This is what "+ Add block" in the Master Task List panel calls.

All writes go through GET, not POST — Apps Script's `/exec` URL always 302-redirects to a `googleusercontent.com` URL for the actual response, and per the fetch spec, browsers silently rewrite a POST into a bodyless GET on that kind of redirect. A `doPost` handler would simply never be reached with its body intact when called from client-side `fetch()`. Encoding writes as GET query params (like reads already do) sidesteps the problem entirely, at the cost of a URL length ceiling — fine for planning-block-sized data, would become a real constraint for anything larger.

### PendingPlan columns
`id, source_item_id, title, date, start_time, duration_minutes, block_type, include, notes, status, calendar_event_id, last_modified`

- `source_item_id` — the Reporting Sheet `id` this block traces back to (e.g. `PE01`), for lineage.
- `include` — `true`/`false`; whether this block should be written to the real Calendar on Approve.
- `status` — `proposed` / `approved` / `written`.
- `calendar_event_id` — filled in by the Approve endpoint once it's actually written to the real Calendar.

**Don't manually reorder the PendingPlan tab's columns.** All reads/writes use the `PENDING_PLAN_HEADERS` constant in `Code.gs` for column order, not whatever row 1 of the sheet actually says — deliberately, so a stray manual header edit can't silently misalign a field into the wrong column. That means the code's column order is the source of truth, not the sheet's visible header row.

## Status

- [x] Read-only JSON endpoint (`doGet`) — returns all Reporting Sheet rows as `{ items: [...] }`, gated by `?key=<DASHBOARD_SECRET>`
- [x] PendingPlan read/write endpoint (`resource=pendingplan`, `pendingplan_upsert`, `pendingplan_delete`)
- [x] Reporting inline-edit endpoint (`reporting_update`) — title/life_area/status/priority/flexibility/due_date/next_steps editable from the dashboard
- [x] Reporting create endpoint (`reporting_create`) — "+ Add block" in the Master Task List panel
- [ ] Chat-edit endpoint (needs `ANTHROPIC_API_KEY` script property)
- [ ] Approve / real-Calendar-write endpoint
