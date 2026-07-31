// Bound to the Reporting Sheet. Deploy as a web app (Execute as: Me, Access: Anyone).
// Set Script Properties (Project Settings > Script Properties) before deploying:
//   DASHBOARD_SECRET  - the password the dashboard/chat/Routine must pass as ?key=... (GET)
//                        or in the JSON body (POST) on every request

var REPORTING_SHEET_NAME = 'Reporting';
var PENDING_PLAN_SHEET_NAME = 'PendingPlan';
var PENDING_PLAN_HEADERS = [
  'id', 'source_item_id', 'title', 'date', 'start_time', 'duration_minutes',
  'block_type', 'include', 'notes', 'status', 'calendar_event_id', 'last_modified'
];

// Everything goes through doGet, including writes. Apps Script's /exec URL always
// 302-redirects to a googleusercontent.com URL for the real response, and per the
// fetch spec, browsers silently rewrite a POST into a bodyless GET on that kind of
// redirect. doPost calls from client-side fetch() therefore never actually reach
// doPost — they arrive here anyway, minus their body. So writes take their payload
// as URL-encoded query params instead, same as reads.
function doGet(e) {
  var params = e.parameter;
  if (!checkSecret(params.key)) {
    return jsonResponse({ error: 'unauthorized' });
  }

  var action = params.action;

  if (action === 'pendingplan_upsert') {
    var row;
    try {
      row = JSON.parse(params.row || '{}');
    } catch (err) {
      return jsonResponse({ error: 'invalid row JSON' });
    }
    return pendingPlanUpsert(row);
  }

  if (action === 'pendingplan_delete') {
    return pendingPlanDelete(params.id);
  }

  var resource = params.resource || 'reporting';

  if (resource === 'reporting') {
    var reportingSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORTING_SHEET_NAME);
    if (!reportingSheet) {
      return jsonResponse({ error: 'sheet not found: ' + REPORTING_SHEET_NAME });
    }
    return jsonResponse({ items: sheetToObjects(reportingSheet) });
  }

  if (resource === 'pendingplan') {
    var planSheet = getOrCreatePendingPlanSheet();
    return jsonResponse({ items: sheetToObjects(planSheet) });
  }

  return jsonResponse({ error: 'unknown resource: ' + resource });
}

function checkSecret(candidate) {
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_SECRET');
  return !!secret && candidate === secret;
}

// --- PendingPlan ---

function getOrCreatePendingPlanSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PENDING_PLAN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PENDING_PLAN_SHEET_NAME);
    sheet.appendRow(PENDING_PLAN_HEADERS);
  }
  return sheet;
}

// Creates a new row if row.id is blank or not found, otherwise updates the matching row in place.
function pendingPlanUpsert(row) {
  var sheet = getOrCreatePendingPlanSheet();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('id');

  row.last_modified = new Date().toISOString();
  if (!row.id) {
    row.id = 'PP' + new Date().getTime();
  }

  for (var r = 1; r < values.length; r++) {
    if (values[r][idCol] === row.id) {
      var rowNum = r + 1;
      headers.forEach(function (header, c) {
        if (row.hasOwnProperty(header)) {
          sheet.getRange(rowNum, c + 1).setValue(row[header]);
        }
      });
      return jsonResponse({ ok: true, id: row.id, created: false });
    }
  }

  var newRow = headers.map(function (header) {
    return row.hasOwnProperty(header) ? row[header] : '';
  });
  sheet.appendRow(newRow);
  return jsonResponse({ ok: true, id: row.id, created: true });
}

function pendingPlanDelete(id) {
  if (!id) return jsonResponse({ error: 'missing id' });
  var sheet = getOrCreatePendingPlanSheet();
  var values = sheet.getDataRange().getValues();
  var idCol = values[0].indexOf('id');

  for (var r = 1; r < values.length; r++) {
    if (values[r][idCol] === id) {
      sheet.deleteRow(r + 1);
      return jsonResponse({ ok: true, id: id });
    }
  }
  return jsonResponse({ error: 'id not found: ' + id });
}

// --- shared helpers ---

function sheetToObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1)
    .filter(function (row) { return row[0] !== ''; })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (header, i) { obj[header] = row[i]; });
      return obj;
    });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
