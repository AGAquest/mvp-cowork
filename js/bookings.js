// Lógica de dominio pura: sin DOM ni localStorage, para poder testearla con `node --test`.
import { SPACES, SLOTS, RULES, spaceById, slotById } from './config.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- Fechas (siempre en hora local, nunca toISOString: en Chile daría el día siguiente de noche) ----------

/** @param {Date} d */
export function toLocalISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Convierte 'YYYY-MM-DD' a Date local (mediodía, para evitar saltos por horario de verano). */
export function parseLocalDate(str) {
  if (!DATE_RE.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12);
  // Rechaza fechas imposibles como 2026-02-31
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function addDays(dateStr, days) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  return toLocalISODate(d);
}

export function isClosedDay(dateStr) {
  const d = parseLocalDate(dateStr);
  return !d || RULES.closedWeekdays.includes(d.getDay());
}

export function formatDateLong(dateStr) {
  const d = parseLocalDate(dateStr);
  if (!d) return dateStr;
  return d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------- Capacidad ----------

/** Unidades que consume una reserva de su espacio. */
export function unitsFor(booking) {
  const space = spaceById(booking.spaceId);
  if (!space) return 0;
  return space.consumes === 'per-attendee' ? Number(booking.attendees) || 1 : 1;
}

const isActive = (b) => b.status === 'confirmed';

function slotsOverlap(a, b) {
  const ca = slotById(a)?.covers ?? [];
  const cb = slotById(b)?.covers ?? [];
  return ca.some((h) => cb.includes(h));
}

/**
 * Capacidad restante para un espacio/fecha/bloque.
 * Para 'full' se toma el mínimo entre mañana y tarde, porque ocupa ambos.
 */
export function remainingCapacity(bookings, spaceId, date, slotId, { excludeId } = {}) {
  const space = spaceById(spaceId);
  const slot = slotById(slotId);
  if (!space || !slot) return 0;

  const usedPerHalf = slot.covers.map((half) =>
    bookings
      .filter((b) => isActive(b) && b.id !== excludeId && b.spaceId === spaceId && b.date === date)
      .filter((b) => slotsOverlap(b.slot, half))
      .reduce((sum, b) => sum + unitsFor(b), 0),
  );
  return Math.max(0, space.capacity - Math.max(...usedPerHalf));
}

/** Matriz de disponibilidad de un día: { [spaceId]: { [slotId]: { remaining, capacity, allowed } } } */
export function availabilityForDate(bookings, date) {
  const result = {};
  for (const space of SPACES) {
    result[space.id] = {};
    for (const slot of SLOTS) {
      result[space.id][slot.id] = {
        remaining: remainingCapacity(bookings, space.id, date, slot.id),
        capacity: space.capacity,
        allowed: space.allowedSlots.includes(slot.id),
      };
    }
  }
  return result;
}

/** % de ocupación de un día (unidades usadas / unidades totales, por medio bloque). */
export function occupancyForDate(bookings, date) {
  let used = 0;
  let total = 0;
  for (const space of SPACES) {
    for (const half of ['am', 'pm']) {
      total += space.capacity;
      used += space.capacity - remainingCapacity(bookings, space.id, date, half);
    }
  }
  return total === 0 ? 0 : Math.round((used / total) * 100);
}

// ---------- Validación ----------

export function normalizeInput(raw) {
  return {
    projectName: String(raw.projectName ?? '').trim().replace(/\s+/g, ' '),
    contactName: String(raw.contactName ?? '').trim().replace(/\s+/g, ' '),
    email: String(raw.email ?? '').trim().toLowerCase(),
    spaceId: String(raw.spaceId ?? ''),
    date: String(raw.date ?? ''),
    slot: String(raw.slot ?? ''),
    attendees: Number.parseInt(raw.attendees, 10),
    notes: String(raw.notes ?? '').trim(),
  };
}

/**
 * Valida una solicitud de reserva contra las reglas y las reservas existentes.
 * @returns {{ ok: boolean, errors: Record<string,string>, value: object }}
 */
export function validateBooking(raw, existing = [], now = new Date()) {
  const v = normalizeInput(raw);
  const errors = {};
  const today = toLocalISODate(now);
  const space = spaceById(v.spaceId);

  if (v.projectName.length < 3) errors.projectName = 'Ingresa al menos 3 caracteres.';
  else if (v.projectName.length > RULES.projectNameMax) errors.projectName = `Máximo ${RULES.projectNameMax} caracteres.`;

  if (v.contactName.length < 3) errors.contactName = 'Ingresa el nombre de la persona responsable.';
  else if (v.contactName.length > RULES.contactNameMax) errors.contactName = `Máximo ${RULES.contactNameMax} caracteres.`;

  if (!EMAIL_RE.test(v.email)) errors.email = 'Ingresa un correo válido.';

  if (!space) errors.spaceId = 'Selecciona un tipo de espacio.';

  if (!parseLocalDate(v.date)) errors.date = 'Selecciona una fecha válida.';
  else if (v.date < today) errors.date = 'La fecha no puede estar en el pasado.';
  else if (v.date > addDays(today, RULES.bookingWindowDays)) errors.date = `Solo se aceptan reservas hasta ${RULES.bookingWindowDays} días adelante.`;
  else if (isClosedDay(v.date)) errors.date = 'El CoWork está cerrado ese día.';

  if (!slotById(v.slot)) errors.slot = 'Selecciona un bloque horario.';
  else if (space && !space.allowedSlots.includes(v.slot)) errors.slot = `${space.name} solo admite jornada completa.`;

  if (!Number.isInteger(v.attendees) || v.attendees < 1) errors.attendees = 'Debe asistir al menos 1 persona.';
  else if (space && v.attendees > space.maxAttendees) errors.attendees = `${space.name} admite máximo ${space.maxAttendees} personas.`;

  if (v.notes.length > RULES.notesMax) errors.notes = `Máximo ${RULES.notesMax} caracteres.`;

  // Reglas que dependen de otras reservas: solo si lo básico es válido.
  if (Object.keys(errors).length === 0) {
    const sameProject = existing.filter(
      (b) => isActive(b) && b.date === v.date && b.projectName.toLowerCase() === v.projectName.toLowerCase(),
    );
    if (sameProject.some((b) => b.spaceId === v.spaceId && slotsOverlap(b.slot, v.slot))) {
      errors.slot = 'Este proyecto ya tiene ese espacio reservado en un bloque que se superpone.';
    } else if (sameProject.length >= RULES.maxBookingsPerProjectPerDay) {
      errors.projectName = `Cada proyecto puede tener máximo ${RULES.maxBookingsPerProjectPerDay} reservas por día.`;
    } else {
      const remaining = remainingCapacity(existing, v.spaceId, v.date, v.slot);
      const needed = unitsFor(v);
      if (remaining < needed) {
        errors.slot =
          remaining === 0
            ? 'No queda disponibilidad en ese bloque. Prueba otro horario o fecha.'
            : `Solo quedan ${remaining} ${space.consumes === 'per-attendee' ? 'puestos' : 'unidades'} en ese bloque.`;
      }
    }
  }

  return { ok: Object.keys(errors).length === 0, errors, value: v };
}

// ---------- Creación / cambios de estado ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I para evitar confusiones

export function generateCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return `CW-${code}`;
}

export function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Crea una reserva validada. Lanza un error con `.errors` si no es válida. */
export function createBooking(raw, existing = [], now = new Date()) {
  const { ok, errors, value } = validateBooking(raw, existing, now);
  if (!ok) {
    const err = new Error('Reserva inválida');
    err.errors = errors;
    throw err;
  }
  const usedCodes = new Set(existing.map((b) => b.code));
  let code;
  do code = generateCode(); while (usedCodes.has(code));

  return {
    id: generateId(),
    code,
    ...value,
    status: 'confirmed',
    createdAt: now.toISOString(),
    cancelledAt: null,
  };
}

export function cancelBooking(bookings, id, now = new Date()) {
  return bookings.map((b) =>
    b.id === id && b.status === 'confirmed' ? { ...b, status: 'cancelled', cancelledAt: now.toISOString() } : b,
  );
}

// ---------- Consultas para la vista ----------

const slotOrder = (id) => SLOTS.findIndex((s) => s.id === id);

export function sortBookings(list) {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || slotOrder(a.slot) - slotOrder(b.slot));
}

/**
 * Filtra por pestaña y texto. 'upcoming' y 'past' consideran solo confirmadas.
 * @param {'upcoming'|'past'|'cancelled'|'all'} tab
 */
export function filterBookings(bookings, { tab = 'upcoming', query = '', spaceId = '' } = {}, now = new Date()) {
  const today = toLocalISODate(now);
  const q = query.trim().toLowerCase();
  const filtered = bookings.filter((b) => {
    if (tab === 'upcoming' && !(b.status === 'confirmed' && b.date >= today)) return false;
    if (tab === 'past' && !(b.status === 'confirmed' && b.date < today)) return false;
    if (tab === 'cancelled' && b.status !== 'cancelled') return false;
    if (spaceId && b.spaceId !== spaceId) return false;
    if (q && ![b.projectName, b.contactName, b.code, b.email].some((f) => String(f).toLowerCase().includes(q))) return false;
    return true;
  });
  const sorted = sortBookings(filtered);
  return tab === 'past' || tab === 'cancelled' ? sorted.reverse() : sorted;
}

export function computeStats(bookings, now = new Date()) {
  const today = toLocalISODate(now);
  const upcoming = bookings.filter((b) => b.status === 'confirmed' && b.date >= today);
  return {
    upcoming: upcoming.length,
    projects: new Set(upcoming.map((b) => b.projectName.toLowerCase())).size,
    occupancyToday: occupancyForDate(bookings, today),
    cancelled: bookings.filter((b) => b.status === 'cancelled').length,
  };
}

/** Próximo día hábil desde hoy (incluido). */
export function nextOpenDate(now = new Date()) {
  let d = toLocalISODate(now);
  while (isClosedDay(d)) d = addDays(d, 1);
  return d;
}
