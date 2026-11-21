import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBooking, createBooking, cancelBooking, remainingCapacity, filterBookings,
  computeStats, toLocalISODate, parseLocalDate, isClosedDay, nextOpenDate, occupancyForDate,
} from '../js/bookings.js';

// Jueves 19 de noviembre de 2026, 22:30 local (en UTC ya sería viernes).
const NOW = new Date(2026, 10, 19, 22, 30);
const DAY = '2026-11-20'; // viernes

const base = (over = {}) => ({
  projectName: 'EcoBox',
  contactName: 'Ana Pérez',
  email: 'ana@correo.cl',
  spaceId: 'sala',
  date: DAY,
  slot: 'am',
  attendees: 2,
  notes: '',
  ...over,
});

/** Crea varias reservas válidas encadenadas. */
function seed(inputs) {
  return inputs.reduce((acc, input) => [...acc, createBooking(input, acc, NOW)], []);
}

describe('fechas', () => {
  test('toLocalISODate usa la fecha local, no UTC', () => {
    assert.equal(toLocalISODate(NOW), '2026-11-19');
  });
  test('parseLocalDate rechaza fechas imposibles', () => {
    assert.equal(parseLocalDate('2026-02-31'), null);
    assert.equal(parseLocalDate('20-11-2026'), null);
    assert.ok(parseLocalDate('2028-02-29'));
  });
  test('domingo cerrado y nextOpenDate lo salta', () => {
    assert.equal(isClosedDay('2026-11-22'), true);
    assert.equal(nextOpenDate(new Date(2026, 10, 22, 10)), '2026-11-23');
  });
});

describe('validateBooking', () => {
  test('acepta una reserva válida y normaliza espacios/correo', () => {
    const r = validateBooking(base({ projectName: '  Eco   Box ', email: ' ANA@Correo.CL ' }), [], NOW);
    assert.equal(r.ok, true);
    assert.equal(r.value.projectName, 'Eco Box');
    assert.equal(r.value.email, 'ana@correo.cl');
  });

  test('rechaza campos vacíos o inválidos', () => {
    const r = validateBooking({ attendees: '0' }, [], NOW);
    assert.equal(r.ok, false);
    for (const k of ['projectName', 'contactName', 'email', 'spaceId', 'date', 'slot', 'attendees']) {
      assert.ok(r.errors[k], `falta error para ${k}`);
    }
  });

  test('rechaza fechas pasadas, domingos y fuera de ventana', () => {
    assert.match(validateBooking(base({ date: '2026-11-18' }), [], NOW).errors.date, /pasado/);
    assert.match(validateBooking(base({ date: '2026-11-22' }), [], NOW).errors.date, /cerrado/);
    assert.match(validateBooking(base({ date: '2027-03-01' }), [], NOW).errors.date, /60 días/);
  });

  test('permite reservar para hoy', () => {
    assert.equal(validateBooking(base({ date: '2026-11-19' }), [], NOW).ok, true);
  });

  test('stand solo admite jornada completa', () => {
    const r = validateBooking(base({ spaceId: 'stand', slot: 'am', attendees: 1 }), [], NOW);
    assert.match(r.errors.slot, /jornada completa/);
  });

  test('respeta máximo de asistentes por espacio', () => {
    assert.ok(validateBooking(base({ attendees: 5 }), [], NOW).errors.attendees);
  });
});

describe('capacidad', () => {
  test('salas: 3 por bloque, la cuarta se rechaza', () => {
    const existing = seed(['Proy A1', 'Proy B2', 'Proy C3'].map((p) => base({ projectName: p })));
    assert.equal(remainingCapacity(existing, 'sala', DAY, 'am'), 0);
    assert.equal(remainingCapacity(existing, 'sala', DAY, 'pm'), 3);
    const r = validateBooking(base({ projectName: 'Proy D4' }), existing, NOW);
    assert.match(r.errors.slot, /No queda disponibilidad/);
  });

  test('jornada completa ocupa mañana y tarde', () => {
    const existing = seed([base({ slot: 'full' })]);
    assert.equal(remainingCapacity(existing, 'sala', DAY, 'am'), 2);
    assert.equal(remainingCapacity(existing, 'sala', DAY, 'pm'), 2);
  });

  test('jornada completa queda limitada por el medio bloque más ocupado', () => {
    const existing = seed(['Proy A1', 'Proy B2'].map((p) => base({ projectName: p, slot: 'pm' })));
    assert.equal(remainingCapacity(existing, 'sala', DAY, 'full'), 1);
  });

  test('mesa compartida descuenta por asistente', () => {
    const existing = seed([
      base({ projectName: 'Proy A1', spaceId: 'mesa', attendees: 4 }),
      base({ projectName: 'Proy B2', spaceId: 'mesa', attendees: 4 }),
      base({ projectName: 'Proy C3', spaceId: 'mesa', attendees: 3 }),
    ]);
    assert.equal(remainingCapacity(existing, 'mesa', DAY, 'am'), 1);
    const r = validateBooking(base({ projectName: 'Proy D4', spaceId: 'mesa', attendees: 2 }), existing, NOW);
    assert.match(r.errors.slot, /Solo quedan 1 puestos/);
  });

  test('las canceladas liberan cupo', () => {
    let list = seed(['Proy A1', 'Proy B2', 'Proy C3'].map((p) => base({ projectName: p })));
    list = cancelBooking(list, list[0].id, NOW);
    assert.equal(remainingCapacity(list, 'sala', DAY, 'am'), 1);
    assert.equal(list[0].status, 'cancelled');
    assert.ok(list[0].cancelledAt);
  });

  test('ocupación del día en porcentaje', () => {
    assert.equal(occupancyForDate([], DAY), 0);
    const list = seed([base({ spaceId: 'stand', slot: 'full', attendees: 1 })]);
    // 1 stand en 2 medios bloques sobre (12+3+8)*2 = 46 unidades
    assert.equal(occupancyForDate(list, DAY), Math.round((2 / 46) * 100));
  });
});

describe('reglas por proyecto', () => {
  test('no permite el mismo espacio en bloques superpuestos', () => {
    const existing = seed([base({ slot: 'full' })]);
    const r = validateBooking(base({ slot: 'pm', projectName: 'ecobox' }), existing, NOW);
    assert.match(r.errors.slot, /superpone/);
  });

  test('máximo 2 reservas por proyecto al día', () => {
    const existing = seed([base(), base({ spaceId: 'mesa', attendees: 1 })]);
    const r = validateBooking(base({ spaceId: 'stand', slot: 'full', attendees: 1 }), existing, NOW);
    assert.match(r.errors.projectName, /máximo 2/);
  });
});

describe('createBooking', () => {
  test('genera id, código único y metadatos', () => {
    const b = createBooking(base(), [], NOW);
    assert.match(b.code, /^CW-[A-Z2-9]{5}$/);
    assert.ok(b.id);
    assert.equal(b.status, 'confirmed');
    assert.equal(b.createdAt, NOW.toISOString());
  });

  test('lanza error con detalle si es inválida', () => {
    assert.throws(() => createBooking({}, [], NOW), (e) => Boolean(e.errors?.projectName));
  });
});

describe('consultas', () => {
  const list = [
    { id: '1', code: 'CW-AAAAA', projectName: 'Alfa', contactName: 'X', email: '', spaceId: 'sala', date: '2026-11-25', slot: 'pm', attendees: 1, status: 'confirmed' },
    { id: '2', code: 'CW-BBBBB', projectName: 'Beta', contactName: 'Y', email: '', spaceId: 'mesa', date: '2026-11-25', slot: 'am', attendees: 1, status: 'confirmed' },
    { id: '3', code: 'CW-CCCCC', projectName: 'Gama', contactName: 'Z', email: '', spaceId: 'stand', date: '2026-11-10', slot: 'full', attendees: 1, status: 'confirmed' },
    { id: '4', code: 'CW-DDDDD', projectName: 'Delta', contactName: 'W', email: '', spaceId: 'sala', date: '2026-11-30', slot: 'am', attendees: 1, status: 'cancelled' },
  ];

  test('pestañas y orden por fecha + bloque', () => {
    assert.deepEqual(filterBookings(list, { tab: 'upcoming' }, NOW).map((b) => b.id), ['2', '1']);
    assert.deepEqual(filterBookings(list, { tab: 'past' }, NOW).map((b) => b.id), ['3']);
    assert.deepEqual(filterBookings(list, { tab: 'cancelled' }, NOW).map((b) => b.id), ['4']);
  });

  test('búsqueda por código y filtro por espacio', () => {
    assert.deepEqual(filterBookings(list, { tab: 'all', query: 'cw-ddd' }, NOW).map((b) => b.id), ['4']);
    assert.deepEqual(filterBookings(list, { tab: 'all', spaceId: 'sala' }, NOW).map((b) => b.id), ['1', '4']);
  });

  test('estadísticas', () => {
    assert.deepEqual(computeStats(list, NOW), { upcoming: 2, projects: 2, occupancyToday: 0, cancelled: 1 });
  });
});
