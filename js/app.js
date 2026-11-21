// Controlador de la interfaz: conecta el DOM con el dominio (bookings.js) y la persistencia (storage.js).
import { SPACES, SLOTS, RULES, spaceById, slotById } from './config.js';
import {
  validateBooking, createBooking, cancelBooking, filterBookings, computeStats,
  availabilityForDate, remainingCapacity, formatDateLong, toLocalISODate, addDays,
  isClosedDay, nextOpenDate,
} from './bookings.js';
import { createRepository, StorageError, STORAGE_KEY } from './storage.js';
import { toCSV, toJSON, downloadFile } from './export.js';

const $ = (sel) => document.querySelector(sel);

/** Pequeño helper para crear elementos sin innerHTML (evita XSS con datos del usuario). */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// ---------- Estado ----------

const repo = createRepository();
const state = {
  bookings: [],
  tab: 'upcoming',
  query: '',
  filterSpace: '',
};

const form = $('#booking-form');
const fields = {
  projectName: $('#project-name'),
  contactName: $('#contact-name'),
  email: $('#email'),
  date: $('#booking-date'),
  attendees: $('#attendees'),
  notes: $('#notes'),
};
const touched = new Set();

// ---------- Toasts y diálogo ----------

function toast(message, type = 'info') {
  const el = h('div', { class: `toast toast--${type}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('toast--out'), 3800);
  setTimeout(() => el.remove(), 4200);
}

/** Muestra el <dialog> y resuelve con el valor del botón pulsado ('confirm' | 'alt' | 'cancel' | ''). */
function openDialog({ title, body, confirmText = 'Aceptar', cancelText = 'Volver', altText = null, danger = false, hideCancel = false }) {
  const dialog = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').replaceChildren(...(Array.isArray(body) ? body : [body]));
  const ok = $('#dialog-confirm');
  ok.textContent = confirmText;
  ok.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  $('#dialog-cancel').textContent = cancelText;
  $('#dialog-cancel').hidden = hideCancel;
  $('#dialog-alt').hidden = !altText;
  $('#dialog-alt').textContent = altText ?? '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

const confirmDialog = async (opts) => (await openDialog(opts)) === 'confirm';

// ---------- Persistencia ----------

function persist(next) {
  try {
    repo.save(next);
    state.bookings = next;
    return true;
  } catch (e) {
    toast(e instanceof StorageError ? e.message : 'Error inesperado al guardar.', 'error');
    return false;
  }
}

// ---------- Formulario ----------

function readForm() {
  const data = new FormData(form);
  return {
    projectName: data.get('projectName'),
    contactName: data.get('contactName'),
    email: data.get('email'),
    spaceId: data.get('spaceId') ?? '',
    date: data.get('date'),
    slot: data.get('slot') ?? '',
    attendees: data.get('attendees'),
    notes: data.get('notes'),
  };
}

function showErrors(errors, { onlyTouched = false } = {}) {
  for (const key of ['projectName', 'contactName', 'email', 'spaceId', 'date', 'slot', 'attendees', 'notes']) {
    const msg = onlyTouched && !touched.has(key) ? '' : errors[key] ?? '';
    $(`#err-${key}`).textContent = msg;
    const input = fields[key];
    if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
}

function buildSpaceOptions() {
  const container = $('#space-options');
  container.replaceChildren(
    ...SPACES.map((s, i) =>
      h('label', { class: 'option-card' },
        h('input', { type: 'radio', name: 'spaceId', value: s.id, checked: i === 0, 'aria-describedby': `space-desc-${s.id}` }),
        h('span', { class: 'option-card__body' },
          h('span', { class: 'option-card__title' }, s.name),
          h('span', { class: 'option-card__desc', id: `space-desc-${s.id}` }, s.description),
          h('span', { class: 'option-card__meta', dataset: { remaining: s.id } }),
        ),
      ),
    ),
  );
  $('#filter-space').append(...SPACES.map((s) => h('option', { value: s.id }, s.name)));
}

function buildSlotOptions() {
  $('#slot-options').replaceChildren(
    ...SLOTS.map((s, i) =>
      h('label', { class: 'slot' },
        h('input', { type: 'radio', name: 'slot', value: s.id, checked: i === 0 }),
        h('span', { class: 'slot__body' },
          h('strong', {}, s.label),
          h('small', {}, s.hours),
          h('small', { class: 'slot__left', dataset: { slotLeft: s.id } }),
        ),
      ),
    ),
  );
}

/** Ajusta límites dinámicos del formulario según espacio/fecha seleccionados. */
function syncFormConstraints() {
  const { spaceId, date } = readForm();
  const space = spaceById(spaceId);
  const today = toLocalISODate(new Date());

  fields.date.min = today;
  fields.date.max = addDays(today, RULES.bookingWindowDays);
  $('#date-hint').textContent = date && isClosedDay(date) ? 'Cerrado ese día (domingo).' : date ? formatDateLong(date) : '';

  if (space) {
    fields.attendees.max = space.maxAttendees;
    $('#attendees-hint').textContent =
      space.consumes === 'per-attendee' ? `Cada asistente usa un puesto (máx. ${space.maxAttendees}).` : `Máximo ${space.maxAttendees} personas.`;

    // Bloques: deshabilitar los no permitidos o sin cupo, y mostrar cupos restantes.
    let selectedStillValid = false;
    for (const input of form.querySelectorAll('input[name="slot"]')) {
      const allowed = space.allowedSlots.includes(input.value);
      const left = date && !isClosedDay(date) ? remainingCapacity(state.bookings, space.id, date, input.value) : null;
      input.disabled = !allowed || left === 0;
      const label = form.querySelector(`[data-slot-left="${input.value}"]`);
      label.textContent = !allowed ? 'No disponible' : left == null ? '' : left === 0 ? 'Completo' : `${left} disp.`;
      if (input.checked && !input.disabled) selectedStillValid = true;
    }
    if (!selectedStillValid) {
      const first = form.querySelector('input[name="slot"]:not(:disabled)');
      if (first) first.checked = true;
    }
  }

  // Cupos por tipo de espacio para el bloque elegido.
  const slot = readForm().slot;
  for (const s of SPACES) {
    const meta = form.querySelector(`[data-remaining="${s.id}"]`);
    if (!date || isClosedDay(date)) { meta.textContent = `${s.capacity} ${s.consumes === 'per-attendee' ? 'puestos' : 'unidades'}`; continue; }
    const useSlot = s.allowedSlots.includes(slot) ? slot : 'full';
    const left = remainingCapacity(state.bookings, s.id, date, useSlot);
    meta.textContent = `${left} de ${s.capacity} libres · ${slotById(useSlot).label.toLowerCase()}`;
  }

  $('#notes-count').textContent = `${fields.notes.value.length} / ${RULES.notesMax}`;
}

function onFormChange(e) {
  if (e?.target?.name) touched.add(e.target.name);
  syncFormConstraints();
  const { errors } = validateBooking(readForm(), state.bookings);
  showErrors(errors, { onlyTouched: true });
  renderAvailability();
}

async function onSubmit(e) {
  e.preventDefault();
  const raw = readForm();
  const { ok, errors } = validateBooking(raw, state.bookings);
  if (!ok) {
    Object.keys(errors).forEach((k) => touched.add(k));
    showErrors(errors);
    const firstKey = Object.keys(errors)[0];
    (fields[firstKey] ?? form.querySelector(`[name="${firstKey}"]`))?.focus();
    toast('Revisa los campos marcados.', 'error');
    return;
  }

  const booking = createBooking(raw, state.bookings);
  if (!persist([...state.bookings, booking])) return;

  // Mantener datos de contacto para facilitar reservas sucesivas del mismo proyecto.
  const keep = { projectName: raw.projectName, contactName: raw.contactName, email: raw.email };
  form.reset();
  Object.entries(keep).forEach(([k, v]) => { fields[k].value = v; });
  fields.date.value = booking.date;
  touched.clear();
  showErrors({});
  state.tab = 'upcoming';
  render();

  await confirmDialog({
    title: '¡Reserva confirmada!',
    body: [
      h('p', { class: 'code-badge' }, booking.code),
      h('p', {}, `${spaceById(booking.spaceId).name} · ${slotById(booking.slot).label} (${slotById(booking.slot).hours})`),
      h('p', { class: 'muted' }, formatDateLong(booking.date)),
      h('p', { class: 'muted small' }, 'Guarda este código para identificar tu reserva.'),
    ],
    confirmText: 'Listo',
    hideCancel: true,
  });
}

// ---------- Render ----------

function renderStats() {
  const s = computeStats(state.bookings);
  $('#stat-upcoming').textContent = s.upcoming;
  $('#stat-projects').textContent = s.projects;
  $('#stat-occupancy').textContent = `${s.occupancyToday}%`;
  $('#stat-cancelled').textContent = s.cancelled;
}

function renderAvailability() {
  const date = fields.date.value;
  const container = $('#availability');
  if (!date) {
    $('#avail-date').textContent = 'Selecciona una fecha en el formulario.';
    container.replaceChildren();
    return;
  }
  $('#avail-date').textContent = formatDateLong(date);
  if (isClosedDay(date)) {
    container.replaceChildren(h('p', { class: 'empty' }, 'El CoWork está cerrado este día.'));
    return;
  }

  const matrix = availabilityForDate(state.bookings, date);
  const halves = SLOTS.filter((s) => s.id !== 'full');
  container.replaceChildren(
    ...SPACES.map((space) =>
      h('div', { class: 'avail-row' },
        h('div', { class: 'avail-row__name' }, space.name),
        ...halves.map((slot) => {
          const { remaining, capacity } = matrix[space.id][slot.id];
          const pct = Math.round(((capacity - remaining) / capacity) * 100);
          const level = remaining === 0 ? 'full' : remaining / capacity <= 0.25 ? 'low' : 'ok';
          return h('div', { class: 'avail-cell' },
            h('div', { class: 'avail-cell__label' },
              h('span', {}, slot.label),
              h('span', { class: `avail-cell__count avail-cell__count--${level}` }, remaining === 0 ? 'Completo' : `${remaining}/${capacity}`),
            ),
            h('div', {
              class: `bar bar--${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(capacity),
              'aria-valuenow': String(capacity - remaining), 'aria-label': `${space.name}, ${slot.label}: ${remaining} de ${capacity} libres`,
            }, h('span', { style: `width:${pct}%` })),
          );
        }),
      ),
    ),
  );
}

function bookingItem(b) {
  const space = spaceById(b.spaceId);
  const slot = slotById(b.slot);
  const isCancelled = b.status === 'cancelled';
  const isPast = b.date < toLocalISODate(new Date());
  return h('li', { class: `booking booking--${b.spaceId}${isCancelled ? ' booking--cancelled' : ''}` },
    h('div', { class: 'booking__main' },
      h('div', { class: 'booking__head' },
        h('h3', {}, b.projectName),
        h('span', { class: 'code', title: 'Código de reserva' }, b.code),
      ),
      h('p', { class: 'booking__meta' },
        `${space?.name ?? b.spaceId} · ${slot?.label ?? b.slot} (${slot?.hours ?? ''}) · ${b.attendees} ${b.attendees === 1 ? 'persona' : 'personas'}`),
      h('p', { class: 'booking__date' }, formatDateLong(b.date)),
      b.contactName || b.email
        ? h('p', { class: 'booking__contact' }, [b.contactName, b.email].filter(Boolean).join(' · '))
        : null,
      b.notes ? h('p', { class: 'booking__notes' }, b.notes) : null,
    ),
    !isCancelled && !isPast
      ? h('button', { type: 'button', class: 'btn btn--link-danger', dataset: { cancel: b.id }, 'aria-label': `Cancelar reserva ${b.code} de ${b.projectName}` }, 'Cancelar')
      : h('span', { class: `pill ${isCancelled ? 'pill--cancelled' : 'pill--past'}` }, isCancelled ? 'Cancelada' : 'Finalizada'),
  );
}

function renderList() {
  const opts = { query: state.query, spaceId: state.filterSpace };
  const list = filterBookings(state.bookings, { ...opts, tab: state.tab });

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.tab === state.tab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const count = filterBookings(state.bookings, { ...opts, tab: tab.dataset.tab }).length;
    tab.querySelector('.tab__count').textContent = count ? count : '';
  }

  $('#bookings-list').replaceChildren(...list.map(bookingItem));
  const empty = list.length === 0;
  $('#empty-state').hidden = !empty;
  if (empty) {
    $('#empty-text').textContent = state.query || state.filterSpace
      ? 'Ninguna reserva coincide con la búsqueda.'
      : { upcoming: 'No hay reservas activas en este momento.', past: 'Aún no hay reservas pasadas.', cancelled: 'No hay reservas canceladas.' }[state.tab];
  }
}

function render() {
  syncFormConstraints();
  renderStats();
  renderAvailability();
  renderList();
}

// ---------- Acciones de la lista ----------

async function onCancelClick(id) {
  const b = state.bookings.find((x) => x.id === id);
  if (!b) return;
  const ok = await confirmDialog({
    title: '¿Cancelar esta reserva?',
    body: [
      h('p', {}, h('strong', {}, b.projectName), ` · ${b.code}`),
      h('p', { class: 'muted' }, `${spaceById(b.spaceId)?.name} · ${slotById(b.slot)?.label} · ${formatDateLong(b.date)}`),
      h('p', { class: 'small' }, 'El cupo quedará libre para otros proyectos.'),
    ],
    confirmText: 'Sí, cancelar',
    cancelText: 'Mantener',
    danger: true,
  });
  if (ok && persist(cancelBooking(state.bookings, id))) {
    toast(`Reserva ${b.code} cancelada.`, 'success');
    render();
  }
}

// ---------- Exportar / importar ----------

function stamp() {
  return toLocalISODate(new Date());
}

function onExportCSV() {
  const list = filterBookings(state.bookings, { tab: 'all', query: state.query, spaceId: state.filterSpace });
  if (!list.length) return toast('No hay reservas para exportar.', 'info');
  downloadFile(`reservas-cowork-${stamp()}.csv`, toCSV(list), 'text/csv;charset=utf-8');
  toast(`${list.length} reservas exportadas a CSV.`, 'success');
}

function onExportJSON() {
  downloadFile(`respaldo-cowork-${stamp()}.json`, toJSON(state.bookings), 'application/json');
  toast('Respaldo descargado.', 'success');
}

async function onImport(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('El archivo es demasiado grande (máx. 2 MB).', 'error');
  try {
    const { bookings, skipped } = repo.parseImport(await file.text());
    if (!bookings.length) return toast('El archivo no contiene reservas válidas.', 'error');
    const choice = await openDialog({
      title: 'Importar reservas',
      body: [
        h('p', {}, `Se encontraron ${bookings.length} reservas válidas${skipped ? ` (${skipped} descartadas)` : ''}.`),
        h('p', { class: 'muted small' }, '“Combinar” las agrega a las actuales (sin duplicados). “Reemplazar” borra las reservas actuales.'),
      ],
      confirmText: 'Combinar',
      altText: 'Reemplazar',
      cancelText: 'Cancelar',
    });
    if (choice !== 'confirm' && choice !== 'alt') return;
    const replace = choice === 'alt';
    const existingIds = new Set(state.bookings.map((b) => b.id));
    const next = replace ? bookings : [...state.bookings, ...bookings.filter((b) => !existingIds.has(b.id))];
    if (persist(repo.dedupe(next))) {
      toast(`Importación completada: ${next.length} reservas en total.`, 'success');
      render();
    }
  } catch (err) {
    toast(err instanceof StorageError ? err.message : 'No se pudo leer el archivo.', 'error');
  }
}

// ---------- Init ----------

function init() {
  buildSpaceOptions();
  buildSlotOptions();

  try {
    const { bookings, notice } = repo.load();
    state.bookings = bookings;
    if (notice) toast(notice, 'info');
  } catch (e) {
    toast(e.message, 'error');
  }

  fields.date.value = nextOpenDate();

  form.addEventListener('input', onFormChange);
  form.addEventListener('change', onFormChange);
  form.addEventListener('submit', onSubmit);

  $('#bookings-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (btn) onCancelClick(btn.dataset.cancel);
  });

  const tabs = [...document.querySelectorAll('.tab')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => { state.tab = tab.dataset.tab; renderList(); });
    tab.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      const next = tabs[(i + dir + tabs.length) % tabs.length];
      state.tab = next.dataset.tab;
      renderList();
      next.focus();
    });
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.query = e.target.value; renderList(); }, 150);
  });
  $('#filter-space').addEventListener('change', (e) => { state.filterSpace = e.target.value; renderList(); });

  $('#export-csv').addEventListener('click', onExportCSV);
  $('#export-json').addEventListener('click', onExportJSON);
  $('#import-json').addEventListener('change', onImport);

  // Sincroniza si se reserva desde otra pestaña.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    try { state.bookings = repo.load().bookings; render(); } catch { /* ignorado */ }
  });

  render();
}

init();
