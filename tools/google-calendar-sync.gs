/**
 * Piel Spa → Google Calendar sync (Apps Script).
 *
 * Keeps a calendar called "Citas Piel Spa" in this Google account in step with
 * the appointments in the admin (both clinics), every 5 minutes:
 *   - new appointment → new event (title = patient's full name · treatments)
 *   - moved / changed → the event moves or changes
 *   - cancelled or deleted → the event is removed
 * Piel Spa events are pink, Divine Bliss Studio events are purple; the place
 * is the clinic's address and the description has the phone and the status.
 *
 * One way only: the admin is the source of truth. Editing or deleting an event
 * in Google Calendar doesn't change the appointment (the next sync puts it back).
 *
 * Setup (once), at script.google.com with the clinic's Google account:
 *   1. New project → paste this whole file.
 *   2. Put the key from the SQL (clave_para_google_calendar) in SYNC_KEY below.
 *   3. Run "instalar" (▶) and accept the permissions. It creates the calendar,
 *      syncs once and turns on the 5-minute update.
 *   4. In Google Calendar → "Citas Piel Spa" → Settings → Share with specific
 *      people → add each admin ("See all event details").
 *
 * Data comes from calendar_export() (supabase/migrations/20261024_calendar_export.sql).
 */

const SYNC_KEY = 'PEGA_AQUI_LA_CLAVE';

const SUPABASE_URL = 'https://qkjmrnqkoipdltauweub.supabase.co';
// Public "anon" key, the same one the website uses; it grants nothing by itself.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFram1ybnFrb2lwZGx0YXV3ZXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTkyMjgsImV4cCI6MjA4OTA5NTIyOH0.EGqgJ9RNY9vYfuVeeEcGoMu_cIaygRq0hnyT-iE7zTw';
const TIME_ZONE = 'America/New_York';
const CALENDAR_NAME = 'Citas Piel Spa';
const CALENDAR_ID_PROPERTY = 'PIEL_SPA_CALENDAR_ID';
const DAYS_BACK = 7;      // keeps the last week's events too
const DAYS_AHEAD = 200;   // calendar_export allows up to 220 days per call
const TAG_ID = 'piel_appt_id';
const TAG_SIG = 'piel_sig';

const CLINIC_COLORS = {
  piel_spa: CalendarApp.EventColor.PALE_RED,
  divine_bliss: CalendarApp.EventColor.MAUVE,
};
const STATUS_ES = { pending: 'Pendiente', confirmed: 'Confirmada', modified: 'Modificada' };

const TREATMENT_LABELS = {
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
  filler_dissolution: 'Disolución de Rellenos',
  sculptra: 'Sculptra',
  radiesse: 'Radiesse',
  exosomes_therapy_direct_injection: 'Terapia con Exosomas (Inyección Directa)',
  microneedling_exosomes: 'Microneedling + Exosomas',
  salmon_pdrn_direct_injection: 'Salmon PDRN (Inyección Directa)',
  microneedling_salmon_pdrn: 'Microneedling + Salmon PDRN',
  nctf_skin_boosting: 'Impulso de la Piel con NCTF',
  fractional_co2_laser_resurfacing: 'Resurfacing con Láser CO2 Fraccionado',
  facial_cleansing: 'Limpieza Facial',
  weight_loss_consultation: 'Consulta de Pérdida de Peso',
};

// ---------- Setup ----------

function instalar() {
  if (!SYNC_KEY || SYNC_KEY === 'PEGA_AQUI_LA_CLAVE') throw new Error('Primero pega la clave en SYNC_KEY (arriba).');
  getCalendar_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sincronizar').timeBased().everyMinutes(5).create();
  const result = sincronizar();
  Logger.log('Listo. Calendario "%s" creado/encontrado y sincronizado: %s', CALENDAR_NAME, JSON.stringify(result));
}

function desinstalar() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('Actualización automática desactivada (el calendario queda como está).');
}

// The clinic calendar: the one saved by id, else one with that name, else a new one.
function getCalendar_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(CALENDAR_ID_PROPERTY);
  let cal = savedId ? CalendarApp.getCalendarById(savedId) : null;
  if (!cal) cal = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0] || null;
  if (!cal) {
    cal = CalendarApp.createCalendar(CALENDAR_NAME, {
      timeZone: TIME_ZONE,
      color: CalendarApp.Color.PINK,
      summary: 'Citas de Piel Spa y Divine Bliss Studio. Se actualiza solo desde el admin (piel-spa.com/admin.html); los cambios hechos aquí no se guardan.',
    });
  }
  props.setProperty(CALENDAR_ID_PROPERTY, cal.getId());
  return cal;
}

// ---------- Sync ----------

function sincronizar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { skipped: 'busy' };
  try {
    const cal = getCalendar_();
    const today = new Date();
    const from = new Date(today.getTime() - DAYS_BACK * 86400000);
    const to = new Date(today.getTime() + DAYS_AHEAD * 86400000);
    const rows = fetchAppointments_(isoDate_(from), isoDate_(to));

    // Events this script made, by appointment id (a duplicate is removed).
    const existing = {};
    const result = { created: 0, updated: 0, removed: 0, unchanged: 0 };
    cal.getEvents(startOfDay_(from), endOfDay_(to)).forEach(ev => {
      const id = ev.getTag(TAG_ID);
      if (!id) return;
      if (existing[id]) { ev.deleteEvent(); result.removed++; return; }
      existing[id] = ev;
    });

    const seen = {};
    rows.forEach(row => {
      seen[row.id] = true;
      const e = eventFor_(row);
      const sig = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(e), Utilities.Charset.UTF_8));
      let ev = existing[row.id];
      if (ev && ev.getTag(TAG_SIG) === sig) { result.unchanged++; return; }
      if (ev) {
        ev.setTime(e.start, e.end);
        ev.setTitle(e.title);
        ev.setLocation(e.location);
        ev.setDescription(e.description);
        result.updated++;
      } else {
        ev = cal.createEvent(e.title, e.start, e.end, { location: e.location, description: e.description });
        ev.setTag(TAG_ID, row.id);
        result.created++;
      }
      if (e.color) ev.setColor(e.color);
      ev.setTag(TAG_SIG, sig);
    });

    Object.keys(existing).forEach(id => {
      if (!seen[id]) { existing[id].deleteEvent(); result.removed++; }
    });
    return result;
  } finally {
    lock.releaseLock();
  }
}

function fetchAppointments_(from, to) {
  const resp = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/rpc/calendar_export`, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    payload: JSON.stringify({ p_token: SYNC_KEY, p_from: from, p_to: to }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) throw new Error(`calendar_export ${resp.getResponseCode()}: ${resp.getContentText()}`);
  return JSON.parse(resp.getContentText()) || [];
}

// What the event should look like for one appointment.
function eventFor_(row) {
  const start = Utilities.parseDate(`${row.appointment_date} ${String(row.appointment_time).slice(0, 8)}`, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
  const end = new Date(start.getTime() + (Number(row.duration_minutes) || 60) * 60000);
  const name = [row.first_name, row.last_name].map(v => String(v || '').trim()).filter(Boolean).join(' ') || 'Paciente';
  const services = treatments_(row);
  const clinic = row.clinic_name || 'Piel Spa';
  const prefix = row.status === 'pending' ? '⏳ ' : '';
  return {
    title: `${prefix}${name}${services ? ' · ' + services : ''}${row.clinic_id === 'divine_bliss' ? ' (Divine Bliss)' : ''}`,
    start,
    end,
    location: row.clinic_address ? `${clinic}, ${row.clinic_address}` : clinic,
    description: [
      `Paciente: ${name}`,
      row.phone ? `Teléfono: ${row.phone}` : '',
      `Lugar: ${clinic}`,
      services ? `Tratamientos: ${services}` : '',
      `Estado: ${STATUS_ES[row.status] || row.status || ''}`,
      `Duración: ${Number(row.duration_minutes) || 60} min`,
      '',
      'Gestionar en piel-spa.com/admin.html (los cambios hechos aquí no se guardan).',
    ].filter(v => v !== null).join('\n'),
    color: CLINIC_COLORS[row.clinic_id] || null,
  };
}

function treatments_(row) {
  let ids = [];
  try { ids = JSON.parse(row.service_type_ids || '[]') || []; } catch (e) { ids = []; }
  const labels = (Array.isArray(ids) ? ids : []).map(id => TREATMENT_LABELS[id] || '').filter(Boolean);
  return labels.length ? labels.join(', ') : String(row.service_type || '').trim();
}

// ---------- Dates (New York) ----------

function isoDate_(d) { return Utilities.formatDate(d, TIME_ZONE, 'yyyy-MM-dd'); }
function startOfDay_(d) { return Utilities.parseDate(`${isoDate_(d)} 00:00:00`, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'); }
function endOfDay_(d) { return Utilities.parseDate(`${isoDate_(d)} 23:59:59`, TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'); }
