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

## Status

- [x] Read-only JSON endpoint (`doGet`) — returns all Reporting Sheet rows as `{ items: [...] }`, gated by `?key=<DASHBOARD_SECRET>`
- [ ] PendingPlan read/write endpoint
- [ ] Chat-edit endpoint (needs `ANTHROPIC_API_KEY` script property)
- [ ] Approve / real-Calendar-write endpoint
