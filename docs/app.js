// Fill in after deploying the Apps Script web app (see /apps-script/README.md).
const API_URL = 'https://script.google.com/macros/s/AKfycbwzLA7Z9n4XBaEEY_25dOklkH5mEzly7YMhGci_CDRBe6sS1E3uFImlz2JFhW6yOGwi/exec';
const POLL_INTERVAL_MS = 90 * 1000;

let secret = null;
let pollTimer = null;

const gate = document.getElementById('gate');
const gateForm = document.getElementById('gate-form');
const gateError = document.getElementById('gate-error');
const app = document.getElementById('app');
const refreshBtn = document.getElementById('refresh-btn');
const bannerArea = document.getElementById('banner-area');
const statusGroups = document.getElementById('status-groups');
const planRows = document.getElementById('pending-plan-rows');
const addBlockBtn = document.getElementById('add-block-btn');
const areaFilters = document.getElementById('area-filters');
const glanceStats = document.getElementById('glance-stats');

let currentAreaFilter = 'all';
let lastReportingItems = [];

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const candidate = document.getElementById('gate-secret').value;
  gateError.classList.add('hidden');
  const ok = await loadAll(candidate);
  if (ok) {
    secret = candidate;
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    pollTimer = setInterval(() => loadAll(secret), POLL_INTERVAL_MS);
  } else {
    gateError.classList.remove('hidden');
  }
});

refreshBtn.addEventListener('click', () => {
  if (secret) loadAll(secret);
});

addBlockBtn.addEventListener('click', async () => {
  const today = new Date().toISOString().slice(0, 10);
  await upsertPlanRow({
    title: '',
    date: today,
    start_time: '',
    duration_minutes: '',
    block_type: 'flexible',
    include: true,
    notes: '',
    status: 'proposed'
  });
  loadAll(secret);
});

async function loadAll(key) {
  const [reporting, plan] = await Promise.all([
    fetchResource(key, 'reporting'),
    fetchResource(key, 'pendingplan')
  ]);
  if (!reporting.ok || !plan.ok) return false;
  render(reporting.items, plan.items);
  return true;
}

async function fetchResource(key, resource) {
  try {
    const res = await fetch(`${API_URL}?key=${encodeURIComponent(key)}&resource=${resource}`);
    const data = await res.json();
    if (data.error) return { ok: false, items: [] };
    return { ok: true, items: data.items || [] };
  } catch (err) {
    return { ok: false, items: [] };
  }
}

// Writes go through GET too, not POST — see apps-script/README.md for why
// (Apps Script's redirect makes a client-side POST arrive as a bodyless GET).
async function performAction(action, extraParams) {
  const url = new URL(API_URL);
  url.searchParams.set('key', secret);
  url.searchParams.set('action', action);
  Object.entries(extraParams || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.error) {
      showTransientError(`Save failed: ${data.error}`);
      return { ok: false };
    }
    return { ok: true, data };
  } catch (err) {
    showTransientError('Save failed: could not reach the server.');
    return { ok: false };
  }
}

async function upsertPlanRow(row) {
  return performAction('pendingplan_upsert', { row: JSON.stringify(row) });
}

async function deletePlanRow(id) {
  return performAction('pendingplan_delete', { id });
}

function showTransientError(text) {
  const banner = makeBanner('danger', text);
  bannerArea.prepend(banner);
  setTimeout(() => banner.remove(), 5000);
}

function flashSaved(el) {
  el.classList.add('just-saved');
  setTimeout(() => el.classList.remove('just-saved'), 900);
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  if (isNaN(then)) return null;
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function render(items, planItems) {
  renderBanners(items);
  renderGroups(items);
  renderPlan(planItems);
}

function renderBanners(items) {
  bannerArea.innerHTML = '';

  const overdueFixed = items.filter((it) => {
    const days = daysBetween(it.due_date);
    return it.flexibility === 'fixed' && it.status !== 'complete' && days !== null && days > 0;
  });

  const stalePipeline = items.filter((it) => {
    const days = daysBetween(it.last_updated);
    return it.type === 'pipeline' && days !== null && days > 14;
  });

  overdueFixed.forEach((it) => {
    bannerArea.appendChild(
      makeBanner('danger', `At-risk: "${it.title}" was due ${it.due_date} and is still ${it.status || 'not started'}.`)
    );
  });

  stalePipeline.forEach((it) => {
    bannerArea.appendChild(
      makeBanner('warn', `Stale pipeline entry: "${it.title}" hasn't been updated since ${it.last_updated}.`)
    );
  });
}

function makeBanner(kind, text) {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.textContent = text;
  return div;
}

function renderGroups(items) {
  lastReportingItems = items;
  renderAreaFilters(items);
  renderGlanceStats(items);

  statusGroups.innerHTML = '';
  const visible = currentAreaFilter === 'all'
    ? items
    : items.filter((it) => (it.life_area || 'other') === currentAreaFilter);

  const byArea = {};
  visible.forEach((it) => {
    const area = it.life_area || 'other';
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(it);
  });

  Object.keys(byArea).sort().forEach((area) => {
    const group = document.createElement('div');
    group.className = 'status-group';

    const title = document.createElement('div');
    title.className = 'status-group-title';
    title.textContent = area;
    group.appendChild(title);

    byArea[area].forEach((it) => group.appendChild(renderStatusRow(it)));
    statusGroups.appendChild(group);
  });
}

function renderAreaFilters(items) {
  const counts = { all: items.length };
  items.forEach((it) => {
    const area = it.life_area || 'other';
    counts[area] = (counts[area] || 0) + 1;
  });

  const areas = ['all', ...Object.keys(counts).filter((a) => a !== 'all').sort()];

  areaFilters.innerHTML = '';
  areas.forEach((area) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-btn' + (area === currentAreaFilter ? ' active' : '');

    const label = document.createElement('span');
    label.textContent = area === 'all' ? 'All' : area;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts[area];

    btn.appendChild(label);
    btn.appendChild(count);
    btn.addEventListener('click', () => {
      currentAreaFilter = area;
      renderGroups(lastReportingItems);
    });
    areaFilters.appendChild(btn);
  });
}

function renderGlanceStats(items) {
  const overdueCount = items.filter((it) => {
    const days = daysBetween(it.due_date);
    return it.flexibility === 'fixed' && it.status !== 'complete' && days !== null && days > 0;
  }).length;

  const staleCount = items.filter((it) => {
    const days = daysBetween(it.last_updated);
    return it.type === 'pipeline' && days !== null && days > 14;
  }).length;

  const stats = [
    ['Overdue (fixed)', overdueCount],
    ['Stale pipeline', staleCount],
    ['Total tracked', items.length]
  ];

  glanceStats.innerHTML = '';
  stats.forEach(([label, num]) => {
    const row = document.createElement('div');
    row.className = 'glance-stat';
    const l = document.createElement('span');
    l.textContent = label;
    const n = document.createElement('span');
    n.className = 'num';
    n.textContent = num;
    row.appendChild(l);
    row.appendChild(n);
    glanceStats.appendChild(row);
  });
}

function renderStatusRow(it) {
  const row = document.createElement('div');
  row.className = 'status-row';

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = it.title;

  const pills = document.createElement('div');
  pills.className = 'row-pills';

  const overdueDays = daysBetween(it.due_date);
  if (it.due_date && it.status !== 'complete' && overdueDays > 0) {
    pills.appendChild(makePill('pink', 'overdue'));
  }
  if (it.status) pills.appendChild(makePill(statusPillColor(it.status), it.status));
  if (it.type) pills.appendChild(makePill(typePillColor(it.type), it.type));
  if (it.priority) pills.appendChild(makePill(priorityPillColor(it.priority), it.priority));
  if (it.due_date) pills.appendChild(makePill('gray', `due ${it.due_date}`));

  row.appendChild(title);
  row.appendChild(pills);
  return row;
}

function makePill(color, text) {
  const span = document.createElement('span');
  span.className = `pill pill-${color}`;
  span.textContent = text;
  return span;
}

function statusPillColor(status) {
  if (status === 'complete') return 'green';
  if (status === 'in progress' || status === 'Started') return 'blue';
  if (status === 'blocked') return 'pink';
  return 'peach';
}

function typePillColor(type) {
  if (type === 'habit') return 'green';
  if (type === 'pipeline') return 'purple';
  if (type === 'constraint') return 'pink';
  return 'blue';
}

function priorityPillColor(priority) {
  if (priority === 'high') return 'pink';
  if (priority === 'medium') return 'blue';
  return 'gray';
}

// --- PendingPlan (editable) ---

function renderPlan(planItems) {
  planRows.innerHTML = '';
  if (planItems.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No plan proposed yet.';
    planRows.appendChild(empty);
    return;
  }

  planItems
    .slice()
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    .forEach((row) => planRows.appendChild(renderPlanRow(row)));
}

function renderPlanRow(row) {
  const included = row.include === true || row.include === 'true' || row.include === 'TRUE';

  const wrap = document.createElement('div');
  wrap.className = 'plan-row' + (included ? '' : ' excluded');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = included;
  checkbox.title = 'Include on Approve';
  checkbox.addEventListener('change', () => {
    wrap.classList.toggle('excluded', !checkbox.checked);
    saveRow();
  });

  const fields = document.createElement('div');
  fields.className = 'plan-fields';

  const titleInput = makeField('text', 'plan-title', row.title, 'Block title');
  const dateInput = makeField('date', 'plan-date', row.date);
  const timeInput = makeField('time', 'plan-time', row.start_time);
  const durationInput = makeField('number', 'plan-duration', row.duration_minutes, 'min');
  const notesInput = document.createElement('textarea');
  notesInput.className = 'plan-notes';
  notesInput.placeholder = 'Notes / specific next-step';
  notesInput.value = row.notes || '';

  [titleInput, dateInput, timeInput, durationInput, notesInput].forEach((el) => {
    el.addEventListener('change', saveRow);
  });

  fields.appendChild(titleInput);
  fields.appendChild(dateInput);
  fields.appendChild(timeInput);
  fields.appendChild(durationInput);
  fields.appendChild(notesInput);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Delete this block';
  deleteBtn.addEventListener('click', async () => {
    await deletePlanRow(row.id);
    loadAll(secret);
  });

  wrap.appendChild(checkbox);
  wrap.appendChild(fields);
  wrap.appendChild(deleteBtn);

  async function saveRow() {
    const result = await upsertPlanRow({
      id: row.id,
      source_item_id: row.source_item_id || '',
      title: titleInput.value,
      date: dateInput.value,
      start_time: timeInput.value,
      duration_minutes: durationInput.value,
      block_type: row.block_type || 'flexible',
      include: checkbox.checked,
      notes: notesInput.value,
      status: row.status || 'proposed'
    });
    if (result.ok) flashSaved(wrap);
  }

  return wrap;
}

function makeField(type, className, value, placeholder) {
  const input = document.createElement('input');
  input.type = type;
  input.className = className;
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  return input;
}
