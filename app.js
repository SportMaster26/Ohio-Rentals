// Ohio Rentals — Fleet & Rental Tracker
// Single-page app, data persisted in localStorage.

const STORE_KEY = 'ohio-rentals:v1';

const DEFAULT_CHECKLIST_OUT = [
  'Fluids checked (oil, hydraulic, fuel)',
  'Tires / tracks inspected',
  'Lights & safety equipment working',
  'No visible damage (photo on file)',
  'Operator manual present',
  'Customer signed rental agreement',
];

const DEFAULT_CHECKLIST_IN = [
  'Returned with full fuel',
  'No new damage',
  'Cleaned / pressure washed',
  'Fluids topped off',
  'Hour meter reading recorded',
  'Attachments / accessories returned',
];

// ---------- Data layer ----------

const db = loadDb();

function loadDb() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.error('load failed', e); }
  return { equipment: [], rentals: [], maintenance: [] };
}

function saveDb() {
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function nowIso() { return new Date().toISOString(); }

// ---------- Status logic ----------

function rentalStatus(r) {
  if (r.actualReturn) return 'returned';
  const now = new Date();
  const out = new Date(r.timeOut);
  const due = new Date(r.timeIn);
  if (now < out) return 'scheduled';
  if (now > due) return 'overdue';
  return 'active';
}

function equipmentStatus(eq) {
  if (eq.maintenance) return 'maintenance';
  const rentals = db.rentals.filter(r => r.equipmentId === eq.id && !r.actualReturn);
  for (const r of rentals) {
    const s = rentalStatus(r);
    if (s === 'active' || s === 'overdue') return 'rented';
  }
  if (rentals.some(r => rentalStatus(r) === 'scheduled')) return 'scheduled';
  return 'available';
}

function activeRental(eq) {
  return db.rentals.find(r => r.equipmentId === eq.id && !r.actualReturn && ['active','overdue'].includes(rentalStatus(r)));
}

function nextScheduled(eq) {
  return db.rentals
    .filter(r => r.equipmentId === eq.id && !r.actualReturn && rentalStatus(r) === 'scheduled')
    .sort((a, b) => new Date(a.timeOut) - new Date(b.timeOut))[0];
}

function checklistIncomplete(r) {
  const status = rentalStatus(r);
  if (status === 'scheduled') return false; // not due yet
  if (status === 'returned') return (r.checklistIn || []).some(i => !i.checked);
  // active or overdue: out checklist should be done
  return (r.checklistOut || []).some(i => !i.checked);
}

// ---------- Conflict check ----------

function findConflicts(equipmentId, timeOut, timeIn, ignoreRentalId) {
  const out = new Date(timeOut);
  const dueIn = new Date(timeIn);
  return db.rentals.filter(r => {
    if (r.id === ignoreRentalId) return false;
    if (r.equipmentId !== equipmentId) return false;
    if (r.actualReturn) return false;
    const ro = new Date(r.timeOut);
    const ri = new Date(r.timeIn);
    return ro < dueIn && out < ri;
  });
}

// ---------- Formatting ----------

function fmtDt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function eqName(id) {
  const eq = db.equipment.find(e => e.id === id);
  return eq ? `${eq.name} (${eq.unitId || eq.id})` : 'Unknown';
}

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

// ---------- Toast ----------

function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  setTimeout(() => el.classList.add('hidden'), 3500);
  el.classList.remove('hidden');
}

// ---------- Routing ----------

const tabs = document.getElementById('tabs');
tabs.addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  showView(t.dataset.view);
});

function showView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  render();
  if (name === 'map' && mapInstance) {
    setTimeout(() => mapInstance.invalidateSize(), 50);
  }
}

// ---------- Modal ----------

function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// ---------- Render: dashboard ----------

function renderDashboard() {
  const eqs = db.equipment;
  const stats = { available: 0, out: 0, scheduled: 0, overdue: 0, maint: 0, checklist: 0 };
  for (const eq of eqs) {
    const s = equipmentStatus(eq);
    if (s === 'available') stats.available++;
    if (s === 'rented') stats.out++;
    if (s === 'scheduled') stats.scheduled++;
    if (s === 'maintenance') stats.maint++;
  }
  for (const r of db.rentals) {
    if (r.actualReturn) continue;
    if (rentalStatus(r) === 'overdue') stats.overdue++;
    if (checklistIncomplete(r)) stats.checklist++;
  }

  document.getElementById('stat-available').textContent = stats.available;
  document.getElementById('stat-out').textContent = stats.out;
  document.getElementById('stat-scheduled').textContent = stats.scheduled;
  document.getElementById('stat-overdue').textContent = stats.overdue;
  document.getElementById('stat-maint').textContent = stats.maint;
  document.getElementById('stat-checklist').textContent = stats.checklist;

  // Out now
  const active = db.rentals
    .filter(r => !r.actualReturn && ['active', 'overdue'].includes(rentalStatus(r)))
    .sort((a, b) => new Date(a.timeIn) - new Date(b.timeIn));
  document.getElementById('dash-active').innerHTML = active.length
    ? active.map(r => `
      <div class="item">
        <div>
          <strong>${eqName(r.equipmentId)}</strong>
          <div class="meta">${r.customer} · ${r.location || 'no location'}</div>
        </div>
        <div class="meta">
          ${badge(rentalStatus(r))}<br/>
          due ${fmtDt(r.timeIn)}
        </div>
      </div>
    `).join('')
    : '<div class="empty">Nothing out right now.</div>';

  // Upcoming
  const upcoming = db.rentals
    .filter(r => !r.actualReturn && rentalStatus(r) === 'scheduled')
    .sort((a, b) => new Date(a.timeOut) - new Date(b.timeOut))
    .slice(0, 8);
  document.getElementById('dash-upcoming').innerHTML = upcoming.length
    ? upcoming.map(r => `
      <div class="item">
        <div>
          <strong>${eqName(r.equipmentId)}</strong>
          <div class="meta">${r.customer} · ${r.location || 'no location'}</div>
        </div>
        <div class="meta">out ${fmtDt(r.timeOut)}</div>
      </div>
    `).join('')
    : '<div class="empty">No upcoming rentals.</div>';

  // Attention
  const attention = [];
  for (const r of db.rentals) {
    if (r.actualReturn) continue;
    const s = rentalStatus(r);
    if (s === 'overdue') attention.push({ kind: 'overdue', text: `OVERDUE: ${eqName(r.equipmentId)} — was due ${fmtDt(r.timeIn)} (${r.customer})`, rentalId: r.id });
    if (checklistIncomplete(r)) attention.push({ kind: 'checklist', text: `Checklist incomplete: ${eqName(r.equipmentId)} — ${r.customer}`, rentalId: r.id });
  }
  for (const eq of db.equipment) {
    if (eq.maintenance) attention.push({ kind: 'maint', text: `${eq.name} flagged for maintenance: ${eq.maintenanceNotes || 'see notes'}`, equipmentId: eq.id });
    else if (eq.maintenanceDue && new Date(eq.maintenanceDue) <= new Date(Date.now() + 7*864e5)) {
      attention.push({ kind: 'maint', text: `${eq.name} maintenance due ${fmtDate(eq.maintenanceDue)}`, equipmentId: eq.id });
    }
  }
  document.getElementById('dash-attention').innerHTML = attention.length
    ? attention.map(a => `<div class="item"><span>${a.text}</span></div>`).join('')
    : '<div class="empty">All clear.</div>';
}

// ---------- Render: equipment ----------

function renderEquipment() {
  const search = (document.getElementById('eq-search').value || '').toLowerCase();
  const statusFilter = document.getElementById('eq-filter-status').value;
  const tbody = document.getElementById('eq-tbody');
  let rows = db.equipment;
  if (search) {
    rows = rows.filter(eq =>
      (eq.name + ' ' + (eq.type||'') + ' ' + (eq.unitId||'') + ' ' + eq.id).toLowerCase().includes(search)
    );
  }
  if (statusFilter) rows = rows.filter(eq => equipmentStatus(eq) === statusFilter);

  tbody.innerHTML = rows.length ? rows.map(eq => {
    const s = equipmentStatus(eq);
    const a = activeRental(eq);
    const next = !a ? nextScheduled(eq) : null;
    const where = a
      ? `${a.customer} @ ${a.location || '—'}`
      : next
        ? `(scheduled) ${next.customer} @ ${next.location || '—'}`
        : '—';
    const due = a ? fmtDt(a.timeIn) : (next ? fmtDt(next.timeOut) + ' out' : '—');
    const maint = eq.maintenance
      ? `<span class="text-bad">DOWN</span>`
      : eq.maintenanceDue
        ? `due ${fmtDate(eq.maintenanceDue)}`
        : '—';
    return `
      <tr>
        <td class="nowrap">${eq.unitId || eq.id}</td>
        <td><strong>${eq.name}</strong></td>
        <td>${eq.type || '—'}</td>
        <td>${badge(s)}</td>
        <td>${where}</td>
        <td class="nowrap">${due}</td>
        <td class="nowrap">${maint}</td>
        <td class="row-actions">
          <button class="btn small" data-act="edit-eq" data-id="${eq.id}">Edit</button>
          <button class="btn small" data-act="rent-eq" data-id="${eq.id}">Rent</button>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="8" class="text-muted" style="text-align:center;padding:24px">No equipment yet. Click "+ Add Equipment" to start.</td></tr>`;
}

// ---------- Render: rentals ----------

function renderRentals() {
  const search = (document.getElementById('rent-search').value || '').toLowerCase();
  const statusFilter = document.getElementById('rent-filter-status').value;
  const tbody = document.getElementById('rent-tbody');

  let rows = [...db.rentals].sort((a, b) => new Date(b.timeOut) - new Date(a.timeOut));
  if (search) {
    rows = rows.filter(r =>
      (r.customer + ' ' + (r.location||'') + ' ' + eqName(r.equipmentId)).toLowerCase().includes(search)
    );
  }
  if (statusFilter) rows = rows.filter(r => rentalStatus(r) === statusFilter);

  tbody.innerHTML = rows.length ? rows.map(r => {
    const s = rentalStatus(r);
    const outDone = (r.checklistOut || []).filter(i => i.checked).length;
    const outTotal = (r.checklistOut || []).length;
    const inDone = (r.checklistIn || []).filter(i => i.checked).length;
    const inTotal = (r.checklistIn || []).length;
    const checkBadge = s === 'returned'
      ? `Out ${outDone}/${outTotal} · In ${inDone}/${inTotal}`
      : `Out ${outDone}/${outTotal}`;
    const returnBtn = r.actualReturn
      ? ''
      : `<button class="btn small primary" data-act="return-rental" data-id="${r.id}">Check In</button>`;
    return `
      <tr>
        <td>${eqName(r.equipmentId)}</td>
        <td>${r.customer}</td>
        <td>${r.location || '—'}</td>
        <td class="nowrap">${fmtDt(r.timeOut)}</td>
        <td class="nowrap">${fmtDt(r.timeIn)}${r.actualReturn ? `<br/><span class="text-muted">in: ${fmtDt(r.actualReturn)}</span>` : ''}</td>
        <td>${badge(s)}</td>
        <td>${checkBadge}</td>
        <td class="row-actions">
          <button class="btn small" data-act="edit-rental" data-id="${r.id}">Open</button>
          ${returnBtn}
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="8" class="text-muted" style="text-align:center;padding:24px">No rentals yet. Click "+ New Rental" to schedule one.</td></tr>`;
}

// ---------- Render: schedule ----------

function renderSchedule() {
  const sel = document.getElementById('sched-equipment');
  const currentValue = sel.value;
  sel.innerHTML = '<option value="">All</option>' + db.equipment.map(eq =>
    `<option value="${eq.id}">${eq.name}</option>`
  ).join('');
  sel.value = currentValue;

  const fromInput = document.getElementById('sched-from');
  const toInput = document.getElementById('sched-to');
  if (!fromInput.value) {
    const now = new Date();
    fromInput.value = now.toISOString().slice(0, 10);
    const end = new Date(now.getTime() + 14 * 864e5);
    toInput.value = end.toISOString().slice(0, 10);
  }

  const from = new Date(fromInput.value + 'T00:00:00');
  const to = new Date(toInput.value + 'T23:59:59');
  const totalMs = to - from;
  const board = document.getElementById('schedule-board');

  if (totalMs <= 0) {
    board.innerHTML = '<div class="empty">Choose a "to" date after the "from" date.</div>';
    return;
  }

  const eqList = sel.value
    ? db.equipment.filter(e => e.id === sel.value)
    : db.equipment;

  if (!eqList.length) {
    board.innerHTML = '<div class="empty">No equipment to display.</div>';
    return;
  }

  const days = Math.max(1, Math.round(totalMs / 864e5));
  const axisLabels = [];
  for (let i = 0; i <= days; i += Math.max(1, Math.floor(days / 7))) {
    const d = new Date(from.getTime() + i * 864e5);
    axisLabels.push(d.toLocaleDateString([], { month: 'short', day: 'numeric' }));
  }

  let html = `<div class="axis"><span>${axisLabels[0] || ''}</span><span>${axisLabels[axisLabels.length - 1] || ''}</span></div>`;

  for (const eq of eqList) {
    const rentals = db.rentals.filter(r => r.equipmentId === eq.id && !r.actualReturn);
    const blocks = rentals.map(r => {
      const out = new Date(r.timeOut);
      const due = new Date(r.timeIn);
      if (due < from || out > to) return '';
      const startMs = Math.max(out - from, 0);
      const endMs = Math.min(due - from, totalMs);
      const left = (startMs / totalMs) * 100;
      const width = Math.max(((endMs - startMs) / totalMs) * 100, 1);
      const s = rentalStatus(r);
      return `<div class="block ${s}" style="left:${left}%;width:${width}%" title="${r.customer} @ ${r.location || ''} ${fmtDt(r.timeOut)} → ${fmtDt(r.timeIn)}">${r.customer}</div>`;
    }).join('');
    const downBlock = eq.maintenance ? `<div class="block overdue" style="left:0;width:100%" title="Down for maintenance">Down for maintenance</div>` : '';
    html += `<div class="row">
      <div class="name">${eq.name}<div class="meta text-muted" style="font-size:11px">${eq.type || ''}</div></div>
      <div class="timeline">${downBlock || blocks || ''}</div>
    </div>`;
  }
  board.innerHTML = html;
}

// ---------- Render: maintenance ----------

function renderMaintenance() {
  const down = db.equipment.filter(e => e.maintenance);
  document.getElementById('maint-down').innerHTML = down.length
    ? down.map(e => `
      <div class="item">
        <div>
          <strong>${e.name}</strong> (${e.unitId || e.id})
          <div class="meta">${e.maintenanceNotes || ''}</div>
        </div>
        <div class="row-actions">
          <button class="btn small" data-act="edit-eq" data-id="${e.id}">Edit</button>
          <button class="btn small primary" data-act="clear-maint" data-id="${e.id}">Mark Serviced</button>
        </div>
      </div>
    `).join('')
    : '<div class="empty">No equipment is currently down.</div>';

  const due = db.equipment.filter(e => !e.maintenance && e.maintenanceDue && new Date(e.maintenanceDue) <= new Date(Date.now() + 30*864e5));
  document.getElementById('maint-due').innerHTML = due.length
    ? due.map(e => `
      <div class="item">
        <div>
          <strong>${e.name}</strong>
          <div class="meta">${e.type || ''}</div>
        </div>
        <div class="meta">due ${fmtDate(e.maintenanceDue)}</div>
      </div>
    `).join('')
    : '<div class="empty">Nothing coming due in the next 30 days.</div>';

  const tb = document.getElementById('maint-history');
  const records = [...db.maintenance].sort((a, b) => new Date(b.date) - new Date(a.date));
  tb.innerHTML = records.length ? records.map(m => {
    const eq = db.equipment.find(e => e.id === m.equipmentId);
    return `<tr>
      <td class="nowrap">${fmtDate(m.date)}</td>
      <td>${eq ? eq.name : '(removed)'}</td>
      <td>${m.notes || ''}</td>
      <td>${m.by || ''}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="4" class="text-muted" style="text-align:center;padding:18px">No service history yet.</td></tr>`;
}

// ---------- Map ----------

const OHIO_CENTER = [40.4173, -82.9071];
const OHIO_ZOOM = 7;
let mapInstance = null;
let mapMarkers = [];
let geocodeQueue = [];
let geocodeRunning = false;

function ensureMap() {
  if (mapInstance) return mapInstance;
  if (!window.L) return null;
  const el = document.getElementById('map');
  if (!el) return null;
  mapInstance = L.map(el, { zoomControl: true }).setView(OHIO_CENTER, OHIO_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(mapInstance);
  return mapInstance;
}

function clearMarkers() {
  mapMarkers.forEach(m => m.remove());
  mapMarkers = [];
}

function pinIcon(color) {
  // Simple colored circle marker via L.divIcon
  return L.divIcon({
    className: 'rental-pin',
    html: `<div style="background:${color};width:18px;height:18px;border-radius:50%;border:3px solid white;box-shadow:0 0 0 1px rgba(0,0,0,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function statusColor(status) {
  return ({
    scheduled: '#0ea5e9',
    active: '#2563eb',
    overdue: '#dc2626',
    returned: '#94a3b8',
    maintenance: '#d97706',
  })[status] || '#94a3b8';
}

function setMapStatus(text) {
  const el = document.getElementById('map-status');
  if (el) el.textContent = text || '';
}

async function geocodeAddress(address) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' +
    encodeURIComponent(address);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('Geocoder error ' + res.status);
  const data = await res.json();
  if (!data.length) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    display: data[0].display_name,
    geocodedAt: nowIso(),
  };
}

function queueGeocode(rental) {
  if (!rental.location) return;
  if (rental.geocode && rental.geocode.queryFor === rental.location) return;
  if (geocodeQueue.includes(rental.id)) return;
  geocodeQueue.push(rental.id);
  runGeocodeQueue();
}

async function runGeocodeQueue() {
  if (geocodeRunning) return;
  geocodeRunning = true;
  while (geocodeQueue.length) {
    const id = geocodeQueue.shift();
    const r = db.rentals.find(x => x.id === id);
    if (!r || !r.location) continue;
    setMapStatus(`Looking up ${r.location}...`);
    try {
      const g = await geocodeAddress(r.location);
      if (g) {
        r.geocode = { ...g, queryFor: r.location };
      } else {
        r.geocode = { failed: true, queryFor: r.location, geocodedAt: nowIso() };
      }
      saveDb();
      if (document.querySelector('.tab.active').dataset.view === 'map') renderMap();
    } catch (err) {
      console.warn('Geocode failed', err);
    }
    // Nominatim policy: max 1 request per second
    await new Promise(r => setTimeout(r, 1100));
  }
  setMapStatus('');
  geocodeRunning = false;
}

function rentalsForMapFilter() {
  const filter = document.getElementById('map-filter')?.value || 'active';
  return db.rentals.filter(r => {
    if (r.actualReturn) return false;
    const s = rentalStatus(r);
    if (filter === 'active') return s === 'active' || s === 'overdue';
    if (filter === 'upcoming') return s === 'active' || s === 'overdue' || s === 'scheduled';
    return true;
  });
}

function renderMap() {
  const map = ensureMap();
  if (!map) return;
  clearMarkers();
  const rentals = rentalsForMapFilter();
  const bounds = [];
  let pending = 0;
  for (const r of rentals) {
    if (!r.location) continue;
    if (!r.geocode || r.geocode.queryFor !== r.location) {
      queueGeocode(r);
      pending++;
      continue;
    }
    if (r.geocode.failed) continue;
    const s = rentalStatus(r);
    const marker = L.marker([r.geocode.lat, r.geocode.lng], { icon: pinIcon(statusColor(s)) }).addTo(map);
    const popupHtml = `
      <div style="font-family:inherit;min-width:200px">
        <div style="font-weight:600;margin-bottom:4px">${eqName(r.equipmentId)}</div>
        <div><strong>${r.customer}</strong>${r.customerPhone ? ' · ' + r.customerPhone : ''}</div>
        <div style="color:#555;margin:4px 0">${r.location}</div>
        <div style="font-size:12px">Out: ${fmtDt(r.timeOut)}<br/>Due: ${fmtDt(r.timeIn)}</div>
        <div style="margin-top:6px">${badge(s)}</div>
      </div>`;
    marker.bindPopup(popupHtml);
    mapMarkers.push(marker);
    bounds.push([r.geocode.lat, r.geocode.lng]);
  }
  if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
  } else {
    map.setView(OHIO_CENTER, OHIO_ZOOM);
  }
  if (pending) {
    setMapStatus(`Geocoding ${pending} location${pending > 1 ? 's' : ''}...`);
  }
}

// ---------- Render router ----------

function render() {
  const view = document.querySelector('.tab.active').dataset.view;
  if (view === 'dashboard') renderDashboard();
  if (view === 'equipment') renderEquipment();
  if (view === 'rentals') renderRentals();
  if (view === 'schedule') renderSchedule();
  if (view === 'map') renderMap();
  if (view === 'maintenance') renderMaintenance();
}

// ---------- Equipment forms ----------

function equipmentForm(eq) {
  const isEdit = !!eq;
  eq = eq || { id: '', unitId: '', name: '', type: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' };
  const dueValue = eq.maintenanceDue ? eq.maintenanceDue.slice(0, 10) : '';
  return `
    <form id="eq-form">
      <div class="form-row two-up">
        <div>
          <label>Unit ID / Number</label>
          <input name="unitId" value="${eq.unitId || ''}" placeholder="e.g. SS-103" />
        </div>
        <div>
          <label>Name *</label>
          <input name="name" required value="${eq.name || ''}" placeholder="e.g. Bobcat Skid Steer" />
        </div>
      </div>
      <div class="form-row two-up">
        <div>
          <label>Type / Category</label>
          <input name="type" value="${eq.type || ''}" placeholder="Skid Steer, Excavator, etc." />
        </div>
        <div>
          <label>Maintenance Due</label>
          <input type="date" name="maintenanceDue" value="${dueValue}" />
        </div>
      </div>
      <div class="form-row">
        <label><input type="checkbox" name="maintenance" ${eq.maintenance ? 'checked' : ''}/> Currently down for maintenance</label>
      </div>
      <div class="form-row">
        <label>Maintenance notes</label>
        <textarea name="maintenanceNotes" placeholder="What's wrong / what's being serviced">${eq.maintenanceNotes || ''}</textarea>
      </div>
      <div class="form-row">
        <label>General notes</label>
        <textarea name="notes">${eq.notes || ''}</textarea>
      </div>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" id="eq-delete">Delete</button>` : ''}
        <button type="button" class="btn ghost" id="eq-cancel">Cancel</button>
        <button type="submit" class="btn primary">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    </form>
  `;
}

function bindEquipmentForm(existing) {
  const form = document.getElementById('eq-form');
  document.getElementById('eq-cancel').addEventListener('click', closeModal);
  if (existing) {
    document.getElementById('eq-delete').addEventListener('click', () => {
      if (!confirm(`Delete ${existing.name}? This will also remove it from any rentals.`)) return;
      db.equipment = db.equipment.filter(e => e.id !== existing.id);
      db.rentals = db.rentals.filter(r => r.equipmentId !== existing.id);
      saveDb(); closeModal(); render();
      toast('Equipment deleted.');
    });
  }
  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    data.maintenance = fd.get('maintenance') === 'on';
    if (!data.name.trim()) return toast('Name is required.', 'error');
    if (data.maintenanceDue) data.maintenanceDue = new Date(data.maintenanceDue).toISOString();

    if (existing) {
      const wasDown = existing.maintenance;
      Object.assign(existing, data);
      if (!wasDown && data.maintenance) {
        // started maintenance — record service entry on clear
      }
    } else {
      db.equipment.push({ id: uid('eq'), ...data });
    }
    saveDb(); closeModal(); render();
    toast(existing ? 'Equipment updated.' : 'Equipment added.');
  });
}

// ---------- Rental form ----------

function rentalForm(r) {
  const isEdit = !!r;
  r = r || {
    id: '', equipmentId: '', customer: '', customerPhone: '', location: '',
    timeOut: '', timeIn: '', notes: '',
    checklistOut: DEFAULT_CHECKLIST_OUT.map(text => ({ text, checked: false })),
    checklistIn: DEFAULT_CHECKLIST_IN.map(text => ({ text, checked: false })),
    actualReturn: ''
  };
  const eqOptions = db.equipment.map(eq =>
    `<option value="${eq.id}" ${eq.id === r.equipmentId ? 'selected' : ''}>${eq.name} (${eq.unitId || eq.id})</option>`
  ).join('');
  const status = isEdit ? rentalStatus(r) : 'scheduled';

  return `
    <form id="rent-form">
      <div class="form-row">
        <label>Equipment *</label>
        <select name="equipmentId" required>
          <option value="">— select —</option>${eqOptions}
        </select>
      </div>
      <div class="form-row two-up">
        <div>
          <label>Customer *</label>
          <input name="customer" required value="${r.customer || ''}" />
        </div>
        <div>
          <label>Phone</label>
          <input name="customerPhone" value="${r.customerPhone || ''}" />
        </div>
      </div>
      <div class="form-row">
        <label>Job site / Location *</label>
        <input name="location" required value="${r.location || ''}" placeholder="123 Main St, Columbus OH" />
      </div>
      <div class="form-row two-up">
        <div>
          <label>Time Out *</label>
          <input type="datetime-local" name="timeOut" required value="${toLocalInput(r.timeOut)}" />
        </div>
        <div>
          <label>Scheduled Time In *</label>
          <input type="datetime-local" name="timeIn" required value="${toLocalInput(r.timeIn)}" />
        </div>
      </div>
      ${isEdit ? `
        <div class="form-row">
          <label>Status</label>
          <div>${badge(status)} ${r.actualReturn ? `· returned ${fmtDt(r.actualReturn)}` : ''}</div>
        </div>
      ` : ''}
      <div class="form-row">
        <label>Pre-rental Checklist</label>
        <div class="checklist" id="check-out">
          ${(r.checklistOut || []).map((it, i) => checklistItemHtml(it, i, 'out')).join('')}
        </div>
        <div class="checklist-add">
          <input type="text" id="add-out-input" placeholder="Add a checklist item..." />
          <button type="button" class="btn small" id="add-out-btn">Add</button>
        </div>
      </div>
      <div class="form-row">
        <label>Return Checklist</label>
        <div class="checklist" id="check-in">
          ${(r.checklistIn || []).map((it, i) => checklistItemHtml(it, i, 'in')).join('')}
        </div>
        <div class="checklist-add">
          <input type="text" id="add-in-input" placeholder="Add a return checklist item..." />
          <button type="button" class="btn small" id="add-in-btn">Add</button>
        </div>
      </div>
      <div class="form-row">
        <label>Notes</label>
        <textarea name="notes">${r.notes || ''}</textarea>
      </div>
      <div class="form-actions">
        ${isEdit && !r.actualReturn ? `<button type="button" class="btn primary" id="rent-checkin">Check In Now</button>` : ''}
        ${isEdit ? `<button type="button" class="btn danger" id="rent-delete">Delete</button>` : ''}
        <button type="button" class="btn ghost" id="rent-cancel">Cancel</button>
        <button type="submit" class="btn primary">${isEdit ? 'Save' : 'Create Rental'}</button>
      </div>
    </form>
  `;
}

function checklistItemHtml(item, i, kind) {
  return `
    <div class="ck-item ${item.checked ? 'done' : ''}" data-kind="${kind}" data-idx="${i}">
      <input type="checkbox" ${item.checked ? 'checked' : ''} />
      <input type="text" value="${(item.text || '').replace(/"/g, '&quot;')}" />
      <button type="button" class="btn ghost small" data-rm>×</button>
    </div>
  `;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 16);
}

function bindRentalForm(existing) {
  const form = document.getElementById('rent-form');
  document.getElementById('rent-cancel').addEventListener('click', closeModal);

  // Working copies
  const out = (existing?.checklistOut || DEFAULT_CHECKLIST_OUT.map(text => ({ text, checked: false }))).map(x => ({ ...x }));
  const inn = (existing?.checklistIn || DEFAULT_CHECKLIST_IN.map(text => ({ text, checked: false }))).map(x => ({ ...x }));

  function rerender() {
    document.getElementById('check-out').innerHTML = out.map((it, i) => checklistItemHtml(it, i, 'out')).join('');
    document.getElementById('check-in').innerHTML = inn.map((it, i) => checklistItemHtml(it, i, 'in')).join('');
    bindChecklistEvents();
  }

  function bindChecklistEvents() {
    document.querySelectorAll('.ck-item').forEach(node => {
      const kind = node.dataset.kind;
      const idx = +node.dataset.idx;
      const arr = kind === 'out' ? out : inn;
      const cb = node.querySelector('input[type=checkbox]');
      const txt = node.querySelector('input[type=text]');
      const rm = node.querySelector('[data-rm]');
      cb.addEventListener('change', () => { arr[idx].checked = cb.checked; node.classList.toggle('done', cb.checked); });
      txt.addEventListener('input', () => { arr[idx].text = txt.value; });
      rm.addEventListener('click', () => { arr.splice(idx, 1); rerender(); });
    });
  }
  bindChecklistEvents();

  document.getElementById('add-out-btn').addEventListener('click', () => {
    const inp = document.getElementById('add-out-input');
    if (!inp.value.trim()) return;
    out.push({ text: inp.value.trim(), checked: false });
    inp.value = '';
    rerender();
  });
  document.getElementById('add-in-btn').addEventListener('click', () => {
    const inp = document.getElementById('add-in-input');
    if (!inp.value.trim()) return;
    inn.push({ text: inp.value.trim(), checked: false });
    inp.value = '';
    rerender();
  });

  if (existing) {
    document.getElementById('rent-delete').addEventListener('click', () => {
      if (!confirm('Delete this rental?')) return;
      db.rentals = db.rentals.filter(x => x.id !== existing.id);
      saveDb(); closeModal(); render();
      toast('Rental deleted.');
    });
    if (!existing.actualReturn) {
      document.getElementById('rent-checkin').addEventListener('click', () => {
        existing.actualReturn = nowIso();
        existing.checklistIn = inn;
        existing.checklistOut = out;
        saveDb(); closeModal(); render();
        toast('Equipment checked in.');
      });
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = Object.fromEntries(fd.entries());
    if (!data.equipmentId) return toast('Pick an equipment.', 'error');
    const t1 = new Date(data.timeOut);
    const t2 = new Date(data.timeIn);
    if (!(t2 > t1)) return toast('"Time In" must be after "Time Out".', 'error');

    const conflicts = findConflicts(data.equipmentId, t1.toISOString(), t2.toISOString(), existing?.id);
    if (conflicts.length) {
      const ok = confirm(`This piece is already booked during that window:\n` +
        conflicts.map(c => `• ${c.customer} ${fmtDt(c.timeOut)} → ${fmtDt(c.timeIn)}`).join('\n') +
        `\n\nSave anyway?`);
      if (!ok) return;
    }

    const eq = db.equipment.find(e => e.id === data.equipmentId);
    if (eq && eq.maintenance) {
      const ok = confirm(`${eq.name} is currently flagged for maintenance. Save rental anyway?`);
      if (!ok) return;
    }

    const payload = {
      equipmentId: data.equipmentId,
      customer: data.customer.trim(),
      customerPhone: data.customerPhone || '',
      location: data.location.trim(),
      timeOut: t1.toISOString(),
      timeIn: t2.toISOString(),
      notes: data.notes || '',
      checklistOut: out,
      checklistIn: inn,
    };

    let saved;
    if (existing) {
      // If location changed, drop the old geocode so it re-runs.
      if (existing.location !== payload.location) existing.geocode = null;
      Object.assign(existing, payload);
      saved = existing;
    } else {
      saved = { id: uid('r'), actualReturn: '', ...payload };
      db.rentals.push(saved);
    }
    saveDb(); closeModal(); render();
    queueGeocode(saved);
    toast(existing ? 'Rental updated.' : 'Rental created.');
  });
}

// ---------- Maintenance flag dialog ----------

function maintenanceFlagForm() {
  const eqOptions = db.equipment.map(eq => `<option value="${eq.id}">${eq.name}</option>`).join('');
  return `
    <form id="maint-form">
      <div class="form-row">
        <label>Equipment *</label>
        <select name="equipmentId" required><option value="">— select —</option>${eqOptions}</select>
      </div>
      <div class="form-row">
        <label>What's wrong / what's being done?</label>
        <textarea name="notes" required></textarea>
      </div>
      <div class="form-row">
        <label>Reported by</label>
        <input name="by" />
      </div>
      <div class="form-actions">
        <button type="button" class="btn ghost" id="maint-cancel">Cancel</button>
        <button type="submit" class="btn primary">Flag</button>
      </div>
    </form>`;
}

function bindMaintenanceForm() {
  document.getElementById('maint-cancel').addEventListener('click', closeModal);
  document.getElementById('maint-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const id = fd.get('equipmentId');
    const eq = db.equipment.find(x => x.id === id);
    if (!eq) return;
    eq.maintenance = true;
    eq.maintenanceNotes = fd.get('notes');
    db.maintenance.push({
      id: uid('m'), equipmentId: id, date: nowIso(),
      notes: 'FLAGGED: ' + fd.get('notes'),
      by: fd.get('by') || ''
    });
    saveDb(); closeModal(); render();
    toast(`${eq.name} flagged for maintenance.`);
  });
}

function clearMaintenance(id) {
  const eq = db.equipment.find(e => e.id === id);
  if (!eq) return;
  const note = prompt(`Service notes for ${eq.name}:`, eq.maintenanceNotes || '');
  if (note === null) return;
  const by = prompt('Serviced by:', '') || '';
  db.maintenance.push({ id: uid('m'), equipmentId: id, date: nowIso(), notes: 'SERVICED: ' + note, by });
  eq.maintenance = false;
  eq.maintenanceNotes = '';
  // bump next maintenance due 90 days out by default
  eq.maintenanceDue = new Date(Date.now() + 90 * 864e5).toISOString();
  saveDb(); render();
  toast(`${eq.name} marked as serviced.`);
}

// ---------- Wiring ----------

document.getElementById('eq-add-btn').addEventListener('click', () => {
  openModal('Add Equipment', equipmentForm(null));
  bindEquipmentForm(null);
});
document.getElementById('rent-add-btn').addEventListener('click', () => {
  if (!db.equipment.length) {
    toast('Add equipment first before scheduling rentals.', 'error');
    showView('equipment');
    return;
  }
  openModal('New Rental', rentalForm(null));
  bindRentalForm(null);
});
document.getElementById('maint-flag-btn').addEventListener('click', () => {
  if (!db.equipment.length) return toast('Add equipment first.', 'error');
  openModal('Flag for Maintenance', maintenanceFlagForm());
  bindMaintenanceForm();
});

document.body.addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit-eq') {
    const eq = db.equipment.find(e => e.id === id);
    openModal('Edit Equipment', equipmentForm(eq));
    bindEquipmentForm(eq);
  } else if (act === 'rent-eq') {
    const eq = db.equipment.find(e => e.id === id);
    const blank = rentalForm(null);
    openModal(`New Rental — ${eq.name}`, blank);
    bindRentalForm(null);
    document.querySelector('select[name=equipmentId]').value = eq.id;
  } else if (act === 'edit-rental') {
    const r = db.rentals.find(x => x.id === id);
    openModal('Rental Details', rentalForm(r));
    bindRentalForm(r);
  } else if (act === 'return-rental') {
    const r = db.rentals.find(x => x.id === id);
    if (!r) return;
    const incomplete = (r.checklistOut || []).some(i => !i.checked);
    if (incomplete && !confirm('Pre-rental checklist is incomplete. Check in anyway?')) return;
    r.actualReturn = nowIso();
    saveDb(); render();
    toast('Equipment checked in. Open it to complete the return checklist.');
  } else if (act === 'clear-maint') {
    clearMaintenance(id);
  }
});

['eq-search','eq-filter-status'].forEach(id => document.getElementById(id).addEventListener('input', render));
['rent-search','rent-filter-status'].forEach(id => document.getElementById(id).addEventListener('input', render));
['sched-equipment','sched-from','sched-to'].forEach(id => document.getElementById(id).addEventListener('change', render));

document.getElementById('map-filter').addEventListener('change', renderMap);
document.getElementById('map-recenter').addEventListener('click', () => {
  const m = ensureMap();
  if (m) m.setView(OHIO_CENTER, OHIO_ZOOM);
});
document.getElementById('map-geocode').addEventListener('click', () => {
  // Force re-geocode of all visible rentals
  const list = rentalsForMapFilter();
  for (const r of list) {
    if (r.location) {
      r.geocode = null;
      queueGeocode(r);
    }
  }
  saveDb();
  renderMap();
});

// Export / Import
document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ohio-rentals-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.equipment || !data.rentals) throw new Error('Bad file');
    if (!confirm('Replace all current data with this backup?')) return;
    db.equipment = data.equipment;
    db.rentals = data.rentals;
    db.maintenance = data.maintenance || [];
    saveDb(); render();
    toast('Backup restored.');
  } catch (err) {
    toast('Could not import: ' + err.message, 'error');
  }
  e.target.value = '';
});

// First-run sample data
if (!db.equipment.length && !db.rentals.length) {
  const seed = [
    { id: uid('eq'), unitId: 'SS-101', name: 'Bobcat S650', type: 'Skid Steer', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: new Date(Date.now()+45*864e5).toISOString() },
    { id: uid('eq'), unitId: 'EX-202', name: 'Kubota KX040', type: 'Mini Excavator', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
    { id: uid('eq'), unitId: 'LF-303', name: 'JLG Boom Lift 60ft', type: 'Lift', notes: '', maintenance: true, maintenanceNotes: 'Hydraulic leak — awaiting parts', maintenanceDue: '' },
  ];
  db.equipment = seed;
  saveDb();
}

// Initial render
render();

// Backlog geocode any rentals that have a location but no coords yet
for (const r of db.rentals) {
  if (r.location && !r.actualReturn && (!r.geocode || r.geocode.queryFor !== r.location)) {
    queueGeocode(r);
  }
}
