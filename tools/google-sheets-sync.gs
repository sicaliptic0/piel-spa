/**
 * Piel Spa → Google Sheets sync (Apps Script).
 *
 * Paste this whole file into the spreadsheet: Extensiones → Apps Script.
 * It adds a "Piel Spa" menu and keeps one tab per month ("Sep 2026 · Sistema")
 * with the same data as the admin's "Hoy" tab: a title row per day, that day's
 * patients, and a "Total del día" row, plus the month total at the top.
 *
 * What it touches and what it doesn't:
 *  - Columns A–K of its own "· Sistema" tabs are rewritten on every sync
 *    (the system is the source of truth; edit visits in the admin).
 *  - Anything you add from column L onward in those tabs is kept and follows
 *    its visit (matched by the hidden ID in column K), even when new visits
 *    are inserted above it. Formulas there keep their relative references.
 *  - Your other tabs are never touched.
 *
 * Data comes from the sheet_export() database function
 * (supabase/migrations/20260926_google_sheets_export.sql), unlocked by a key
 * stored in this script's properties — never in the sheet itself.
 */

const SUPABASE_URL = 'https://qkjmrnqkoipdltauweub.supabase.co';
// Public "anon" key, the same one the website uses; it grants nothing by itself.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFram1ybnFrb2lwZGx0YXV3ZXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTkyMjgsImV4cCI6MjA4OTA5NTIyOH0.EGqgJ9RNY9vYfuVeeEcGoMu_cIaygRq0hnyT-iE7zTw';
const TIME_ZONE = 'America/New_York';
const TOKEN_PROPERTY = 'PIEL_SPA_SYNC_TOKEN';

const HEADERS = ['#', 'Hora', 'Paciente', 'F. nacimiento', 'Edad', 'Teléfono', 'Ubicación', 'Procedimientos', 'Monto', 'Observaciones', 'ID'];
const WIDTH = HEADERS.length;        // A–K are managed by the sync
const COL_AMOUNT = 9;                // I
const COL_LABEL = 8;                 // H — holds "Total del día"
const COL_KEY = 11;                  // K — hidden row key
const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;
const DAY_TOTAL_LABEL = 'Total del día';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Spanish names for encounters saved before the procedures summary existed.
const PROCEDURE_LABELS = {
  general_consultation: 'Consulta General',
  upper_face_rejuvenation: 'Rejuvenecimiento de la Parte Superior',
  masseter_reduction_bruxism: 'Reducción del Masetero (Bruxismo)',
  gummy_smile_correction: 'Corrección de Sonrisa Gingival',
  nasal_profiling: 'Perfilado Nasal',
  hyperhidrosis_treatment: 'Tratamiento de Hiperhidrosis',
  lip_augmentation: 'Aumento de Labios',
  facial_harmonization: 'Armonización Facial',
  jawline_masculinization: 'Masculinización de la Mandíbula',
  facial_feminization: 'Feminización Facial',
  sculptra: 'Sculptra',
  radiesse: 'Radiesse',
  exosomes_therapy_direct_injection: 'Terapia con Exosomas (Inyección Directa)',
  microneedling_exosomes: 'Microneedling + Exosomas',
  salmon_pdrn_direct_injection: 'Salmon PDRN (Inyección Directa)',
  microneedling_salmon_pdrn: 'Microneedling + Salmon PDRN',
  nctf_skin_boosting: 'Impulso de la Piel con NCTF',
  fractional_co2_laser_resurfacing: 'Resurfacing con Láser CO2 Fraccionado',
  facial_cleansing: 'Limpieza Facial',
};

// ---------- Menu ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Piel Spa')
    .addItem('Actualizar ahora', 'syncNow')
    .addItem('Actualizar un mes anterior…', 'syncMonthPrompt')
    .addSeparator()
    .addItem('Configurar clave de sincronización…', 'setSyncToken')
    .addItem('Activar actualización automática (cada 10 min)', 'installTrigger')
    .addItem('Desactivar actualización automática', 'removeTriggers')
    .addToUi();
}

function setSyncToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Clave de sincronización', 'Pega la clave que te dio el SQL en Supabase:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const token = res.getResponseText().trim();
  if (!/^[0-9a-f]{32,}$/i.test(token)) { ui.alert('Esa clave no parece válida. Debe ser una línea larga de letras y números.'); return; }
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROPERTY, token);
  ui.alert('Clave guardada. Ahora usa "Piel Spa → Actualizar ahora".');
}

function installTrigger() {
  removeTriggers(true);
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getUi().alert('Listo: el Sheet se actualizará solo cada 10 minutos.');
}

function removeTriggers(silent) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncNow')
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) SpreadsheetApp.getUi().alert('Actualización automática desactivada.');
}

// ---------- Sync ----------

// Current month, plus the previous one during the first week of a month so
// late edits to last month's visits still reach the sheet.
function syncNow() {
  const [y, m, d] = todayIso().split('-').map(Number);
  withLock(() => {
    syncMonth(y, m);
    if (d <= 7) {
      const prev = m === 1 ? [y - 1, 12] : [y, m - 1];
      syncMonth(prev[0], prev[1]);
    }
  });
}

function syncMonthPrompt() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Actualizar un mes', 'Escribe el mes como AAAA-MM (por ejemplo 2026-08):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const match = res.getResponseText().trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) { ui.alert('Formato no válido. Usa AAAA-MM, por ejemplo 2026-08.'); return; }
  withLock(() => syncMonth(Number(match[1]), Number(match[2])));
  ui.alert(`Listo: ${MONTHS[Number(match[2]) - 1]} ${match[1]} actualizado.`);
}

function withLock(fn) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return; // another sync is running
  try { fn(); } finally { lock.releaseLock(); }
}

function syncMonth(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  const visits = fetchVisits(isoDate(year, month, 1), isoDate(year, month, lastDay));
  const sheet = getMonthSheet(year, month);
  writeMonth(sheet, year, month, visits);
}

function fetchVisits(from, to) {
  const token = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  if (!token) throw new Error('Falta la clave. Usa el menú "Piel Spa → Configurar clave de sincronización".');
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/rpc/sheet_export`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    payload: JSON.stringify({ p_token: token, p_from: from, p_to: to }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 401 || code === 403) throw new Error('La clave de sincronización no es válida. Vuelve a configurarla.');
  if (code >= 300) throw new Error(`Supabase respondió ${code}: ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText());
}

function getMonthSheet(year, month) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = `${MONTHS_SHORT[month - 1]} ${year} · Sistema`;
  return ss.getSheetByName(name) || ss.insertSheet(name, 0);
}

function writeMonth(sheet, year, month, visits) {
  // 1) Remember the user's own columns (L onward), keyed by row.
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const extraWidth = Math.max(0, lastCol - WIDTH);
  const extras = {};
  if (lastRow >= FIRST_DATA_ROW && extraWidth > 0) {
    const n = lastRow - FIRST_DATA_ROW + 1;
    const keys = sheet.getRange(FIRST_DATA_ROW, COL_KEY, n, 1).getValues();
    // Display values (as shown) so dates/currency come back exactly as typed.
    const values = sheet.getRange(FIRST_DATA_ROW, WIDTH + 1, n, extraWidth).getDisplayValues();
    const formulas = sheet.getRange(FIRST_DATA_ROW, WIDTH + 1, n, extraWidth).getFormulasR1C1();
    keys.forEach(([key], i) => {
      if (!key) return;
      const row = values[i].map((v, j) => formulas[i][j] || v);
      if (row.some(v => v !== '')) extras[key] = row;
    });
  }

  // 2) Build the new layout.
  const now = Utilities.formatDate(new Date(), TIME_ZONE, 'dd/MM/yyyy h:mm a');
  const layout = buildMonthRows(year, month, visits, now);

  // 3) Rewrite A–K, then put the user's columns back on their rows.
  const clearRows = Math.max(lastRow, layout.rows.length, FIRST_DATA_ROW);
  const managed = sheet.getRange(1, 1, clearRows, WIDTH);
  managed.breakApart();
  managed.clear();
  if (extraWidth > 0 && lastRow >= FIRST_DATA_ROW) {
    sheet.getRange(FIRST_DATA_ROW, WIDTH + 1, lastRow - FIRST_DATA_ROW + 1, extraWidth).clearContent();
  }

  sheet.getRange(1, 1, layout.rows.length, WIDTH).setNumberFormat('@'); // keep dates/phones as typed
  sheet.getRange(FIRST_DATA_ROW, COL_AMOUNT, Math.max(1, layout.rows.length - FIRST_DATA_ROW + 1), 1).setNumberFormat('$#,##0.00');
  sheet.getRange(1, COL_AMOUNT).setNumberFormat('$#,##0.00');
  sheet.getRange(1, 1, layout.rows.length, WIDTH).setValues(layout.rows);

  if (extraWidth > 0) {
    layout.rows.forEach((row, i) => {
      const saved = extras[row[COL_KEY - 1]];
      if (saved) sheet.getRange(i + 1, WIDTH + 1, 1, extraWidth).setFormulasR1C1([saved.map(String)]);
    });
  }

  // 4) Formatting.
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.getRange(1, COL_LABEL, 1, 2).setFontWeight('bold');
  sheet.getRange(2, 1).setFontColor('#8a7f86').setFontStyle('italic');
  sheet.getRange(HEADER_ROW, 1, 1, WIDTH).setFontWeight('bold').setBackground('#2A2330').setFontColor('#ffffff');
  layout.kinds.forEach((kind, i) => {
    const r = i + 1;
    if (kind === 'day') {
      sheet.getRange(r, 1, 1, WIDTH - 1).merge().setBackground('#FBF0F3').setFontWeight('bold').setFontColor('#B76E88');
    } else if (kind === 'total') {
      sheet.getRange(r, 1, 1, WIDTH - 1).setFontWeight('bold').setBorder(true, null, null, null, null, null);
    }
  });
  sheet.getRange(FIRST_DATA_ROW, 1, Math.max(1, layout.rows.length - FIRST_DATA_ROW + 1), WIDTH).setVerticalAlignment('top');
  sheet.getRange(FIRST_DATA_ROW, COL_LABEL, Math.max(1, layout.rows.length - FIRST_DATA_ROW + 1), 1).setWrap(true);
  sheet.getRange(FIRST_DATA_ROW, 10, Math.max(1, layout.rows.length - FIRST_DATA_ROW + 1), 1).setWrap(true);
  sheet.setFrozenRows(HEADER_ROW);
  sheet.hideColumns(COL_KEY);
  [40, 75, 170, 95, 55, 115, 150, 300, 90, 220].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
}

// ---------- Layout (no Sheets calls, so it can be tested on its own) ----------

// Returns { rows, kinds }: rows are WIDTH-wide arrays for A–K; kinds says what
// each row is ('title' | 'note' | 'header' | 'day' | 'visit' | 'total' | 'blank').
// Column K holds a stable key per row: the visit id, or day:/total: + date.
function buildMonthRows(year, month, visits, updatedLabel) {
  const blank = () => new Array(WIDTH).fill('');
  const rows = [];
  const kinds = [];
  const push = (row, kind) => { rows.push(row); kinds.push(kind); };

  const title = blank();
  title[0] = `${capitalize(MONTHS[month - 1])} ${year}`;
  title[COL_LABEL - 1] = 'Total del mes';
  title[COL_AMOUNT - 1] = `=SUMIF($H$${FIRST_DATA_ROW}:$H,"${DAY_TOTAL_LABEL}",$I$${FIRST_DATA_ROW}:$I)`;
  push(title, 'title');

  const note = blank();
  note[0] = `Se actualiza solo desde el sistema (última vez: ${updatedLabel}). Las columnas A–J se reescriben; agrega tus columnas desde la L.`;
  push(note, 'note');

  push(HEADERS.slice(), 'header');

  const byDay = {};
  visits.forEach(v => { (byDay[v.visit_date] = byDay[v.visit_date] || []).push(v); });
  const days = Object.keys(byDay).sort();

  if (!days.length) {
    const empty = blank();
    empty[0] = 'Todavía no hay pacientes atendidos este mes.';
    push(empty, 'blank');
    return { rows, kinds };
  }

  days.forEach((day, dayIndex) => {
    const dayRow = blank();
    dayRow[0] = formatDayTitle(day);
    dayRow[COL_KEY - 1] = `day:${day}`;
    push(dayRow, 'day');

    const firstVisitRow = rows.length + 1;
    byDay[day].forEach((v, i) => {
      const r = blank();
      r[0] = String(i + 1);
      r[1] = formatTime(v.visit_time);
      r[2] = [v.first_name, v.last_name].filter(Boolean).join(' ') || 'Paciente';
      r[3] = formatDob(v.dob);
      r[4] = ageAt(v.dob, v.visit_date);
      r[5] = formatPhone(v.phone);
      r[6] = [v.city, v.state].filter(Boolean).join(', ');
      r[7] = v.procedures_summary || legacyProcedures(v.procedures_realized_ids);
      r[8] = v.amount === null || v.amount === undefined ? 'Pendiente' : Number(v.amount);
      r[9] = v.frontdesk_notes || '';
      r[10] = v.id;
      push(r, 'visit');
    });
    const lastVisitRow = rows.length;

    const total = blank();
    total[COL_LABEL - 1] = DAY_TOTAL_LABEL;
    total[COL_AMOUNT - 1] = `=SUM(I${firstVisitRow}:I${lastVisitRow})`;
    total[COL_KEY - 1] = `total:${day}`;
    push(total, 'total');

    if (dayIndex < days.length - 1) push(blank(), 'blank');
  });

  return { rows, kinds };
}

// ---------- Formatting helpers ----------

function todayIso() { return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd'); }
function isoDate(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function formatDayTitle(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} de ${MONTHS[m - 1]} de ${y}`;
}

function formatTime(t) {
  if (!t) return '';
  const [h, min] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return String(t);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(min || 0).padStart(2, '0')} ${suffix}`;
}

function formatDob(dob) {
  if (!dob) return '';
  const [y, m, d] = String(dob).split('-');
  return y && m && d ? `${m}/${d.slice(0, 2)}/${y}` : String(dob);
}

// Age on the day of the visit, so older months keep the age the patient had then.
function ageAt(dob, onIso) {
  if (!dob || !onIso) return '';
  const [by, bm, bd] = String(dob).split('-').map(Number);
  const [vy, vm, vd] = String(onIso).split('-').map(Number);
  if (!by || !vy) return '';
  let age = vy - by;
  if (vm < bm || (vm === bm && vd < bd)) age--;
  return age >= 0 ? String(age) : '';
}

// "+15551234567" / "5551234567" → "(555) 123-4567"; other countries keep "+" and digits.
function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const us = digits.length === 11 && digits.charAt(0) === '1' ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (us) return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  return String(phone).trim().charAt(0) === '+' ? `+${digits}` : String(phone).trim();
}

function legacyProcedures(idsJson) {
  let ids = [];
  try { ids = JSON.parse(idsJson || '[]') || []; } catch (e) { ids = []; }
  return ids.map(id => PROCEDURE_LABELS[id] || id).join(', ');
}

// Lets the layout be tested outside Apps Script (ignored inside it).
if (typeof module !== 'undefined') {
  module.exports = { buildMonthRows, formatDayTitle, formatTime, formatDob, ageAt, formatPhone, legacyProcedures };
}
