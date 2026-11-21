// Catálogo de espacios y reglas de operación del CoWork.
// Todo lo que sea "negocio configurable" vive aquí para no tocar la lógica.

/**
 * @typedef {Object} Space
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number} capacity      Unidades disponibles por bloque (puestos, salas o stands).
 * @property {number} maxAttendees  Máximo de personas por reserva.
 * @property {'per-attendee'|'per-booking'} consumes  Cómo descuenta capacidad una reserva.
 * @property {string[]} allowedSlots
 */

/** @type {Space[]} */
export const SPACES = [
  {
    id: 'mesa',
    name: 'Mesa Compartida',
    description: 'Puestos individuales en mesas abiertas. Cada asistente ocupa un puesto.',
    capacity: 12,
    maxAttendees: 4,
    consumes: 'per-attendee',
    allowedSlots: ['am', 'pm', 'full'],
  },
  {
    id: 'sala',
    name: 'Sala de Reuniones',
    description: 'Sala privada con pantalla, hasta 4 personas.',
    capacity: 3,
    maxAttendees: 4,
    consumes: 'per-booking',
    allowedSlots: ['am', 'pm', 'full'],
  },
  {
    id: 'stand',
    name: 'Stand de Exhibición',
    description: 'Stand para mostrar tu emprendimiento. Solo jornada completa.',
    capacity: 8,
    maxAttendees: 3,
    consumes: 'per-booking',
    allowedSlots: ['full'],
  },
];

/** Bloques horarios. `covers` indica qué medios bloques ocupa cada opción. */
export const SLOTS = [
  { id: 'am', label: 'Mañana', hours: '09:00 – 13:00', covers: ['am'] },
  { id: 'pm', label: 'Tarde', hours: '14:00 – 18:00', covers: ['pm'] },
  { id: 'full', label: 'Jornada completa', hours: '09:00 – 18:00', covers: ['am', 'pm'] },
];

export const RULES = {
  /** Días hacia adelante en que se aceptan reservas. */
  bookingWindowDays: 60,
  /** Días cerrados (0 = domingo … 6 = sábado). */
  closedWeekdays: [0],
  /** Máximo de reservas activas por proyecto en un mismo día. */
  maxBookingsPerProjectPerDay: 2,
  projectNameMax: 80,
  contactNameMax: 60,
  notesMax: 280,
};

export const spaceById = (id) => SPACES.find((s) => s.id === id);
export const slotById = (id) => SLOTS.find((s) => s.id === id);
