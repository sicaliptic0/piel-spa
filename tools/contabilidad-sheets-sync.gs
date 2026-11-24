/**
 * Piel Spa · Contabilidad → Google Sheets
 *
 * Paste this into the spreadsheet: Extensiones → Apps Script. Then, from the
 * "Piel Spa · Contabilidad" menu: Configurar clave (from the admin: Contabilidad →
 * Google Sheets), Activar actualización automática, Actualizar ahora.
 *
 * Every 10 minutes it rewrites these tabs from Supabase (read-only key, RPC
 * accounting_export): Panel <año> · Sistema (one per year), Gastos · Sistema, Ingresos · Sistema,
 * Socios · Sistema, Estado socios · Sistema, Gastos fijos · Sistema.
 * Tabs without "· Sistema" are never touched. One file serves every year: a new
 * year just adds its own Panel tab; the other tabs list all years (filter by Fecha).
 * On the 1st of each month it saves the previous month's close as a PDF in the
 * Drive folder "Piel Spa · Cierres mensuales".
 *
 * The Panel and partner math mirror admin-contabilidad.js (panelRows, socioMes).
 */

const SUPABASE_URL = 'https://qkjmrnqkoipdltauweub.supabase.co';
// Public anon key (the same one the website uses); the export also needs the private key below.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFram1ybnFrb2lwZGx0YXV3ZXViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTkyMjgsImV4cCI6MjA4OTA5NTIyOH0.EGqgJ9RNY9vYfuVeeEcGoMu_cIaygRq0hnyT-iE7zTw';
const KEY_PROPERTY = 'CONTABILIDAD_SYNC_KEY';
const TIME_ZONE = 'America/New_York';
const PDF_FOLDER = 'Piel Spa · Cierres mensuales';
const SOCIOS = ['Freddy', 'Samuel'];
const METODOS = { cash: 'Efectivo', transfer: 'Transferencia', zelle: 'Zelle', debit: 'Tarjeta de débito', credit: 'Tarjeta de crédito', cherry: 'Cherry', check: 'Cheque', other: 'Otro' };
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONEY = '$#,##0.00;($#,##0.00);"-"';
const GRUPOS = [['Costo de ventas', 'Costos variables (insumos y productos)'], ['Gasto operativo', 'Gastos fijos y operativos'],
  ['Activo', 'Equipo (activos)'], ['No deducible', 'No deducible'], ['No es gasto', 'No es gasto (depósitos)'], ['Revisar', 'Por revisar']];

// ---------- menu and triggers
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Piel Spa · Contabilidad')
    .addItem('Actualizar ahora', 'syncNow')
    .addSeparator()
    .addItem('Configurar clave', 'setKey')
    .addItem('Activar actualización automática', 'installTriggers')
    .addItem('Desactivar actualización automática', 'removeTriggers')
    .addSeparator()
    .addItem('Guardar cierre del mes pasado en PDF', 'savePreviousMonthPdf')
    .addItem('Guardar cierre de otro mes en PDF…', 'saveMonthPdfPrompt')
    .addToUi();
}
function setKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Clave de Contabilidad', 'Pégala desde el admin: Contabilidad → Google Sheets.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  PropertiesService.getScriptProperties().setProperty(KEY_PROPERTY, r.getResponseText().trim());
  ui.alert('Clave guardada. Ahora: Activar actualización automática y Actualizar ahora.');
}
function installTriggers() {
  removeTriggers(true);
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('savePreviousMonthPdf').timeBased().onMonthDay(1).atHour(7).inTimezone(TIME_ZONE).create();
  SpreadsheetApp.getActive().toast('Listo: se actualiza cada 10 minutos y guarda el PDF del mes el día 1.', 'Piel Spa', 6);
}
function removeTriggers(silent) {
  ScriptApp.getProjectTriggers().filter(t => ['syncNow', 'savePreviousMonthPdf'].includes(t.getHandlerFunction())).forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) SpreadsheetApp.getActive().toast('Actualización automática desactivada.', 'Piel Spa', 5);
}

// ---------- data
function fetchData() {
  const key = PropertiesService.getScriptProperties().getProperty(KEY_PROPERTY);
  if (!key) throw new Error('Falta la clave. Menú Piel Spa · Contabilidad → Configurar clave.');
  const res = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/rpc/accounting_export`, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    payload: JSON.stringify({ p_token: key }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Supabase respondió ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return prepare(JSON.parse(res.getContentText()));
}
function prepare(raw) {
  const s = raw.settings || {};
  const db = {
    share: { Freddy: Number(s.share_freddy || 0.5), Samuel: Number(s.share_samuel || 0.5) },
    categorias: raw.categories || [],
    gastos: (raw.expenses || []).map(e => ({ ...e, monto: Number(e.monto) })),
    movimientos: (raw.movements || []).map(m => ({ ...m, monto: Number(m.monto) })),
    ingresos: (raw.income || []).map(i => ({ ...i, metodo: METODOS[i.metodo] || i.metodo, monto: i.monto == null ? null : Number(i.monto),
      impuesto: Number(i.impuesto || 0), recargo: Number(i.recargo || 0), total: i.total == null ? null : Number(i.total) })),
    fijos: raw.recurring || [],
  };
  db.kind = {}; db.categorias.forEach(c => db.kind[c.name] = c.kind);
  return db;
}

// ---------- same math as the admin
const ym = d => String(d || '').slice(0, 7);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
function months(db) {
  const set = new Set();
  [...db.gastos, ...db.ingresos, ...db.movimientos].forEach(x => x.fecha && set.add(ym(x.fecha)));
  set.add(Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM'));
  const arr = [...set].sort(), out = [];
  let [y, m] = arr[0].split('-').map(Number); const [ly, lm] = arr[arr.length - 1].split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const share = (db, row, socio) => row === socio ? 1 : row === 'Ambos (50/50)' ? db.share[socio] : 0;
const reembolsable = g => g.libro === 'LLC' && ['Pendiente', 'Parcial', 'Reembolsado'].includes(g.estado) && g.pagado_por !== 'LLC';
function socioMes(db, socio, m) {
  const r = { aportes: 0, retiros: 0, gastos: 0, reembolsos: 0, prestamos: 0, pagosPrestamo: 0 };
  db.movimientos.filter(x => x.confirmado && ym(x.fecha) === m).forEach(x => {
    const v = x.monto * share(db, x.socio, socio); if (!v) return;
    if (x.tipo === 'Aporte de capital') r.aportes += v; else if (x.tipo === 'Retiro de capital') r.retiros += v;
    else if (x.tipo === 'Préstamo del socio') r.prestamos += v; else r.pagosPrestamo += v;
  });
  db.gastos.forEach(g => {
    const f = share(db, g.pagado_por, socio); if (!f || !reembolsable(g)) return;
    if (ym(g.fecha) === m) r.gastos += g.monto * f;
    if (ym(g.fecha_reembolso || g.fecha) === m) r.reembolsos += (g.estado === 'Reembolsado' ? g.monto : Number(g.monto_reembolsado || 0)) * f;
  });
  return r;
}
function socioAcumulado(db, socio, hasta, ms) {
  const acc = { capital: 0, debe: 0, prestamo: 0 };
  ms.filter(m => m <= hasta).forEach(m => { const r = socioMes(db, socio, m);
    acc.capital += r.aportes - r.retiros; acc.debe += r.gastos - r.reembolsos; acc.prestamo += r.prestamos - r.pagosPrestamo; });
  return acc;
}
function panelRows(db, ms, allMonths) {
  const rows = [], z = () => Object.fromEntries(ms.map(m => [m, 0]));
  const add = (label, fn, extra) => { const v = z(); ms.forEach(m => v[m] = r2(fn(m))); rows.push({ t: 'r', label, v, ...(extra || {}) }); return v; };
  const ingLLC = m => db.ingresos.filter(i => !i.anulado && i.libro === 'LLC' && ym(i.fecha) === m);
  const mov = (tipo, m) => db.movimientos.filter(x => x.confirmado && x.tipo === tipo && ym(x.fecha) === m).reduce((s, x) => s + x.monto, 0);
  const gas = (cat, m) => db.gastos.filter(g => g.libro === 'LLC' && g.categoria === cat && ym(g.fecha) === m).reduce((s, g) => s + g.monto, 0);
  const sum = (...vs) => { const v = z(); ms.forEach(m => v[m] = r2(vs.reduce((s, x) => s + (x.sign || 1) * x.v[m], 0))); return v; };
  rows.push({ t: 'h', label: 'A · Entradas' });
  const ap = add('Aportes de capital (socios)', m => mov('Aporte de capital', m));
  const pr = add('Préstamos de socios', m => mov('Préstamo del socio', m));
  const ve = add('Ventas de servicios y productos', m => ingLLC(m).filter(i => i.categoria !== 'Otro ingreso').reduce((s, i) => s + (i.monto || 0), 0));
  const re = add('Recargos de tarjeta', m => ingLLC(m).reduce((s, i) => s + (i.recargo || 0), 0));
  const ot = add('Otros ingresos (bono, etc.)', m => ingLLC(m).filter(i => i.categoria === 'Otro ingreso').reduce((s, i) => s + (i.monto || 0), 0));
  const totE = sum({ v: ap }, { v: pr }, { v: ve }, { v: re }, { v: ot }); rows.push({ t: 'tot', label: 'Total entradas', v: totE });
  rows.push({ t: 'h', label: 'B · Salidas' });
  const grupoV = {};
  GRUPOS.forEach(([kind, titulo]) => {
    const cats = db.categorias.filter(c => c.kind === kind);
    if (!cats.length) return;
    rows.push({ t: 'sub', label: titulo });
    grupoV[kind] = sum(...cats.map(c => ({ v: add(c.name, m => gas(c.name, m)) })));
  });
  const totS = sum(...Object.values(grupoV).map(v => ({ v }))); rows.push({ t: 'tot', label: 'Total gastos', v: totS });
  const ret = add('Retiros de capital (socios)', m => mov('Retiro de capital', m));
  const pp = add('Pagos de préstamos a socios', m => mov('Pago de préstamo al socio', m));
  rows.push({ t: 'tot', label: 'Balance del mes (entradas − salidas)', v: sum({ v: totE }, { v: totS, sign: -1 }, { v: ret, sign: -1 }, { v: pp, sign: -1 }) });
  rows.push({ t: 'h', label: 'C · Resultado y K-1' });
  const res = sum({ v: ve }, { v: re }, { v: ot }, { v: grupoV['Costo de ventas'] || z(), sign: -1 }, { v: grupoV['Gasto operativo'] || z(), sign: -1 });
  rows.push({ t: 'tot', label: 'Resultado (ventas − costos − gastos operativos)', v: res });
  SOCIOS.forEach(s => { const v = z(); ms.forEach(m => v[m] = r2(res[m] * db.share[s])); rows.push({ t: 'r', label: `${s} · ${db.share[s] * 100}%`, v }); });
  rows.push({ t: 'h', label: 'D · Socios (saldo al cierre del mes)' });
  SOCIOS.forEach(s => add(`La LLC le debe a ${s}`, m => socioAcumulado(db, s, m, allMonths).debe, { acum: true }));
  SOCIOS.forEach(s => add(`Capital de ${s}`, m => socioAcumulado(db, s, m, allMonths).capital, { acum: true }));
  add('Impuesto cobrado (se paga al estado)', m => ingLLC(m).reduce((s, i) => s + (i.impuesto || 0), 0));
  return rows;
}

// ---------- writing
function syncNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const db = fetchData(), ms = months(db), stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm');
    writePanel(db, ms, stamp);
    writeTable('Gastos · Sistema', ['Fecha', 'Descripción', 'Proveedor', 'Categoría', 'Tipo', 'Libro', 'Monto', 'Cuenta / tarjeta', 'Titular del pago', 'Estado reembolso', 'Fecha reembolso', 'Origen', 'Recibo', 'Gasto fijo', 'Nota', 'Método de pago', 'Pagado desde', 'Reembolsado desde', 'Origen de fondos', 'Monto reembolsado'],
      db.gastos.slice().reverse().map(g => [d(g.fecha), g.descripcion, g.proveedor || '', g.categoria, db.kind[g.categoria] || '', g.libro, g.monto, g.cuenta || '', g.pagado_por, g.estado, d(g.fecha_reembolso), g.origen, g.recibo ? 'Sí' : '', g.fijo ? 'Sí' : '', g.nota || '', g.metodo_pago || '', [g.metodo_pago, g.cuenta, g.pagado_por].filter(Boolean).join(' · '), g.reembolsado_desde || '', g.origen_fondos || '', g.estado === 'Reembolsado' ? g.monto : g.monto_reembolsado ?? '']),
      { money: [7, 20], dates: [1, 11], redWhen: { col: 10, value: 'Pendiente' } }, stamp);
    writeTable('Ingresos · Sistema', ['Fecha', 'Cliente', 'Servicio', 'Categoría', 'Método', 'Venta', 'Descuento', 'Impuesto', 'Recargo', 'Total cobrado', 'Libro', 'Origen', 'Nota', 'Código Servicio', 'ID cobro'],
      db.ingresos.slice().reverse().map(i => [d(i.fecha), i.cliente, i.servicio || '', i.categoria || '', i.metodo || '', i.monto == null ? '' : i.monto, Number(i.descuento || 0), i.impuesto, i.recargo, i.total == null ? '' : i.total, i.anulado ? 'Anulado' : i.libro, i.origen, i.nota || '', i.codigo_servicio || '', i.cobro_id || '']),
      { money: [6, 7, 8, 9, 10], dates: [1] }, stamp);
    writeServiceDetails(db.ingresos, stamp);
    writeTable('Socios · Sistema', ['Fecha', 'Socio', 'Tipo', 'Monto', 'Concepto', 'Confirmado', 'Nota'],
      db.movimientos.slice().reverse().map(m => [d(m.fecha), m.socio, m.tipo, m.monto, m.concepto, m.confirmado ? 'Sí' : 'No', m.nota || '']),
      { money: [4], dates: [1] }, stamp);
    const est = [];
    SOCIOS.forEach(s => { let cap = 0, debe = 0, pres = 0; ms.forEach(m => { const r = socioMes(db, s, m);
      cap += r.aportes - r.retiros; debe += r.gastos - r.reembolsos; pres += r.prestamos - r.pagosPrestamo;
      est.push([s, mesLabel(m), r2(r.aportes), r2(r.retiros), r2(cap), r2(r.gastos), r2(r.reembolsos), r2(debe), r2(pres)]); }); });
    writeTable('Estado socios · Sistema', ['Socio', 'Mes', 'Aportes', 'Retiros', 'Capital acumulado', 'Gastos que pagó', 'Reembolsos recibidos', 'La LLC le debe', 'Saldo préstamos'],
      est, { money: [3, 4, 5, 6, 7, 8, 9], text: [2] }, stamp);
    writeTable('Gastos fijos · Sistema', ['Descripción', 'Proveedor', 'Categoría', 'Monto al mes', 'Día', 'Lo paga', 'Cuenta', 'Desde', 'Hasta', 'Activo'],
      db.fijos.map(f => [f.descripcion, f.proveedor || '', f.categoria, Number(f.monto), f.dia, f.pagado_por, f.cuenta || '', d(f.desde), d(f.hasta), f.activo ? 'Sí' : 'No']),
      { money: [4], dates: [8, 9] }, stamp);
  } finally { lock.releaseLock(); }
}
function d(iso) { if (!iso) return ''; const [y, m, dd] = String(iso).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, dd); }
function mesLabel(m) { const [y, mo] = m.split('-'); return `${MESES[Number(mo) - 1]} ${y}`; }
function sheetFor(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function writeServiceDetails(income, stamp) {
  const details = income.slice().reverse().flatMap(i => (i.detalle_servicios || []).map(line => [
    d(i.fecha), i.cobro_id || '', line.billing_code || '', line.name || '', line.category || '', line.quantity, line.unit || '',
    Number(line.unit_price), Number(line.amount), Number(line.discount || 0),
    r2(Number(line.amount) - Number(line.discount || 0)), i.anulado ? 'Anulado' : i.libro
  ]));
  writeTable('Detalle servicios · Sistema', ['Fecha', 'ID cobro', 'Código Servicio', 'Servicio', 'Categoría', 'Cantidad', 'Unidad', 'Precio unitario', 'Bruto', 'Descuento', 'Neto antes de impuestos', 'Libro'], details,
    { money: [8, 9, 10, 11], dates: [1] }, stamp);
}

function writeTable(name, header, rows, fmt, stamp) {
  const sh = sheetFor(name);
  sh.clear();
  sh.getRange(1, 1).setValue(`Actualizado ${stamp} desde el admin. No escribas aquí: esta pestaña se reescribe sola.`).setFontStyle('italic').setFontColor('#8A7F8F');
  sh.getRange(2, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#2A2330').setFontColor('#FFFFFF');
  if (rows.length) {
    sh.getRange(3, 1, rows.length, header.length).setValues(rows);
    (fmt.money || []).forEach(c => sh.getRange(3, c, rows.length, 1).setNumberFormat(MONEY));
    (fmt.dates || []).forEach(c => sh.getRange(3, c, rows.length, 1).setNumberFormat('yyyy-mm-dd'));
  }
  sh.setFrozenRows(2);
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(2, 1, Math.max(rows.length, 1) + 1, header.length).createFilter();
  // Only the "Pendiente" cell of the reimbursement status turns red (a rule, so it follows the filter and sorting).
  sh.clearConditionalFormatRules();
  if (fmt.redWhen && rows.length) {
    sh.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(fmt.redWhen.value).setBackground('#F8D4D4').setFontColor('#7A1F1F')
      .setRanges([sh.getRange(3, fmt.redWhen.col, rows.length, 1)]).build()]);
  }
  fitColumns(sh, header, rows, fmt);
}

// Column widths from the content: short columns fit, long text gets a capped width and wraps,
// so every tab reads on a computer and on the phone app without endless sideways scrolling.
const COL_MIN = 64, COL_MAX = 260, CHAR_PX = 7.2, PAD_PX = 18;
function fitColumns(sh, header, rows, fmt) {
  header.forEach((h, k) => {
    const c = k + 1;
    const lens = rows.map(r => String(r[k] == null ? '' : r[k]).length);
    let px;
    if ((fmt.dates || []).includes(c)) px = 92;
    else if ((fmt.money || []).includes(c)) px = Math.max(96, String(h).length * CHAR_PX + PAD_PX);
    else {
      const sorted = lens.slice().sort((a, b) => a - b);
      const typical = sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : 0;   // 90th percentile: one long note does not widen the column
      px = Math.max(String(h).length * CHAR_PX + PAD_PX, typical * CHAR_PX + PAD_PX);
    }
    px = Math.round(Math.min(COL_MAX, Math.max(COL_MIN, px)));
    sh.setColumnWidth(c, px);
    const longest = lens.reduce((m, n) => Math.max(m, n), 0);
    if (rows.length) sh.getRange(3, c, rows.length, 1).setWrap(longest * CHAR_PX + PAD_PX > px);
  });
  sh.getRange(2, 1, 1, header.length).setWrap(true).setVerticalAlignment('middle');
  if (rows.length) sh.getRange(3, 1, rows.length, header.length).setVerticalAlignment('top');
  sh.getRange(1, 1).setWrap(false);   // the "Actualizado…" line runs across; it does not widen column A
}
function writePanel(db, ms, stamp) {
  const ss = SpreadsheetApp.getActive(), old = ss.getSheetByName('Panel · Sistema');   // first version had one tab
  if (old) ss.deleteSheet(old);
  [...new Set(ms.map(m => m.slice(0, 4)))].forEach(year => writePanelYear(db, ms, year, stamp));
}
function writePanelYear(db, ms, year, stamp) {
  const cols = ms.filter(m => m.startsWith(year));
  const rows = panelRows(db, cols, ms);
  const sh = sheetFor(`Panel ${year} · Sistema`);
  sh.clear();
  const width = cols.length + 2;
  sh.getRange(1, 1).setValue(`Panel ${year} · actualizado ${stamp}. No escribas aquí: esta pestaña se reescribe sola.`).setFontStyle('italic').setFontColor('#8A7F8F');
  sh.getRange(2, 1, 1, width).setValues([['Concepto', ...cols.map(mesLabel), 'Total']]).setFontWeight('bold').setBackground('#2A2330').setFontColor('#FFFFFF');
  const data = rows.map(r => r.t === 'h' || r.t === 'sub' ? [r.label, ...cols.map(() => ''), '']
    : [r.label, ...cols.map(m => r.v[m]), r.acum ? r.v[cols[cols.length - 1]] : r2(cols.reduce((s, m) => s + r.v[m], 0))]);
  sh.getRange(3, 1, data.length, width).setValues(data);
  sh.getRange(3, 2, data.length, width - 1).setNumberFormat(MONEY);
  rows.forEach((r, k) => {
    const rg = sh.getRange(3 + k, 1, 1, width);
    if (r.t === 'h') rg.setFontWeight('bold').setFontColor('#B76E88').setBackground('#FFFFFF');
    else if (r.t === 'sub') rg.setFontStyle('italic').setBackground('#FDFBFC');
    else if (r.t === 'tot') rg.setFontWeight('bold').setBackground('#FBF0F3');
  });
  sh.setFrozenRows(2); sh.setFrozenColumns(1);
  sh.setColumnWidth(1, 250);
  sh.getRange(3, 1, data.length, 1).setWrap(true).setVerticalAlignment('top');
  for (let c = 2; c <= width; c++) sh.setColumnWidth(c, 92);
  sh.getRange(1, 1).setWrap(false);
}

// ---------- monthly close as PDF in Drive
function savePreviousMonthPdf() {
  const now = new Date(), y = Number(Utilities.formatDate(now, TIME_ZONE, 'yyyy')), m = Number(Utilities.formatDate(now, TIME_ZONE, 'M'));
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  saveMonthPdf(prev);
}
function saveMonthPdfPrompt() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Cierre en PDF', 'Mes (AAAA-MM), por ejemplo 2026-10:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const mes = r.getResponseText().trim();
  if (!/^\d{4}-\d{2}$/.test(mes)) { ui.alert('Escribe el mes como AAAA-MM.'); return; }
  saveMonthPdf(mes);
}
function saveMonthPdf(mes) {
  const db = fetchData(), ms = months(db);
  const rows = panelRows(db, [mes], ms);
  const sh = sheetFor('Cierre · Sistema');
  sh.clear();
  const out = [[`Piel Spa LLC · Cierre de ${mesLabel(mes)}`, ''], [`Generado ${Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd')}`, ''], ['', '']];
  rows.filter(r => r.t === 'h' || r.t === 'tot' || (r.t === 'r' && r.v[mes])).forEach(r => out.push([r.label, r.t === 'h' ? '' : r.v[mes]]));
  out.push(['', ''], ['Gastos del mes', '']);
  db.gastos.filter(g => g.libro === 'LLC' && ym(g.fecha) === mes).sort((a, b) => a.categoria.localeCompare(b.categoria))
    .forEach(g => out.push([`${String(g.fecha).slice(8, 10)} · ${g.categoria} · ${g.descripcion} (${g.pagado_por})`, g.monto]));
  out.push(['', ''], ['Ingresos del mes', '']);
  db.ingresos.filter(i => !i.anulado && ym(i.fecha) === mes)
    .forEach(i => out.push([`${String(i.fecha).slice(8, 10)} · ${i.cliente} · ${i.servicio || ''} (${i.metodo || ''})${i.libro === 'LLC' ? '' : ' · NJ fuera'}`, i.monto == null ? '' : i.monto]));
  out.push(['', ''], ['Firma Freddy: ____________________', ''], ['Firma Samuel: ____________________', '']);
  sh.getRange(1, 1, out.length, 2).setValues(out);
  sh.getRange(1, 2, out.length, 1).setNumberFormat(MONEY);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sh.setColumnWidth(1, 420); sh.setColumnWidth(2, 110);
  sh.getRange(4, 1, out.length - 3, 1).setWrap(true).setVerticalAlignment('top');
  SpreadsheetApp.flush();

  const ss = SpreadsheetApp.getActive();
  const url = `https://docs.google.com/spreadsheets/d/${ss.getId()}/export?format=pdf&gid=${sh.getSheetId()}&portrait=true&size=letter&fitw=true&gridlines=false&printtitle=false&sheetnames=false`;
  const pdf = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(`Cierre ${mes} - Piel Spa.pdf`);
  const folders = DriveApp.getFoldersByName(PDF_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PDF_FOLDER);
  const old = folder.getFilesByName(pdf.getName());
  while (old.hasNext()) old.next().setTrashed(true);   // one PDF per month: the newest replaces the old one
  folder.createFile(pdf);
  ss.toast(`PDF guardado en Drive: ${PDF_FOLDER} / ${pdf.getName()}`, 'Piel Spa', 8);
}
