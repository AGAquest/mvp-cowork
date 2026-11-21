import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository, sanitizeRecord, STORAGE_KEY, LEGACY_KEY, StorageError } from '../js/storage.js';
import { toCSV, csvCell } from '../js/export.js';

/** Implementación mínima de localStorage en memoria. */
function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    keys: () => [...data.keys()],
  };
}

const valid = {
  id: 'abc', code: 'CW-ABCDE', projectName: 'EcoBox', contactName: 'Ana', email: 'ana@correo.cl',
  spaceId: 'sala', date: '2026-11-20', slot: 'am', attendees: 2, notes: '', status: 'confirmed',
  createdAt: '2026-11-19T10:00:00.000Z', cancelledAt: null,
};

describe('repositorio', () => {
  test('arranca vacío y persiste con versión', () => {
    const store = memoryStore();
    const repo = createRepository(store);
    assert.deepEqual(repo.load().bookings, []);
    repo.save([valid]);
    const saved = JSON.parse(store.getItem(STORAGE_KEY));
    assert.equal(saved.version, 2);
    assert.deepEqual(createRepository(store).load().bookings, [valid]);
  });

  test('migra los datos del MVP original', () => {
    const legacy = [
      { projectName: 'Feria Verde', spaceType: 'Stand Exhibición', date: '2026-11-21' },
      { projectName: 'Roto', spaceType: 'Desconocido', date: '2026-11-21' },
    ];
    const store = memoryStore({ [LEGACY_KEY]: JSON.stringify(legacy) });
    const { bookings, notice } = createRepository(store).load();
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].spaceId, 'stand');
    assert.equal(bookings[0].slot, 'full');
    assert.match(notice, /migraron 1/);
    assert.equal(store.getItem(LEGACY_KEY), null);
  });

  test('datos corruptos: respalda y reinicia sin romper', () => {
    const store = memoryStore({ [STORAGE_KEY]: '{no es json' });
    const { bookings, notice } = createRepository(store).load();
    assert.deepEqual(bookings, []);
    assert.match(notice, /dañados/);
    assert.ok(store.keys().some((k) => k.startsWith(`${STORAGE_KEY}_corrupt_`)));
  });

  test('descarta registros inválidos y elimina ids duplicados', () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ version: 2, bookings: [valid, { ...valid }, { foo: 1 }] }),
    });
    const { bookings, notice } = createRepository(store).load();
    assert.equal(bookings.length, 2);
    assert.notEqual(bookings[0].id, bookings[1].id);
    assert.notEqual(bookings[0].code, bookings[1].code);
    assert.match(notice, /1 registros/);
  });

  test('error de cuota se traduce a StorageError', () => {
    const store = memoryStore();
    store.setItem = () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
    assert.throws(() => createRepository(store).save([]), (e) => e instanceof StorageError && /espacio/.test(e.message));
  });

  test('parseImport acepta respaldo v2, arreglo plano y legacy', () => {
    const repo = createRepository(memoryStore());
    assert.equal(repo.parseImport(JSON.stringify({ version: 2, bookings: [valid] })).bookings.length, 1);
    assert.equal(repo.parseImport(JSON.stringify([valid, { x: 1 }])).skipped, 1);
    const legacy = repo.parseImport(JSON.stringify([{ projectName: 'X', spaceType: 'Mesa Compartida', date: '2026-11-21' }]));
    assert.equal(legacy.bookings[0].spaceId, 'mesa');
    assert.throws(() => repo.parseImport('nope'), StorageError);
    assert.throws(() => repo.parseImport('{"a":1}'), StorageError);
  });
});

describe('sanitizeRecord', () => {
  test('recorta textos y fuerza estado válido', () => {
    const r = sanitizeRecord({ ...valid, projectName: 'x'.repeat(200), status: 'hacked', attendees: '-3' });
    assert.equal(r.projectName.length, 80);
    assert.equal(r.status, 'confirmed');
    assert.equal(r.attendees, 1);
  });
  test('rechaza espacio o fecha inválidos', () => {
    assert.equal(sanitizeRecord({ ...valid, spaceId: 'piscina' }), null);
    assert.equal(sanitizeRecord({ ...valid, date: '2026-13-01' }), null);
  });
});

describe('exportación CSV', () => {
  test('escapa separadores, comillas y neutraliza fórmulas', () => {
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('di "hola"'), '"di ""hola"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  });
  test('incluye BOM, encabezado y etiquetas legibles', () => {
    const csv = toCSV([valid]);
    assert.ok(csv.startsWith('﻿Código;Proyecto'));
    assert.match(csv, /Sala de Reuniones;2026-11-20;Mañana;2;Confirmada/);
  });
});
