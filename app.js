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
    if (raw) {
      const data = JSON.parse(raw);
      if (!data.customers) data.customers = [];
      return data;
    }
  } catch (e) { console.error('load failed', e); }
  return { equipment: [], rentals: [], maintenance: [], customers: [] };
}

function saveDb() {
  localStorage.setItem(STORE_KEY, JSON.stringify(db));
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function nowIso() { return new Date().toISOString(); }

// ---------- Equipment grouping & order ----------

const TYPE_GROUP_NAMES = ['TRs', 'Mastics', 'CP', 'SPs', 'Misc'];

function typeGroupIndex(eq) {
  const id = (eq.unitId || '').toUpperCase().trim();
  const type = (eq.type || '').toLowerCase();
  const name = (eq.name || '').toLowerCase();
  const blob = `${type} ${name}`;

  // Match unit ID prefix first (most reliable).
  if (/^TR[\s\-]?\d*/.test(id)) return 0;
  if (/^(MAS|MST|MS)[\s\-]?\d*/.test(id)) return 1;
  if (/^(CP|CRACK)[\s\-]?\d*/.test(id)) return 2;
  if (/^SP[\s\-]?\d*/.test(id)) return 3;

  // Fall back to type / name keywords.
  if (/\btrailer\b|\btr\b/.test(blob)) return 0;
  if (/mastic/.test(blob)) return 1;
  if (/crack[\s-]?pro|\bcp\b/.test(blob)) return 2;
  if (/\bsp\b|sealcoat|sealer|sprayer|stealth/.test(blob)) return 3;

  return 4;
}

function unitNumber(eq) {
  const m = (eq.unitId || eq.name || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Infinity;
}

function sortedEquipment(arr) {
  arr = arr || db.equipment;
  return [...arr].sort((a, b) => {
    const ga = typeGroupIndex(a);
    const gb = typeGroupIndex(b);
    if (ga !== gb) return ga - gb;
    const na = unitNumber(a);
    const nb = unitNumber(b);
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// ---------- Customers ----------

function normalizeName(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findCustomerByName(name) {
  const key = normalizeName(name);
  if (!key) return null;
  return db.customers.find(c => c.nameKey === key) || null;
}

function ensureCustomer(name, phone) {
  const key = normalizeName(name);
  if (!key) return null;
  let c = findCustomerByName(name);
  if (c) {
    // Keep the most recently provided phone if user typed a new one
    if (phone && !c.phone) c.phone = phone;
    return c;
  }
  c = {
    id: uid('cust'),
    name: name.trim(),
    nameKey: key,
    phone: phone || '',
    notes: '',
    createdAt: nowIso(),
  };
  db.customers.push(c);
  return c;
}

function customerRentals(c) {
  return db.rentals
    .filter(r => normalizeName(r.customer) === c.nameKey)
    .sort((a, b) => new Date(b.timeOut) - new Date(a.timeOut));
}

function customerStats(c) {
  const rentals = customerRentals(c);
  const active = rentals.filter(r => !r.actualReturn);
  const last = rentals[0] || null;
  let lastDurationMs = 0;
  if (last) {
    const end = last.actualReturn
      ? new Date(last.actualReturn)
      : last.timeIn
        ? new Date(last.timeIn)
        : new Date();
    lastDurationMs = Math.max(0, end - new Date(last.timeOut));
  }
  return {
    rentals,
    count: rentals.length,
    activeCount: active.length,
    last,
    lastDurationMs,
  };
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const days = Math.floor(ms / 864e5);
  const hours = Math.floor((ms % 864e5) / 36e5);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

// Backfill customers from existing rentals (run once on startup).
function backfillCustomers() {
  for (const r of db.rentals) {
    if (r.customer) ensureCustomer(r.customer, r.customerPhone);
  }
}

// ---------- Status logic ----------

function rentalStatus(r) {
  if (r.actualReturn) return 'returned';
  const now = new Date();
  const out = new Date(r.timeOut);
  if (now < out) return 'scheduled';
  if (!r.timeIn) return 'active';
  const due = new Date(r.timeIn);
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
  const FAR_FUTURE = new Date(8640000000000000);
  const out = new Date(timeOut);
  const dueIn = timeIn ? new Date(timeIn) : FAR_FUTURE;
  return db.rentals.filter(r => {
    if (r.id === ignoreRentalId) return false;
    if (r.equipmentId !== equipmentId) return false;
    if (r.actualReturn) return false;
    const ro = new Date(r.timeOut);
    const ri = r.timeIn ? new Date(r.timeIn) : FAR_FUTURE;
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

function fmtMonthYear(s) {
  if (!s) return '—';
  const [y, m] = String(s).split('-');
  if (!y || !m) return s;
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString([], { month: 'short', year: 'numeric' });
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
          ${r.timeIn ? `due ${fmtDt(r.timeIn)}` : 'open'}
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
  let rows = sortedEquipment();
  if (search) {
    rows = rows.filter(eq =>
      (eq.name + ' ' + (eq.type||'') + ' ' + (eq.unitId||'') + ' ' + eq.id).toLowerCase().includes(search)
    );
  }
  if (statusFilter) rows = rows.filter(eq => equipmentStatus(eq) === statusFilter);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-muted" style="text-align:center;padding:24px">No equipment yet. Click "+ Add Equipment" to start.</td></tr>`;
    return;
  }

  // Group already-sorted rows by typeGroupIndex.
  const groups = TYPE_GROUP_NAMES.map(() => []);
  for (const eq of rows) groups[typeGroupIndex(eq)].push(eq);

  let html = '';
  groups.forEach((group, i) => {
    if (!group.length) return;
    html += `<tr class="group-row"><td colspan="10">${TYPE_GROUP_NAMES[i]}</td></tr>`;
    for (const eq of group) {
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
      html += `
        <tr>
          <td class="nowrap">${eq.unitId || eq.id}</td>
          <td><strong>${eq.name}</strong></td>
          <td>${eq.type || '—'}</td>
          <td class="nowrap">${fmtMonthYear(eq.monthYearBuilt)}</td>
          <td class="nowrap">${eq.hoursRan ? Number(eq.hoursRan).toLocaleString() : '—'}</td>
          <td>${badge(s)}</td>
          <td>${where}</td>
          <td class="nowrap">${due}</td>
          <td class="nowrap">${maint}</td>
          <td class="row-actions">
            <button class="btn small" data-act="edit-eq" data-id="${eq.id}">Edit</button>
            <button class="btn small" data-act="rent-eq" data-id="${eq.id}">Rent</button>
          </td>
        </tr>`;
    }
  });
  tbody.innerHTML = html;
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
        <td>${r.salesman || '—'}</td>
        <td>${r.location || '—'}</td>
        <td class="nowrap">${fmtDt(r.timeOut)}</td>
        <td class="nowrap">${r.timeIn ? fmtDt(r.timeIn) : '<span class="text-muted">open</span>'}${r.actualReturn ? `<br/><span class="text-muted">in: ${fmtDt(r.actualReturn)}</span>` : ''}</td>
        <td>${badge(s)}</td>
        <td>${checkBadge}</td>
        <td class="row-actions">
          <button class="btn small" data-act="edit-rental" data-id="${r.id}">Open</button>
          ${returnBtn}
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="9" class="text-muted" style="text-align:center;padding:24px">No rentals yet. Click "+ New Rental" to schedule one.</td></tr>`;
}

// ---------- Render: customers ----------

function renderCustomers() {
  const search = (document.getElementById('cust-search').value || '').toLowerCase();
  const tbody = document.getElementById('cust-tbody');

  let rows = [...db.customers].map(c => ({ c, stats: customerStats(c) }));
  if (search) {
    rows = rows.filter(({ c }) =>
      (c.name + ' ' + (c.phone || '')).toLowerCase().includes(search)
    );
  }
  rows.sort((a, b) => {
    const da = a.stats.last ? new Date(a.stats.last.timeOut) : 0;
    const dbb = b.stats.last ? new Date(b.stats.last.timeOut) : 0;
    return dbb - da;
  });

  tbody.innerHTML = rows.length ? rows.map(({ c, stats }) => {
    const last = stats.last;
    return `
      <tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.phone || '—'}</td>
        <td>${stats.count}</td>
        <td>${stats.activeCount > 0 ? badge('rented') : '—'}</td>
        <td class="nowrap">${last ? fmtDt(last.timeOut) : '—'}</td>
        <td>${last ? eqName(last.equipmentId) : '—'}</td>
        <td>${fmtDuration(stats.lastDurationMs)}</td>
        <td class="row-actions">
          <button class="btn small" data-act="cust-history" data-id="${c.id}">History</button>
          <button class="btn small" data-act="cust-edit" data-id="${c.id}">Edit</button>
        </td>
      </tr>`;
  }).join('') : `<tr><td colspan="8" class="text-muted" style="text-align:center;padding:24px">No customers yet. They'll show up automatically when you create rentals.</td></tr>`;
}

// ---------- Customer forms ----------

function customerForm(c) {
  const isEdit = !!c;
  c = c || { id: '', name: '', phone: '', notes: '' };
  return `
    <form id="cust-form">
      <div class="form-row two-up">
        <div>
          <label>Name *</label>
          <input name="name" required value="${c.name || ''}" />
        </div>
        <div>
          <label>Phone</label>
          <input name="phone" value="${c.phone || ''}" />
        </div>
      </div>
      <div class="form-row">
        <label>Notes</label>
        <textarea name="notes">${c.notes || ''}</textarea>
      </div>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn danger" id="cust-delete">Delete</button>` : ''}
        <button type="button" class="btn ghost" id="cust-cancel">Cancel</button>
        <button type="submit" class="btn primary">${isEdit ? 'Save' : 'Add'}</button>
      </div>
    </form>`;
}

function bindCustomerForm(existing) {
  document.getElementById('cust-cancel').addEventListener('click', closeModal);
  if (existing) {
    document.getElementById('cust-delete').addEventListener('click', () => {
      const stats = customerStats(existing);
      if (stats.count > 0) {
        if (!confirm(`${existing.name} has ${stats.count} rental(s) on file. Delete the customer record anyway? (Rentals stay.)`)) return;
      } else {
        if (!confirm(`Delete ${existing.name}?`)) return;
      }
      db.customers = db.customers.filter(x => x.id !== existing.id);
      saveDb(); closeModal(); render();
      toast('Customer deleted.');
    });
  }
  document.getElementById('cust-form').addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const newName = (fd.get('name') || '').trim();
    if (!newName) return toast('Name is required.', 'error');
    const newPhone = fd.get('phone') || '';
    const newNotes = fd.get('notes') || '';

    if (existing) {
      const oldKey = existing.nameKey;
      const newKey = normalizeName(newName);
      // If name changed, update rentals that referenced the old name.
      if (oldKey !== newKey) {
        // Avoid colliding with another existing customer.
        const collision = db.customers.find(c => c.id !== existing.id && c.nameKey === newKey);
        if (collision) {
          if (!confirm(`A customer named "${collision.name}" already exists. Merge into them?`)) return;
          // Merge: re-point all rentals from existing -> collision name, keep collision record.
          for (const r of db.rentals) {
            if (normalizeName(r.customer) === oldKey) r.customer = collision.name;
          }
          db.customers = db.customers.filter(c => c.id !== existing.id);
          collision.phone = collision.phone || newPhone;
          saveDb(); closeModal(); render();
          toast('Customers merged.');
          return;
        }
        for (const r of db.rentals) {
          if (normalizeName(r.customer) === oldKey) r.customer = newName;
        }
      }
      existing.name = newName;
      existing.nameKey = normalizeName(newName);
      existing.phone = newPhone;
      existing.notes = newNotes;
    } else {
      const dup = findCustomerByName(newName);
      if (dup) return toast('That customer already exists.', 'error');
      db.customers.push({
        id: uid('cust'),
        name: newName,
        nameKey: normalizeName(newName),
        phone: newPhone,
        notes: newNotes,
        createdAt: nowIso(),
      });
    }
    saveDb(); closeModal(); render();
    toast(existing ? 'Customer updated.' : 'Customer added.');
  });
}

function customerHistory(c) {
  const stats = customerStats(c);
  const rows = stats.rentals.map(r => {
    const s = rentalStatus(r);
    const end = r.actualReturn
      ? new Date(r.actualReturn)
      : r.timeIn
        ? new Date(r.timeIn)
        : new Date();
    const dur = Math.max(0, end - new Date(r.timeOut));
    return `
      <tr>
        <td>${eqName(r.equipmentId)}</td>
        <td class="nowrap">${fmtDt(r.timeOut)}</td>
        <td class="nowrap">${r.actualReturn ? fmtDt(r.actualReturn) : fmtDt(r.timeIn) + ' (due)'}</td>
        <td>${fmtDuration(dur)}</td>
        <td>${badge(s)}</td>
        <td>${r.salesman || '—'}</td>
        <td>${r.location || '—'}</td>
        <td><button class="btn small" data-act="edit-rental" data-id="${r.id}">Open</button></td>
      </tr>`;
  }).join('');
  return `
    <div style="margin-bottom:12px">
      <div><strong>${c.name}</strong>${c.phone ? ' · ' + c.phone : ''}</div>
      <div class="text-muted" style="font-size:12px">
        ${stats.count} rental${stats.count === 1 ? '' : 's'}
        ${stats.activeCount > 0 ? ` · ${stats.activeCount} currently out` : ''}
      </div>
      ${c.notes ? `<div class="text-muted" style="margin-top:6px">${c.notes}</div>` : ''}
    </div>
    ${rows ? `
      <table class="data">
        <thead><tr>
          <th>Equipment</th><th>Out</th><th>In / Due</th><th>Duration</th><th>Status</th><th>Salesman</th><th>Location</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    ` : '<div class="empty text-muted">No rentals yet.</div>'}
    <div class="form-actions">
      <button type="button" class="btn ghost" id="cust-hist-close">Close</button>
      <button type="button" class="btn" data-act="cust-edit" data-id="${c.id}">Edit Customer</button>
    </div>
  `;
}

// ---------- Render: schedule (calendar) ----------

let calendarMonth = (() => {
  const d = new Date();
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return d;
})();

function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

function renderSchedule() {
  const sel = document.getElementById('sched-equipment');
  const currentValue = sel.value;
  sel.innerHTML = '<option value="">All equipment</option>' + sortedEquipment().map(eq =>
    `<option value="${eq.id}">${eq.name}</option>`
  ).join('');
  sel.value = currentValue;

  const month = calendarMonth.getMonth();
  const year = calendarMonth.getFullYear();
  document.getElementById('cal-month-label').textContent =
    calendarMonth.toLocaleString([], { month: 'long', year: 'numeric' });

  const first = new Date(year, month, 1);
  const startOffset = first.getDay(); // 0=Sun
  const gridStart = new Date(year, month, 1 - startOffset);

  const eqFilter = sel.value;
  const today = startOfDay(new Date()).getTime();

  let html = '';
  for (let i = 0; i < 42; i++) {
    const day = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const dayStart = startOfDay(day);
    const dayEnd = new Date(dayStart.getTime() + 864e5 - 1);
    const inMonth = day.getMonth() === month;
    const isToday = dayStart.getTime() === today;
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;

    const rentals = db.rentals.filter(r => {
      if (eqFilter && r.equipmentId !== eqFilter) return false;
      const out = new Date(r.timeOut);
      // For open-ended (no timeIn) rentals, end at actualReturn or today
      // so they show on the days they were/are out, not forever forward.
      const end = r.actualReturn
        ? new Date(r.actualReturn)
        : r.timeIn
          ? new Date(r.timeIn)
          : (out > new Date() ? out : new Date());
      return out <= dayEnd && end >= dayStart;
    }).sort((a, b) => new Date(a.timeOut) - new Date(b.timeOut));

    const cls = ['cal-cell'];
    if (!inMonth) cls.push('other-month');
    if (isToday) cls.push('today');
    if (isWeekend && inMonth && !isToday) cls.push('weekend');

    const max = 4;
    const shown = rentals.slice(0, max).map(r => {
      const s = rentalStatus(r);
      const eq = db.equipment.find(e => e.id === r.equipmentId);
      const label = `${eq ? eq.name : '?'} · ${r.customer}`;
      const tooltip = `${eq ? eq.name : '?'} — ${r.customer}\n${r.location || ''}\nOut: ${fmtDt(r.timeOut)}\nDue: ${fmtDt(r.timeIn)}`;
      return `<div class="cal-event ${s}" data-act="edit-rental" data-id="${r.id}" title="${tooltip.replace(/"/g, '&quot;')}">${label}</div>`;
    }).join('');
    const more = rentals.length > max ? `<div class="cal-more">+${rentals.length - max} more</div>` : '';

    html += `<div class="${cls.join(' ')}">
      <div class="cal-date">${day.getDate()}</div>
      <div class="cal-events">${shown}${more}</div>
    </div>`;
  }
  document.getElementById('schedule-board').innerHTML = html;
}

function shiftCalendar(delta) {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + delta, 1);
  renderSchedule();
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
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div><span style="background:${GROUP_COLORS[0]}"></span>TR</div>
      <div><span style="background:${GROUP_COLORS[1]}"></span>Mastic</div>
      <div><span style="background:${GROUP_COLORS[2]}"></span>CP</div>
      <div><span style="background:${GROUP_COLORS[3]}"></span>SP</div>
      <div><span style="background:${GROUP_COLORS[4]}"></span>Misc</div>
    `;
    return div;
  };
  legend.addTo(mapInstance);
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
    scheduled: '#eab308',
    active: '#2563eb',
    overdue: '#dc2626',
    returned: '#94a3b8',
    maintenance: '#dc2626',
  })[status] || '#94a3b8';
}

const GROUP_COLORS = {
  0: '#eab308', // TRs    - yellow
  1: '#dc2626', // Mastic - red
  2: '#2563eb', // CP     - blue
  3: '#16a34a', // SP     - green
  4: '#94a3b8', // Misc   - gray
};

function groupColor(eq) {
  if (!eq) return GROUP_COLORS[4];
  return GROUP_COLORS[typeGroupIndex(eq)];
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
    const eq = db.equipment.find(e => e.id === r.equipmentId);
    const marker = L.marker([r.geocode.lat, r.geocode.lng], { icon: pinIcon(groupColor(eq)) }).addTo(map);
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
  if (view === 'customers') renderCustomers();
  if (view === 'schedule') renderSchedule();
  if (view === 'map') renderMap();
  if (view === 'maintenance') renderMaintenance();
}

// ---------- Equipment forms ----------

function equipmentForm(eq) {
  const isEdit = !!eq;
  eq = eq || { id: '', unitId: '', name: '', type: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '', monthYearBuilt: '', hoursRan: '' };
  const dueValue = eq.maintenanceDue ? eq.maintenanceDue.slice(0, 10) : '';
  return `
    <form id="eq-form">
      <div class="form-row two-up">
        <div>
          <label>Unit ID / Number</label>
          <input name="unitId" value="${eq.unitId || ''}" placeholder="e.g. TR-3" />
        </div>
        <div>
          <label>Name *</label>
          <input name="name" required value="${eq.name || ''}" placeholder="e.g. TR-3 Crack Sealer" />
        </div>
      </div>
      <div class="form-row two-up">
        <div>
          <label>Type / Category</label>
          <input name="type" value="${eq.type || ''}" placeholder="TR, Mastic, Crack Pro, SP, etc." />
        </div>
        <div>
          <label>Hours Ran</label>
          <input type="number" name="hoursRan" min="0" step="any" value="${eq.hoursRan || ''}" placeholder="e.g. 1240" />
        </div>
      </div>
      <div class="form-row two-up">
        <div>
          <label>Maintenance Due</label>
          <input type="date" name="maintenanceDue" value="${dueValue}" />
        </div>
        <div>
          <label>Month &amp; Year Built</label>
          <input type="month" name="monthYearBuilt" value="${eq.monthYearBuilt || ''}" />
        </div>
      </div>

      <div class="form-row" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;">
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
    salesman: '',
    timeOut: '', timeIn: '', notes: '',
    checklistOut: DEFAULT_CHECKLIST_OUT.map(text => ({ text, checked: false })),
    checklistIn: DEFAULT_CHECKLIST_IN.map(text => ({ text, checked: false })),
    actualReturn: ''
  };
  const eqOptions = sortedEquipment().map(eq =>
    `<option value="${eq.id}" ${eq.id === r.equipmentId ? 'selected' : ''}>${eq.name} (${eq.unitId || eq.id})</option>`
  ).join('');
  const status = isEdit ? rentalStatus(r) : 'scheduled';
  const salesmen = [...new Set(db.rentals.map(x => x.salesman).filter(Boolean))].sort();

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
          <input name="customer" required value="${r.customer || ''}" list="customer-list" autocomplete="off" />
          <datalist id="customer-list">
            ${db.customers.map(c => `<option value="${c.name.replace(/"/g,'&quot;')}"></option>`).join('')}
          </datalist>
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
      <div class="form-row">
        <label>Salesman</label>
        <input name="salesman" value="${r.salesman || ''}" list="salesman-list" autocomplete="off" placeholder="Who's handling this rental" />
        <datalist id="salesman-list">
          ${salesmen.map(s => `<option value="${s.replace(/"/g,'&quot;')}"></option>`).join('')}
        </datalist>
      </div>
      <div class="form-row two-up">
        <div>
          <label>Time Out *</label>
          <input type="datetime-local" name="timeOut" required value="${toLocalInput(r.timeOut)}" />
        </div>
        <div>
          <label>Scheduled Time In <span class="text-muted">(optional)</span></label>
          <input type="datetime-local" name="timeIn" value="${toLocalInput(r.timeIn)}" />
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

  // When user picks an existing customer name, auto-fill phone if empty.
  const custInput = form.querySelector('input[name=customer]');
  const phoneInput = form.querySelector('input[name=customerPhone]');
  custInput?.addEventListener('change', () => {
    const match = findCustomerByName(custInput.value);
    if (match && match.phone && !phoneInput.value) phoneInput.value = match.phone;
  });

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
    const t2 = data.timeIn ? new Date(data.timeIn) : null;
    if (t2 && !(t2 > t1)) return toast('"Time In" must be after "Time Out".', 'error');

    const conflicts = findConflicts(data.equipmentId, t1.toISOString(), t2 ? t2.toISOString() : '', existing?.id);
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
      salesman: (data.salesman || '').trim(),
      location: data.location.trim(),
      timeOut: t1.toISOString(),
      timeIn: t2 ? t2.toISOString() : '',
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
    ensureCustomer(saved.customer, saved.customerPhone);
    saveDb(); closeModal(); render();
    queueGeocode(saved);
    toast(existing ? 'Rental updated.' : 'Rental created.');
  });
}

// ---------- Maintenance flag dialog ----------

function maintenanceFlagForm() {
  const eqOptions = sortedEquipment().map(eq => `<option value="${eq.id}">${eq.name}</option>`).join('');
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
document.getElementById('cust-add-btn').addEventListener('click', () => {
  openModal('Add Customer', customerForm(null));
  bindCustomerForm(null);
});
document.getElementById('cust-search').addEventListener('input', renderCustomers);
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
  } else if (act === 'cust-edit') {
    const c = db.customers.find(x => x.id === id);
    if (!c) return;
    openModal('Edit Customer', customerForm(c));
    bindCustomerForm(c);
  } else if (act === 'cust-history') {
    const c = db.customers.find(x => x.id === id);
    if (!c) return;
    openModal(`Customer — ${c.name}`, customerHistory(c));
    document.getElementById('cust-hist-close')?.addEventListener('click', closeModal);
  }
});

['eq-search','eq-filter-status'].forEach(id => document.getElementById(id).addEventListener('input', render));
['rent-search','rent-filter-status'].forEach(id => document.getElementById(id).addEventListener('input', render));
document.getElementById('sched-equipment').addEventListener('change', renderSchedule);
document.getElementById('cal-prev').addEventListener('click', () => shiftCalendar(-1));
document.getElementById('cal-next').addEventListener('click', () => shiftCalendar(1));
document.getElementById('cal-today').addEventListener('click', () => {
  calendarMonth = (() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
  renderSchedule();
});

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
    db.customers = data.customers || [];
    backfillCustomers();
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
    { id: uid('eq'), unitId: 'TR-1', name: 'TR-1', type: 'TR', hoursRan: '', monthYearBuilt: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
    { id: uid('eq'), unitId: 'TR-2', name: 'TR-2', type: 'TR', hoursRan: '', monthYearBuilt: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
    { id: uid('eq'), unitId: 'MS-1', name: 'Mastic 1', type: 'Mastic', hoursRan: '', monthYearBuilt: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
    { id: uid('eq'), unitId: 'CP-1', name: 'Crack Pro 1', type: 'Crack Pro', hoursRan: '', monthYearBuilt: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
    { id: uid('eq'), unitId: 'SP-1', name: 'SP 1', type: 'SP', hoursRan: '', monthYearBuilt: '', notes: '', maintenance: false, maintenanceNotes: '', maintenanceDue: '' },
  ];
  db.equipment = seed;
  saveDb();
}

// Backfill customer records from any existing rentals
backfillCustomers();
saveDb();

// Initial render
render();

// Backlog geocode any rentals that have a location but no coords yet
for (const r of db.rentals) {
  if (r.location && !r.actualReturn && (!r.geocode || r.geocode.queryFor !== r.location)) {
    queueGeocode(r);
  }
}
