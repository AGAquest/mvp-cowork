// Exportación a CSV (compatible con Excel en español) y JSON.
import { spaceById, slotById } from './config.js';
import { SCHEMA_VERSION } from './storage.js';

const STATUS_LABEL = { confirmed: 'Confirmada', cancelled: 'Cancelada' };

/** Escapa un valor CSV y neutraliza inyección de fórmulas (=, +, -, @). */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(bookings) {
  const header = ['Código', 'Proyecto', 'Responsable', 'Correo', 'Espacio', 'Fecha', 'Bloque', 'Asistentes', 'Estado', 'Notas', 'Creada'];
  const rows = bookings.map((b) => [
    b.code,
    b.projectName,
    b.contactName,
    b.email,
    spaceById(b.spaceId)?.name ?? b.spaceId,
    b.date,
    slotById(b.slot)?.label ?? b.slot,
    b.attendees,
    STATUS_LABEL[b.status] ?? b.status,
    b.notes,
    b.createdAt,
  ]);
  // Separador ';' y BOM para que Excel con configuración regional es-CL lo abra bien.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
}

export function toJSON(bookings) {
  return JSON.stringify({ version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), bookings }, null, 2);
}

export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
