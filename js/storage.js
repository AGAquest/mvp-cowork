// Persistencia versionada sobre localStorage (o cualquier objeto con la misma API, para tests).
import { SPACES, SLOTS } from './config.js';
import { generateId, generateCode, parseLocalDate } from './bookings.js';

export const STORAGE_KEY = 'cowork_hub_v2';
export const LEGACY_KEY = 'cowork_bookings'; // formato del MVP original
export const SCHEMA_VERSION = 2;

export class StorageError extends Error {}

const LEGACY_SPACE_MAP = {
  'Mesa Compartida': 'mesa',
  'Sala de Reuniones': 'sala',
  'Stand Exhibición': 'stand',
};

/**
 * Normaliza un registro desconocido (de storage o de un JSON importado).
 * Devuelve null si no es rescatable. Es más permisivo que validateBooking:
 * aquí no se exige fecha futura, porque el historial también se guarda.
 */
export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const str = (x, max = 300) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
  const projectName = str(r.projectName, 80);
  const spaceId = SPACES.some((s) => s.id === r.spaceId) ? r.spaceId : null;
  const slot = SLOTS.some((s) => s.id === r.slot) ? r.slot : null;
  if (!projectName || !spaceId || !slot || !parseLocalDate(r.date)) return null;

  return {
    id: str(r.id, 64) || generateId(),
    code: /^CW-[A-Z0-9]{5}$/.test(r.code) ? r.code : generateCode(),
    projectName,
    contactName: str(r.contactName, 60),
    email: str(r.email, 120).toLowerCase(),
    spaceId,
    date: r.date,
    slot,
    attendees: Math.max(1, Number.parseInt(r.attendees, 10) || 1),
    notes: str(r.notes, 280),
    status: r.status === 'cancelled' ? 'cancelled' : 'confirmed',
    createdAt: str(r.createdAt, 40) || new Date().toISOString(),
    cancelledAt: r.status === 'cancelled' ? str(r.cancelledAt, 40) || null : null,
  };
}

/** Convierte las reservas del MVP original ({projectName, spaceType, date}). */
export function migrateLegacy(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((old) =>
      sanitizeRecord({
        projectName: old?.projectName,
        spaceId: LEGACY_SPACE_MAP[old?.spaceType],
        date: old?.date,
        slot: 'full',
        attendees: 1,
        contactName: '',
        notes: 'Migrada desde la versión anterior',
      }),
    )
    .filter(Boolean);
}

/** Asegura que no haya ids ni códigos repetidos (p. ej. tras importar). */
function dedupe(list) {
  const ids = new Set();
  const codes = new Set();
  return list.map((b) => {
    let { id, code } = b;
    while (ids.has(id)) id = generateId();
    while (codes.has(code)) code = generateCode();
    ids.add(id);
    codes.add(code);
    return id === b.id && code === b.code ? b : { ...b, id, code };
  });
}

export function createRepository(store = globalThis.localStorage) {
  if (!store) throw new StorageError('No hay almacenamiento disponible en este navegador.');

  function load() {
    let raw;
    try {
      raw = store.getItem(STORAGE_KEY);
    } catch {
      throw new StorageError('El navegador bloqueó el acceso al almacenamiento local.');
    }

    if (raw == null) {
      // Primera ejecución: intentar migrar datos del MVP original.
      const legacyRaw = store.getItem(LEGACY_KEY);
      if (legacyRaw) {
        try {
          const migrated = dedupe(migrateLegacy(JSON.parse(legacyRaw)));
          save(migrated);
          store.removeItem(LEGACY_KEY);
          return { bookings: migrated, notice: `Se migraron ${migrated.length} reservas de la versión anterior.` };
        } catch {
          /* datos legacy corruptos: se ignoran */
        }
      }
      return { bookings: [], notice: null };
    }

    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== SCHEMA_VERSION || !Array.isArray(data.bookings)) throw new Error('schema');
      const clean = dedupe(data.bookings.map(sanitizeRecord).filter(Boolean));
      const dropped = data.bookings.length - clean.length;
      return { bookings: clean, notice: dropped > 0 ? `Se descartaron ${dropped} registros dañados.` : null };
    } catch {
      // No perdemos los datos: se respaldan para revisión manual y se parte de cero.
      try {
        store.setItem(`${STORAGE_KEY}_corrupt_${Date.now()}`, raw);
      } catch {
        /* sin espacio para respaldo */
      }
      save([]);
      return { bookings: [], notice: 'Los datos guardados estaban dañados; se respaldaron y se reinició la lista.' };
    }
  }

  function save(bookings) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, savedAt: new Date().toISOString(), bookings }));
    } catch (e) {
      const quota = e && (e.name === 'QuotaExceededError' || e.code === 22);
      throw new StorageError(quota ? 'No queda espacio en el almacenamiento local.' : 'No se pudo guardar la información.');
    }
  }

  /** Importa un respaldo JSON (formato v2 o arreglo plano / legacy). */
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new StorageError('El archivo no es un JSON válido.');
    }
    const list = Array.isArray(data) ? data : data?.bookings;
    if (!Array.isArray(list)) throw new StorageError('El archivo no contiene reservas.');
    const isLegacy = list.length > 0 && list.every((r) => r && 'spaceType' in r && !('spaceId' in r));
    const clean = isLegacy ? migrateLegacy(list) : list.map(sanitizeRecord).filter(Boolean);
    return { bookings: clean, skipped: list.length - clean.length };
  }

  return { load, save, parseImport, dedupe };
}
