// Bound to the Reporting Sheet. Deploy as a web app (Execute as: Me, Access: Anyone).
// Set Script Properties (Project Settings > Script Properties) before deploying:
//   DASHBOARD_SECRET  - the password the dashboard must pass as ?key=... on every request

var REPORTING_SHEET_NAME = 'Reporting';

function doGet(e) {
  var params = e.parameter;
  var secret = PropertiesService.getScriptProperties().getProperty('DASHBOARD_SECRET');

  if (!secret || params.key !== secret) {
    return jsonResponse({ error: 'unauthorized' });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORTING_SHEET_NAME);
  if (!sheet) {
    return jsonResponse({ error: 'sheet not found: ' + REPORTING_SHEET_NAME });
  }

  return jsonResponse({ items: sheetToObjects(sheet) });
}

function sheetToObjects(sheet) {
  var values = sheet.getDataRange().getValues();
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
