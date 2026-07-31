// Fill in after deploying the Apps Script web app (see /apps-script/README.md).
const API_URL = 'PASTE_APPS_SCRIPT_WEB_APP_URL_HERE';
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

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const candidate = document.getElementById('gate-secret').value;
  gateError.classList.add('hidden');
  const ok = await loadDashboard(candidate);
  if (ok) {
    secret = candidate;
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    pollTimer = setInterval(() => loadDashboard(secret), POLL_INTERVAL_MS);
  } else {
    gateError.classList.remove('hidden');
  }
});

refreshBtn.addEventListener('click', () => {
  if (secret) loadDashboard(secret);
});

async function loadDashboard(key) {
  try {
    const res = await fetch(`${API_URL}?key=${encodeURIComponent(key)}`);
    const data = await res.json();
    if (data.error) return false;
    render(data.items || []);
    return true;
  } catch (err) {
    return false;
  }
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr);
  if (isNaN(then)) return null;
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function render(items) {
  renderBanners(items);
  renderGroups(items);
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
  statusGroups.innerHTML = '';
  const byArea = {};
  items.forEach((it) => {
    const area = it.life_area || 'other';
    if (!byArea[area]) byArea[area] = [];
    byArea[area].push(it);
  });

  Object.keys(byArea).sort().forEach((area) => {
    const group = document.createElement('div');
    group.className = 'group';

    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = area;
    group.appendChild(title);

    byArea[area].forEach((it) => group.appendChild(renderItemCard(it)));
    statusGroups.appendChild(group);
  });
}

function renderItemCard(it) {
  const card = document.createElement('div');
  card.className = 'item-card';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = it.title;

  const overdueDays = daysBetween(it.due_date);
  if (it.due_date && it.status !== 'complete' && overdueDays > 0) {
    const tag = document.createElement('span');
    tag.className = 'tag overdue';
    tag.textContent = 'overdue';
    title.appendChild(tag);
  }

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const bits = [it.type, it.status, it.due_date ? `due ${it.due_date}` : null, it.priority]
    .filter(Boolean);
  meta.textContent = bits.join(' · ');

  card.appendChild(title);
  card.appendChild(meta);
  return card;
}
