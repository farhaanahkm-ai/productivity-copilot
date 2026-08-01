// Fill in after deploying the Apps Script web app (see /apps-script/README.md).
const API_URL = 'https://script.google.com/macros/s/AKfycbwzLA7Z9n4XBaEEY_25dOklkH5mEzly7YMhGci_CDRBe6sS1E3uFImlz2JFhW6yOGwi/exec';
const POLL_INTERVAL_MS = 90 * 1000;
const STATUS_PAGE_SIZE = 5;

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
const savePlanBtn = document.getElementById('save-plan-btn');
const dirtyIndicator = document.getElementById('plan-dirty-indicator');
const newBlockTitle = document.getElementById('new-block-title');
const newBlockDate = document.getElementById('new-block-date');
const newBlockNotes = document.getElementById('new-block-notes');
const confirmAddBlockBtn = document.getElementById('confirm-add-block-btn');
const areaFilters = document.getElementById('area-filters');
const glanceStats = document.getElementById('glance-stats');
const timelineRows = document.getElementById('timeline-rows');
const timelineHeader = document.getElementById('timeline-header');
const timelineLegend = document.getElementById('timeline-legend');

let currentAreaFilter = 'all';
let lastReportingItems = [];
const expandedGroups = new Set();

// Today's Plan is a local "cart": every drag/reorder/delete/edit inside it mutates
// this array and re-renders instantly, with zero network calls. Nothing reaches the
// PendingPlan sheet until "Save Plan" is clicked, which diffs `cart` against
// `serverPlanSnapshot` and syncs in one batch. The background poll and manual
// refresh button deliberately never touch `cart` — only Master Task List / Status /
// Timeline data — so they can't clobber in-progress unsaved plan edits.
let cart = [];
let serverPlanSnapshot = [];
let cartDirty = false;

function genId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function setDirty(val) {
  cartDirty = val;
  dirtyIndicator.classList.toggle('hidden', !val);
}

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const candidate = document.getElementById('gate-secret').value;
  gateError.classList.add('hidden');
  const ok = await initialLoad(candidate);
  if (ok) {
    secret = candidate;
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    pollTimer = setInterval(() => refreshReportingOnly(), POLL_INTERVAL_MS);
  } else {
    gateError.classList.remove('hidden');
  }
});

refreshBtn.addEventListener('click', () => {
  if (secret) refreshReportingOnly();
});

// "+ Add block" drafts a new task straight into the Master Task List (Reporting
// sheet) — Today's Plan is populated only by dragging existing tasks in, never by
// this form.
confirmAddBlockBtn.addEventListener('click', async () => {
  const fields = { life_area: 'other' };
  if (newBlockTitle.value.trim()) fields.title = newBlockTitle.value.trim();
  if (newBlockDate.value) fields.due_date = newBlockDate.value;
  if (newBlockNotes.value.trim()) fields.next_steps = newBlockNotes.value.trim();

  const result = await performAction('reporting_create', { fields: JSON.stringify(fields) });
  if (result.ok) {
    newBlockTitle.value = '';
    newBlockDate.value = '';
    newBlockNotes.value = '';
    expandedGroups.add('Other');
    await refreshReportingOnly();
  }
});

savePlanBtn.addEventListener('click', async () => {
  savePlanBtn.disabled = true;
  const currentIds = new Set(cart.map((c) => c.id));
  const toDelete = serverPlanSnapshot.filter((p) => !currentIds.has(p.id));

  const results = await Promise.all([
    ...toDelete.map((p) => deletePlanRow(p.id)),
    ...cart.map((row) => upsertPlanRow(row))
  ]);

  savePlanBtn.disabled = false;
  if (results.every((r) => r.ok)) {
    serverPlanSnapshot = cart.map((c) => Object.assign({}, c));
    setDirty(false);
    savePlanBtn.classList.add('saved');
    savePlanBtn.textContent = 'Saved \u2713';
    setTimeout(() => {
      savePlanBtn.classList.remove('saved');
      savePlanBtn.textContent = 'Save Plan';
    }, 1500);
  } else {
    showTransientNotice('Some plan changes failed to save — try again.', 'danger');
  }
});

// --- Today's Plan drag target: accepts a Master Task List task (add to cart) or a
// reorder of an existing plan tile. Dropping a plan tile outside any valid target
// (dragend fires with dropEffect 'none') removes it from the cart.
planRows.addEventListener('dragover', (e) => {
  e.preventDefault();
  planRows.classList.add('drag-over');
  updateDropIndicator(e.clientY);
});
planRows.addEventListener('dragleave', (e) => {
  if (e.target === planRows) {
    planRows.classList.remove('drag-over');
    clearDropIndicators();
  }
});
planRows.addEventListener('drop', (e) => {
  e.preventDefault();
  planRows.classList.remove('drag-over');
  clearDropIndicators();

  let payload;
  try {
    payload = JSON.parse(e.dataTransfer.getData('text/plain'));
  } catch (err) {
    return;
  }

  if (payload.kind === 'task') handleTaskDrop(payload.id, e.clientY);
  else if (payload.kind === 'plan') handlePlanReorder(payload.id, e.clientY);
});

function handleTaskDrop(sourceId, clientY) {
  const existing = cart.find((p) => p.source_item_id === sourceId);
  if (existing) {
    const el = planRows.querySelector(`[data-plan-id="${cssEscape(existing.id)}"]`);
    if (el) flashSaved(el);
    return;
  }

  const sourceItem = lastReportingItems.find((it) => it.id === sourceId);
  if (!sourceItem) return;

  const today = new Date().toISOString().slice(0, 10);
  const newRow = {
    id: genId('PP'),
    source_item_id: sourceId,
    title: sourceItem.title,
    date: today,
    start_time: '',
    duration_minutes: '',
    block_type: sourceItem.flexibility === 'fixed' ? 'fixed' : (sourceItem.type === 'habit' ? 'habit' : 'flexible'),
    include: true,
    notes: '',
    status: 'proposed'
  };

  cart.splice(computeInsertIndex(clientY, null), 0, newRow);
  setDirty(true);
  renderPlan(cart);
}

function handlePlanReorder(planId, clientY) {
  const fromIndex = cart.findIndex((c) => c.id === planId);
  if (fromIndex === -1) return;

  let insertIndex = computeInsertIndex(clientY, planId);
  const [item] = cart.splice(fromIndex, 1);
  if (insertIndex > fromIndex) insertIndex -= 1;
  cart.splice(insertIndex, 0, item);

  setDirty(true);
  renderPlan(cart);
}

// Returns the cart-array index to insert at, based on where clientY falls among the
// currently rendered tiles (excluding excludeId, e.g. the tile being dragged).
function computeInsertIndex(clientY, excludeId) {
  const tiles = Array.from(planRows.querySelectorAll('.plan-row'))
    .filter((t) => t.dataset.planId !== excludeId);

  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      const targetId = tile.dataset.planId;
      const idx = cart.findIndex((c) => c.id === targetId);
      return idx === -1 ? cart.length : idx;
    }
  }
  return cart.length;
}

function updateDropIndicator(clientY) {
  clearDropIndicators();
  const tiles = Array.from(planRows.querySelectorAll('.plan-row'));
  for (const tile of tiles) {
    const rect = tile.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      tile.classList.add('drop-before');
      return;
    }
  }
  if (tiles.length) tiles[tiles.length - 1].classList.add('drop-after');
}

function clearDropIndicators() {
  planRows.querySelectorAll('.drop-before, .drop-after').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after');
  });
}

function cssEscape(str) {
  return String(str).replace(/["\\]/g, '\\$&');
}

async function initialLoad(key) {
  const [reporting, plan] = await Promise.all([
    fetchResource(key, 'reporting'),
    fetchResource(key, 'pendingplan')
  ]);
  if (!reporting.ok || !plan.ok) return false;

  lastReportingItems = reporting.items;
  cart = plan.items.slice();
  serverPlanSnapshot = plan.items.map((c) => Object.assign({}, c));

  renderBanners(lastReportingItems);
  renderGroups(lastReportingItems);
  renderTimeline(lastReportingItems);
  renderPlan(cart);
  return true;
}

// Refreshes everything EXCEPT Today's Plan — used by the poll and the manual
// refresh button, so they never overwrite unsaved local cart edits. Pick up
// Routine-proposed plan blocks (or other-device Save Plan changes) by reloading
// the page / re-entering the password.
async function refreshReportingOnly() {
  const res = await fetchResource(secret, 'reporting');
  if (!res.ok) return false;
  lastReportingItems = res.items;
  renderBanners(lastReportingItems);
  renderGroups(lastReportingItems);
  renderTimeline(lastReportingItems);
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
      showTransientNotice(`Save failed: ${data.error}`, 'danger');
      return { ok: false };
    }
    return { ok: true, data };
  } catch (err) {
    showTransientNotice('Save failed: could not reach the server.', 'danger');
    return { ok: false };
  }
}

async function upsertPlanRow(row) {
  return performAction('pendingplan_upsert', { row: JSON.stringify(row) });
}

async function deletePlanRow(id) {
  return performAction('pendingplan_delete', { id });
}

async function updateReportingField(id, fields) {
  return performAction('reporting_update', { id, fields: JSON.stringify(fields) });
}

function showTransientNotice(text, kind) {
  const banner = makeBanner(kind || 'warn', text);
  bannerArea.prepend(banner);
  setTimeout(() => banner.remove(), 4000);
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

// dd/mm/yyyy, date-only (no time-of-day) for anywhere a date is displayed as text.
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function toDateInputValue(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toISOString().slice(0, 10);
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
    const project = it.parent ? ` (${it.parent})` : '';
    bannerArea.appendChild(
      makeBanner('danger', `At-risk: "${it.title}"${project} was due ${formatDate(it.due_date)} and is still ${it.status || 'not started'}.`)
    );
  });

  stalePipeline.forEach((it) => {
    const project = it.parent ? ` (${it.parent})` : '';
    bannerArea.appendChild(
      makeBanner('warn', `Stale pipeline entry: "${it.title}"${project} hasn't been updated since ${formatDate(it.last_updated)}.`)
    );
  });
}

function makeBanner(kind, text) {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.textContent = text;
  return div;
}

// Grouped by project (Reporting `parent` field) — items with no parent
// (habits, constraints, ad-hoc tasks) fall into an "Other" bucket.
function renderGroups(items) {
  renderAreaFilters(items);
  renderGlanceStats(items);

  statusGroups.innerHTML = '';
  const visible = currentAreaFilter === 'all'
    ? items
    : items.filter((it) => (it.life_area || 'other') === currentAreaFilter);

  const byProject = {};
  visible.forEach((it) => {
    const project = it.parent || 'Other';
    if (!byProject[project]) byProject[project] = [];
    byProject[project].push(it);
  });

  Object.keys(byProject).sort().forEach((project) => {
    const group = document.createElement('div');
    group.className = 'status-group';

    const title = document.createElement('div');
    title.className = 'status-group-title';
    title.textContent = project;
    group.appendChild(title);

    const sorted = byProject[project].slice().sort((a, b) => {
      const da = new Date(a.due_date);
      const db = new Date(b.due_date);
      const va = isNaN(da) ? Infinity : da.getTime();
      const vb = isNaN(db) ? Infinity : db.getTime();
      return va - vb;
    });

    const expanded = expandedGroups.has(project);
    const visibleRows = expanded ? sorted : sorted.slice(0, STATUS_PAGE_SIZE);
    visibleRows.forEach((it) => group.appendChild(renderStatusRow(it)));

    if (sorted.length > STATUS_PAGE_SIZE) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'show-more-btn';
      more.textContent = expanded ? 'Show less' : `Show ${sorted.length - STATUS_PAGE_SIZE} more`;
      more.addEventListener('click', () => {
        if (expanded) expandedGroups.delete(project); else expandedGroups.add(project);
        renderGroups(lastReportingItems);
      });
      group.appendChild(more);
    }

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

const STATUS_OPTIONS = ['not started', 'in progress', 'blocked', 'complete'];
const PRIORITY_OPTIONS = ['high', 'medium', 'low'];
const LIFE_AREA_OPTIONS = ['career', 'personal', 'health', 'other'];
const FLEXIBILITY_OPTIONS = ['fixed', 'flexible', 'protected'];
const DRAG_BLOCKED_TAGS = ['INPUT', 'SELECT', 'TEXTAREA'];

// Some source rows use "Started"/"Not started" instead of the schema's lowercase
// enum — normalize for display so the dropdown is always usable. The underlying
// sheet value is left as-is until the user actually changes the dropdown.
function normalizeStatus(status) {
  const s = (status || '').toLowerCase();
  if (s === 'started') return 'in progress';
  if (STATUS_OPTIONS.includes(s)) return s;
  return 'not started';
}

function renderStatusRow(it) {
  const row = document.createElement('div');
  row.className = 'status-row';
  row.draggable = true;
  row.dataset.id = it.id;

  row.addEventListener('dragstart', (e) => {
    // Let clicks on form fields behave normally instead of starting a drag.
    if (DRAG_BLOCKED_TAGS.includes(e.target.tagName)) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'task', id: it.id }));
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to Today\'s Plan';

  const body = document.createElement('div');
  body.className = 'row-body';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'row-title-input';
  titleInput.value = it.title || '';
  titleInput.addEventListener('change', () => saveField(row, it.id, { title: titleInput.value }));
  body.appendChild(titleInput);

  const pills = document.createElement('div');
  pills.className = 'row-pills';

  const overdueDays = daysBetween(it.due_date);
  if (it.due_date && it.status !== 'complete' && overdueDays > 0) {
    pills.appendChild(makePill('pink', 'overdue'));
  }

  if (it.type) pills.appendChild(makePill(typePillColor(it.type), it.type));

  const normalizedArea = LIFE_AREA_OPTIONS.includes(it.life_area) ? it.life_area : 'other';
  pills.appendChild(makeEditableSelect(LIFE_AREA_OPTIONS, normalizedArea, () => 'gray', (val) => {
    saveField(row, it.id, { life_area: val });
  }));

  pills.appendChild(makeEditableSelect(STATUS_OPTIONS, normalizeStatus(it.status), statusPillColor, (val) => {
    saveField(row, it.id, { status: val });
  }));

  const normalizedPriority = PRIORITY_OPTIONS.includes(it.priority) ? it.priority : 'medium';
  pills.appendChild(makeEditableSelect(PRIORITY_OPTIONS, normalizedPriority, priorityPillColor, (val) => {
    saveField(row, it.id, { priority: val });
  }));

  const normalizedFlex = FLEXIBILITY_OPTIONS.includes(it.flexibility) ? it.flexibility : 'flexible';
  pills.appendChild(makeEditableSelect(FLEXIBILITY_OPTIONS, normalizedFlex, () => 'gray', (val) => {
    saveField(row, it.id, { flexibility: val });
  }));

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'pill-date pill-gray';
  dateInput.value = toDateInputValue(it.due_date);
  dateInput.addEventListener('change', () => {
    saveField(row, it.id, { due_date: dateInput.value });
  });
  pills.appendChild(dateInput);

  body.appendChild(pills);

  const nextStepsInput = document.createElement('input');
  nextStepsInput.type = 'text';
  nextStepsInput.className = 'next-steps-input';
  nextStepsInput.placeholder = 'Next step...';
  nextStepsInput.value = it.next_steps || '';
  nextStepsInput.addEventListener('change', () => saveField(row, it.id, { next_steps: nextStepsInput.value }));
  body.appendChild(nextStepsInput);

  row.appendChild(handle);
  row.appendChild(body);
  return row;
}

async function saveField(rowEl, id, fields) {
  const result = await updateReportingField(id, fields);
  if (result.ok) {
    flashSaved(rowEl);
    // Delayed so the save flash is visible before the refresh replaces this row
    // (banners/glance stats/overdue status/grouping can all shift based on this
    // edit). This only touches reporting-derived views, never Today's Plan.
    setTimeout(() => refreshReportingOnly(), 900);
  }
}

function makeEditableSelect(options, current, colorFn, onChange) {
  const select = document.createElement('select');
  select.className = `pill-select pill-${colorFn(current)}`;
  options.forEach((opt) => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === current) o.selected = true;
    select.appendChild(o);
  });
  select.addEventListener('change', () => {
    select.className = `pill-select pill-${colorFn(select.value)}`;
    onChange(select.value);
  });
  return select;
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

// --- Timeline (plotted by due_date; true start/end bars would need a start_date column) ---

const TIMELINE_STATUS_LEGEND = ['not started', 'in progress', 'blocked', 'complete'];

function renderTimeline(items) {
  timelineRows.innerHTML = '';
  timelineHeader.innerHTML = '';
  renderTimelineLegend();

  const withDates = items.filter((it) => it.parent && !isNaN(new Date(it.due_date)));
  if (withDates.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No dated project items to plot yet.';
    timelineRows.appendChild(empty);
    return;
  }

  const times = withDates.map((it) => new Date(it.due_date).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(max - min, 1);
  const today = Date.now();

  renderTimelineHeader(min, max, span, today);

  const byProject = {};
  withDates.forEach((it) => {
    if (!byProject[it.parent]) byProject[it.parent] = [];
    byProject[it.parent].push(it);
  });

  Object.keys(byProject).sort().forEach((project) => {
    const row = document.createElement('div');
    row.className = 'timeline-row';

    const label = document.createElement('div');
    label.className = 'timeline-project-label';
    label.textContent = project;
    label.title = project;

    const track = document.createElement('div');
    track.className = 'timeline-track';

    if (today >= min && today <= max) {
      const todayLine = document.createElement('div');
      todayLine.className = 'timeline-today-line';
      todayLine.style.left = `${((today - min) / span) * 100}%`;
      todayLine.title = 'Today';
      track.appendChild(todayLine);
    }

    byProject[project].forEach((it) => {
      const marker = document.createElement('div');
      marker.className = 'timeline-marker';
      marker.style.left = `${((new Date(it.due_date).getTime() - min) / span) * 100}%`;
      marker.style.background = `var(--pill-${statusPillColor(normalizeStatus(it.status))}-fg)`;
      marker.title = `${it.title} — ${normalizeStatus(it.status)} — due ${formatDate(it.due_date)}`;
      track.appendChild(marker);
    });

    row.appendChild(label);
    row.appendChild(track);
    timelineRows.appendChild(row);
  });
}

function renderTimelineLegend() {
  timelineLegend.innerHTML = '';
  TIMELINE_STATUS_LEGEND.forEach((status) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = `var(--pill-${statusPillColor(status)}-fg)`;
    const label = document.createElement('span');
    label.textContent = status;
    item.appendChild(dot);
    item.appendChild(label);
    timelineLegend.appendChild(item);
  });
}

function renderTimelineHeader(min, max, span, today) {
  const spacer = document.createElement('div');
  spacer.className = 'header-spacer';

  const headerTrack = document.createElement('div');
  headerTrack.className = 'header-track';

  const monthTicks = document.createElement('div');
  monthTicks.className = 'timeline-month-ticks';

  const cursor = new Date(min);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= max) {
    const pos = ((cursor.getTime() - min) / span) * 100;
    if (pos >= 0 && pos <= 100) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = `${pos}%`;
      tick.textContent = cursor.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      monthTicks.appendChild(tick);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const todayMarker = document.createElement('div');
  todayMarker.className = 'timeline-today-marker';
  if (today >= min && today <= max) {
    const label = document.createElement('div');
    label.className = 'marker-label';
    label.style.left = `${((today - min) / span) * 100}%`;
    label.textContent = '▾ We are here';
    todayMarker.appendChild(label);
  }

  headerTrack.appendChild(monthTicks);
  headerTrack.appendChild(todayMarker);

  timelineHeader.appendChild(spacer);
  timelineHeader.appendChild(headerTrack);
}

// --- Today's Plan (local cart, rendered from `cart` array order — user-arranged, not auto-sorted) ---

function renderPlan(items) {
  planRows.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No plan yet. Drag a task in from the Master Task List.';
    planRows.appendChild(empty);
    return;
  }

  items.forEach((row) => {
    const sourceItem = lastReportingItems.find((it) => it.id === row.source_item_id);
    const el = sourceItem ? renderLinkedPlanRow(row, sourceItem) : renderAdHocPlanRow(row);
    el.dataset.planId = row.id;
    el.draggable = true;

    el.addEventListener('dragstart', (e) => {
      if (DRAG_BLOCKED_TAGS.includes(e.target.tagName)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'plan', id: row.id }));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', (e) => {
      el.classList.remove('dragging');
      clearDropIndicators();
      // dropEffect is 'none' when the drag ended somewhere that never accepted it
      // (dragover never called preventDefault) — i.e. dropped outside the plan list.
      if (e.dataTransfer.dropEffect === 'none') {
        cart = cart.filter((c) => c.id !== row.id);
        setDirty(true);
        renderPlan(cart);
      }
    });

    planRows.appendChild(el);
  });
}

// Tile for a plan row linked to a real Master Task List item — mirrors that row's
// live title/type/status/priority (not a frozen copy) plus scheduling-only fields.
// All edits here mutate the cart's row object directly and stay local until Save Plan.
function renderLinkedPlanRow(row, sourceItem) {
  const included = row.include === true || row.include === 'true' || row.include === 'TRUE';

  const wrap = document.createElement('div');
  wrap.className = 'plan-row linked' + (included ? '' : ' excluded');

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = included;
  checkbox.title = 'Include on Approve';
  checkbox.addEventListener('change', () => {
    row.include = checkbox.checked;
    wrap.classList.toggle('excluded', !checkbox.checked);
    setDirty(true);
    flashSaved(wrap);
  });

  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = sourceItem.title;

  const pills = document.createElement('div');
  pills.className = 'row-pills';
  if (sourceItem.type) pills.appendChild(makePill(typePillColor(sourceItem.type), sourceItem.type));
  pills.appendChild(makePill(statusPillColor(normalizeStatus(sourceItem.status)), normalizeStatus(sourceItem.status)));
  if (sourceItem.priority) pills.appendChild(makePill(priorityPillColor(sourceItem.priority), sourceItem.priority));

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'schedule-input';
  timeInput.value = row.start_time || '';
  timeInput.title = 'Start time';
  timeInput.addEventListener('change', () => {
    row.start_time = timeInput.value;
    setDirty(true);
    flashSaved(wrap);
  });

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.className = 'schedule-input';
  durationInput.placeholder = 'min';
  durationInput.value = row.duration_minutes || '';
  durationInput.title = 'Duration (minutes)';
  durationInput.addEventListener('change', () => {
    row.duration_minutes = durationInput.value;
    setDirty(true);
    flashSaved(wrap);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Remove from Today\'s Plan';
  deleteBtn.addEventListener('click', () => {
    cart = cart.filter((c) => c.id !== row.id);
    setDirty(true);
    renderPlan(cart);
  });

  wrap.appendChild(handle);
  wrap.appendChild(checkbox);
  wrap.appendChild(title);
  wrap.appendChild(pills);
  wrap.appendChild(timeInput);
  wrap.appendChild(durationInput);
  wrap.appendChild(deleteBtn);
  return wrap;
}

// Fallback for legacy/ad-hoc PendingPlan rows with no matching Master Task List
// item (e.g. rows created before this change, or a linked task that's since been
// deleted). Keeps the older full-field editor so nothing existing silently breaks;
// nothing new is created via this path anymore.
function renderAdHocPlanRow(row) {
  const included = row.include === true || row.include === 'true' || row.include === 'TRUE';

  const wrap = document.createElement('div');
  wrap.className = 'plan-row' + (included ? '' : ' excluded');

  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.textContent = '⠿';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = included;
  checkbox.title = 'Include on Approve';
  checkbox.addEventListener('change', () => {
    row.include = checkbox.checked;
    wrap.classList.toggle('excluded', !checkbox.checked);
    setDirty(true);
    flashSaved(wrap);
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

  titleInput.addEventListener('change', () => { row.title = titleInput.value; setDirty(true); flashSaved(wrap); });
  dateInput.addEventListener('change', () => { row.date = dateInput.value; setDirty(true); flashSaved(wrap); });
  timeInput.addEventListener('change', () => { row.start_time = timeInput.value; setDirty(true); flashSaved(wrap); });
  durationInput.addEventListener('change', () => { row.duration_minutes = durationInput.value; setDirty(true); flashSaved(wrap); });
  notesInput.addEventListener('change', () => { row.notes = notesInput.value; setDirty(true); flashSaved(wrap); });

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
  deleteBtn.addEventListener('click', () => {
    cart = cart.filter((c) => c.id !== row.id);
    setDirty(true);
    renderPlan(cart);
  });

  wrap.appendChild(handle);
  wrap.appendChild(checkbox);
  wrap.appendChild(fields);
  wrap.appendChild(deleteBtn);
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
