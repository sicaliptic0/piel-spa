// Contabilidad (admin-only). Loaded by admin.html after its main script, so it uses
// _supabase, clinicDateIso and the admin's sign-in. Data lives in Supabase:
//   acct_expenses, acct_partner_movements, acct_income, acct_categories, acct_settings
//   payments (Cobros) for client income.
// Everything renders inside #accounting-view; handlers are exposed on window.Acc.
(function () {
    'use strict';
    const SOCIOS = ['Freddy', 'Samuel'];
    const ESTADOS = ['Pendiente', 'Reembolsado', 'Aportado como capital', 'No aplica (pagó la LLC)', 'Sin dato'];
    const PAGADORES = ['LLC', 'Freddy', 'Samuel', 'Ambos (50/50)', 'Otra persona', 'Sin dato'];
    const LIBROS = ['LLC', 'NJ (fuera de la LLC)', 'Revisar'];
    const CUENTAS = ['Chase Ink Business', 'Amex Business', 'Débito Chase Business', 'Cuenta LLC (Zelle/cheque)', 'Tarjeta Chase', 'BofA Mastercard',
        'BofA Travel', 'Visa (sin identificar)', 'Tarjeta personal', 'Zelle / transferencia personal', 'Efectivo', 'Cheque', 'Sin dato'];
    const PAY_LABEL = { cash: 'Efectivo', transfer: 'Transferencia', zelle: 'Zelle', debit: 'Tarjeta de débito', credit: 'Tarjeta de crédito', cherry: 'Cherry', check: 'Cheque', other: 'Otro' };
    const VIEWS = [['panel', 'Panel'], ['resumen', 'Resumen'], ['gastos', 'Gastos'], ['fijos', 'Gastos fijos'], ['socios', 'Socios'], ['estado', 'Estado de cuenta'], ['ingresos', 'Ingresos'],
        ['impuestos', 'Impuestos'], ['conciliacion', 'Conciliación'], ['reportes', 'Reportes']];

    // ---------- state
    let db = null, view = 'resumen', built = false, loading = null;
    const sel = new Set();
    const sortState = { resumen: { k: 'mes', d: 1 }, gastos: { k: 'fecha', d: -1 }, mov: { k: 'fecha', d: -1 }, ing: { k: 'fecha', d: -1 }, imp: { k: 'inicio', d: -1 } };
    let conc = null;

    // ---------- helpers
    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const money = n => (n < 0 ? '(' : '') + '$' + Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (n < 0 ? ')' : '');
    const cell = n => `<td class="num ${n < -0.004 ? 'neg' : ''}">${Math.abs(n || 0) < 0.005 ? '<span class="opacity-30">–</span>' : money(n)}</td>`;
    const today = () => (typeof clinicDateIso === 'function' ? clinicDateIso(0) : new Date().toISOString().slice(0, 10));
    const amt = s => { const n = parseFloat(String(s ?? '').replace(/[$,\s]/g, '')); return isNaN(n) ? null : r2(n); };
    const fdate = d => d ? d.split('-').reverse().join('/') : '';
    const ym = d => (d || '').slice(0, 7);
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mesLabel = m => { const [y, mo] = m.split('-'); return MESES[+mo - 1].slice(0, 3) + ' ' + y; };
    const mesLargo = m => { const [y, mo] = m.split('-'); return MESES[+mo - 1] + ' de ' + y; };
    const share = (row, socio) => row === socio ? 1 : row === 'Ambos (50/50)' ? (socio === 'Freddy' ? db.cfg.share_freddy : db.cfg.share_samuel) : 0;
    const SHARE = s => s === 'Freddy' ? Number(db.cfg.share_freddy) : Number(db.cfg.share_samuel);
    const catTipo = c => (db.categorias.find(x => x.name === c) || {}).kind || 'Revisar';
    const reembolsable = g => g.libro === 'LLC' && (g.estado === 'Pendiente' || g.estado === 'Reembolsado') && g.pagado_por !== 'LLC';
    const isCard = m => m === 'Tarjeta de crédito' || m === 'Tarjeta de débito';
    function toast(msg) {
        let t = $('acc-toast');
        if (!t) { t = document.createElement('div'); t.id = 'acc-toast'; t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#2A2330] text-white text-sm px-4 py-2 rounded-full z-[90] pointer-events-none'; t.style.transition = 'opacity .3s'; document.body.appendChild(t); }
        t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 2600);
    }
    const userId = async () => (await _supabase.auth.getUser()).data.user?.id || null;
    // Cards/accounts come from acct_accounts; "Otra…" adds one there so it stays in the list.
    function fillCuentas(el, value) {
        const list = (db && db.cuentas && db.cuentas.length) ? db.cuentas.slice() : CUENTAS.slice();
        if (value && !list.includes(value)) list.push(value);
        el.innerHTML = list.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') + '<option value="__otra">Otra…</option>';
        el.value = value || list[0];
        el.dataset.prev = el.value;
        el.onchange = async () => {
            if (el.value !== '__otra') { el.dataset.prev = el.value; return; }
            const name = (prompt('Nombre de la tarjeta o cuenta (ej. "Amex Platinum Samuel"):') || '').trim().slice(0, 60);
            if (!name) { el.value = el.dataset.prev; return; }
            const { error } = await _supabase.from('acct_accounts').insert({ name, created_by: await userId() });
            if (error && error.code !== '23505') { alert('No se pudo agregar: ' + error.message); el.value = el.dataset.prev; return; }
            if (!db.cuentas.includes(name)) db.cuentas.push(name);
            fillCuentas(el, name);
            toast(`"${name}" quedó guardada en la lista.`);
        };
    }
    function fill(el, opts, first) { el.innerHTML = (first ? `<option value="">${first}</option>` : '') + opts.map(o => `<option value="${esc(o.v ?? o)}">${esc(o.t ?? o)}</option>`).join(''); }

    // ---------- data
    async function load() {
        const q = (p) => p.then(r => { if (r.error) throw r.error; return r.data || []; });
        const [cfg, cats, exp, mov, inc, pay, fijos, cuentas] = await Promise.all([
            q(_supabase.from('acct_settings').select('*').eq('id', 1)),
            q(_supabase.from('acct_categories').select('*').order('sort')),
            q(_supabase.from('acct_expenses').select('*').is('deleted_at', null).order('spent_on', { ascending: false }).limit(5000)),
            q(_supabase.from('acct_partner_movements').select('*').is('deleted_at', null)),
            q(_supabase.from('acct_income').select('*').is('deleted_at', null)),
            q(_supabase.from('payments').select('*').limit(5000)),
            q(_supabase.from('acct_recurring').select('*').order('description')),
            q(_supabase.from('acct_accounts').select('name').order('sort').order('name')).catch(() => []),
        ]);
        db = {
            cfg: cfg[0] || { share_freddy: 0.5, share_samuel: 0.5, loan_rate: 0 },
            categorias: cats,
            fijos,
            cuentas: cuentas.map(c => c.name),
            gastos: exp.map(e => ({ id: e.id, fecha: e.spent_on, descripcion: e.description, proveedor: e.vendor || '', categoria: e.category, libro: e.ledger,
                monto: Number(e.amount), cuenta: e.account || '', pagado_por: e.paid_by, estado: e.reimb_status, fecha_reembolso: e.reimbursed_on, nota: e.note || '',
                receipt: e.receipt_path, source: e.source })),
            movimientos: mov.map(m => ({ id: m.id, fecha: m.moved_on, socio: m.partner, tipo: m.kind, monto: Number(m.amount), concepto: m.concept,
                confirmado: m.confirmed, nota: (m.note || '').replace(' [libro]', '').replace('[libro]', '') })),
            ingresos: [
                ...inc.map(i => ({ id: 'inc:' + i.id, tabla: 'acct_income', fecha: i.received_on, cliente: i.client, servicio: i.service || '', categoria: i.category || '',
                    metodo: i.method || '', monto: i.amount == null ? null : Number(i.amount), impuesto: 0, recargo: 0, total: i.amount == null ? null : Number(i.amount),
                    libro: i.ledger, nota: i.note || '', anulado: false })),
                ...pay.map(p => {
                    const servBase = r2(Number(p.amount) - Number(p.discount || 0)), prod = Number(p.product_amount || 0);
                    return { id: 'pay:' + p.id, tabla: 'payments', pid: p.id, fecha: p.paid_on, cliente: p.patient_name,
                        servicio: [p.category, p.product_desc].filter(Boolean).join(' + ') || 'Cobro', categoria: p.category || 'Sin categoría',
                        metodo: PAY_LABEL[p.method] || p.method, monto: r2(servBase + prod), baseServ: servBase, baseProd: prod,
                        taxServ: Number(p.service_tax || 0) || (prod ? 0 : Number(p.tax || 0)), taxProd: Number(p.product_tax || 0), impuesto: Number(p.tax || 0),
                        recargo: Number(p.surcharge || 0), total: Number(p.total), comision: Number(p.processor_fee || 0), libro: p.ledger || 'LLC',
                        nota: p.notes || '', anulado: !!p.voided_at, conciliado: !!p.reconciled_at };
                }),
            ],
        };
    }
    async function refresh() { await load(); render(); }

    // ---------- calculations
    function months() {
        const set = new Set();
        [...db.gastos, ...db.ingresos, ...db.movimientos].forEach(x => x.fecha && set.add(ym(x.fecha)));
        set.add(today().slice(0, 7));
        const arr = [...set].sort(), out = [];
        let [y, m] = arr[0].split('-').map(Number); const [ly, lm] = arr[arr.length - 1].split('-').map(Number);
        while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
        return out;
    }
    function socioMes(socio, m) {
        const r = { aportes: 0, retiros: 0, gastos: 0, reembolsos: 0, prestamos: 0, pagosPrestamo: 0, listaGastos: [], listaReemb: [], listaMov: [] };
        db.movimientos.filter(x => x.confirmado && ym(x.fecha) === m).forEach(x => {
            const f = share(x.socio, socio); if (!f) return;
            const v = x.monto * f; r.listaMov.push({ ...x, parte: v });
            if (x.tipo === 'Aporte de capital') r.aportes += v; else if (x.tipo === 'Retiro de capital') r.retiros += v;
            else if (x.tipo === 'Préstamo del socio') r.prestamos += v; else r.pagosPrestamo += v;
        });
        db.gastos.forEach(g => {
            const f = share(g.pagado_por, socio); if (!f || !reembolsable(g)) return;
            if (ym(g.fecha) === m) { r.gastos += g.monto * f; r.listaGastos.push({ ...g, parte: g.monto * f }); }
            if (g.estado === 'Reembolsado' && ym(g.fecha_reembolso || g.fecha) === m) { r.reembolsos += g.monto * f; r.listaReemb.push({ ...g, parte: g.monto * f }); }
        });
        return r;
    }
    function socioAcumulado(socio, hasta) {
        const acc = { capital: 0, debe: 0, prestamo: 0 };
        months().filter(m => m <= hasta).forEach(m => { const r = socioMes(socio, m);
            acc.capital += r.aportes - r.retiros; acc.debe += r.gastos - r.reembolsos; acc.prestamo += r.prestamos - r.pagosPrestamo; });
        return acc;
    }
    function llcMes(m) {
        const r = { mes: m, serv: 0, otros: 0, cv: 0, op: 0, act: 0, nod: 0, rev: 0 };
        db.ingresos.filter(i => !i.anulado && i.libro === 'LLC' && ym(i.fecha) === m).forEach(i => {
            if (i.categoria === 'Otro ingreso') r.otros += i.monto || 0; else r.serv += i.monto || 0;
            r.otros += i.recargo || 0;
        });
        db.gastos.filter(g => g.libro === 'LLC' && ym(g.fecha) === m).forEach(g => {
            const t = catTipo(g.categoria), v = g.monto || 0;
            if (t === 'Costo de ventas') r.cv += v; else if (t === 'Gasto operativo') r.op += v; else if (t === 'Activo') r.act += v;
            else if (t === 'No deducible' || t === 'No es gasto') r.nod += v; else r.rev += v;
        });
        r.res = r.serv + r.otros - r.cv - r.op;
        return r;
    }

    // ---------- sorting
    function sortBy(t, k) { const s = sortState[t]; if (s.k === k) s.d = -s.d; else { s.k = k; s.d = (k === 'fecha' || k === 'mes' || k === 'inicio') ? -1 : 1; } render(); }
    function th(t, k, label, cls = '') {
        const s = sortState[t], on = s.k === k;
        return `<th class="sortable ${on ? 'sorted' : ''} ${cls}" onclick="Acc.sortBy('${t}','${k}')" title="Ordenar">${label}<span class="arr">${on ? (s.d > 0 ? '▲' : '▼') : '↕'}</span></th>`;
    }
    function sortList(t, list) {
        const { k, d } = sortState[t];
        return list.slice().sort((a, b) => {
            const x = a[k], y = b[k], ex = x == null || x === '', ey = y == null || y === '';
            if (ex || ey) return ex && ey ? 0 : ex ? 1 : -1;
            if (typeof x === 'number' && typeof y === 'number') return (x - y) * d;
            if (typeof x === 'boolean') return (x === y ? 0 : x ? -1 : 1) * d;
            return String(x).localeCompare(String(y), 'es', { numeric: true, sensitivity: 'base' }) * d;
        });
    }

    // ---------- shell
    const CSS = `
      .acc .card { background:#fff; border:1px solid #EDE1E7; border-radius:14px; box-shadow:0 1px 2px rgba(42,35,48,.04); }
      .acc .lbl { font-size:9px; text-transform:uppercase; letter-spacing:.1em; font-weight:700; color:#B76E88; }
      .acc .sub { padding:7px 14px; font-size:10px; text-transform:uppercase; letter-spacing:.12em; border-radius:99px; border:1px solid #EDE1E7; background:#fff; white-space:nowrap; }
      .acc .sub.on { background:#2A2330; color:#fff; border-color:#2A2330; font-weight:700; }
      .acc .abtn { background:#2A2330; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.12em; font-weight:700; padding:9px 18px; border-radius:99px; }
      .acc .abtn:hover { background:#1D1822; } .acc .abtn.rose { background:#B76E88; } .acc .abtn.rose:hover { background:#9C5570; }
      .acc .soft { border:1px solid #EDE1E7; background:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.1em; font-weight:600; padding:8px 14px; border-radius:99px; }
      .acc .soft:hover { border-color:#B76E88; color:#B76E88; }
      .acc .badge { font-size:9px; padding:2px 8px; border-radius:99px; text-transform:uppercase; font-weight:700; white-space:nowrap; }
      .acc .b-pend { background:#FEF3C7; color:#92400E; } .acc .b-ok { background:#D1FAE5; color:#065F46; } .acc .b-cap { background:#E0E7FF; color:#3730A3; }
      .acc .b-llc { background:#EDE1E7; color:#2A2330; } .acc .b-sd { background:#FEE2E2; color:#991B1B; } .acc .b-nj { background:#E0F0EA; color:#065F46; }
      .acc table.t { width:100%; font-size:13px; border-collapse:collapse; }
      .acc table.t th { text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.1em; color:#8A7F8F; font-weight:700; padding:8px 10px; border-bottom:1px solid #EDE1E7; background:#FDFBFC; position:sticky; top:0; z-index:1; white-space:nowrap; }
      .acc table.t th.sortable { cursor:pointer; user-select:none; } .acc table.t th.sortable:hover, .acc table.t th.sorted { color:#B76E88; }
      .acc table.t th .arr { display:inline-block; width:10px; margin-left:3px; opacity:.35; } .acc table.t th.sorted .arr { opacity:1; }
      .acc table.t td { padding:8px 10px; border-bottom:1px solid #F4EDF1; vertical-align:top; }
      .acc table.t tbody tr:hover td { background:#FDF7FA; }
      .acc .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; } .acc th.num { text-align:right; } .acc .neg { color:#9B2C2C; }
      .acc .stmt-line { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-bottom:1px dashed #EDE1E7; font-size:14px; }
      .acc .stmt-line.total { border-bottom:none; border-top:2px solid #2A2330; font-weight:700; padding-top:8px; }
      dialog.acc { border:none; border-radius:16px; padding:0; width:min(560px, calc(100vw - 32px)); }
      dialog.acc::backdrop { background:rgba(42,35,48,.35); }
      .acc .gcard { background:#fff; border:1px solid #EDE1E7; border-radius:12px; padding:12px; display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
      /* Only the "Pendiente" status is red, same as the Google Sheet */
      .acc .badge.b-pendr { background:#F8D4D4; color:#7A1F1F; }
      .acc .gcard:active { background:#FBF0F3; }
      .acc .fab { position:fixed; right:16px; bottom:calc(16px + env(safe-area-inset-bottom)); z-index:40; width:56px; height:56px; border-radius:99px; background:#B76E88; color:#fff; font-size:30px; line-height:56px; text-align:center; box-shadow:0 6px 16px rgba(42,35,48,.25); }
      .acc .bulkbar { position:fixed; left:0; right:0; bottom:0; z-index:41; background:#2A2330; color:#fff; padding:10px 12px calc(10px + env(safe-area-inset-bottom)); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .acc .bulkbar .soft { background:transparent; color:#fff; border-color:rgba(255,255,255,.35); }
      @media (max-width: 767px) {
        .acc input, .acc select, .acc textarea { font-size:16px !important; }   /* iOS zooms in on smaller text */
        dialog.acc { width:100vw; max-width:100vw; height:100dvh; max-height:100dvh; margin:0; border-radius:0; }
        dialog.acc .dlg-actions { position:sticky; bottom:0; background:#fff; padding:12px 0 calc(12px + env(safe-area-inset-bottom)); border-top:1px solid #EDE1E7; }
      }
      @media print { body.acc-printing * { visibility:hidden !important; } body.acc-printing .acc-print, body.acc-printing .acc-print * { visibility:visible !important; }
        body.acc-printing .acc-print { position:absolute; left:0; top:0; width:100%; border:none; box-shadow:none; } body.acc-printing { height:auto !important; overflow:visible !important; }
        body.acc-printing .acc-print table.t th { position:static; } .acc-nobreak { break-inside:avoid; } }`;
    function build() {
        if (built) return; built = true;
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
        const root = $('accounting-view'); root.classList.add('acc');
        root.innerHTML = `<div class="max-w-6xl mx-auto">
          <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
            <div class="flex gap-2 overflow-x-auto pb-1" id="acc-tabs">${VIEWS.map(([v, t]) => `<button class="sub" data-v="${v}">${t}</button>`).join('')}</div>
            <div class="flex gap-2 flex-wrap"><button class="soft" onclick="Acc.openSheets()">Google Sheets</button><button class="soft" onclick="Acc.openIphone()">iPhone</button><button class="abtn" onclick="Acc.openMov()">+ Aporte de socio</button><button class="abtn rose hidden md:inline-block" onclick="Acc.openGasto()">+ Nuevo gasto</button></div>
          </div>
          <div id="acc-body" class="pb-20 md:pb-0"><p class="text-sm opacity-50 text-center py-10">Cargando…</p></div>
          <button class="fab md:hidden" onclick="Acc.openGasto()" aria-label="Nuevo gasto">+</button></div>`;
        root.querySelectorAll('#acc-tabs .sub').forEach(b => b.onclick = () => { view = b.dataset.v; try { localStorage.setItem('acc-view', view); } catch (e) {} render(); });
        try { view = localStorage.getItem('acc-view') || 'panel'; } catch (e) {}
        if (!VIEWS.some(v => v[0] === view)) view = 'panel';
        document.body.insertAdjacentHTML('beforeend', DIALOGS);
        $('acc-g-form').addEventListener('submit', saveGasto);
        $('acc-m-form').addEventListener('submit', saveMov);
    }

    async function open() {
        build();
        // Fixed monthly expenses whose day has arrived are created before loading.
        if (!loading) loading = _supabase.rpc('acct_generate_recurring').then(() => refresh(), () => refresh()).catch(err => {
            $('acc-body').innerHTML = `<p class="text-sm text-red-500 text-center py-8">${esc(/acct_|schema cache/i.test(err.message || '') ? 'Falta correr el SQL de supabase/migrations/20261121_accounting.sql.' : 'No se pudo cargar: ' + err.message)}</p>`;
        }).finally(() => { loading = null; });
        return loading;
    }

    function render() {
        if (!db) return;
        document.querySelectorAll('#acc-tabs .sub').forEach(b => b.classList.toggle('on', b.dataset.v === view));
        const body = $('acc-body');
        ({ panel: viewPanel, fijos: viewFijos, resumen: viewResumen, gastos: viewGastos, socios: viewSocios, estado: viewEstado, ingresos: viewIngresos,
            impuestos: viewImpuestos, conciliacion: viewConciliacion, reportes: viewReportes })[view](body);
    }

    // ---------- Resumen
    function viewResumen(body) {
        const rows = months().map(llcMes);
        const tot = rows.reduce((t, r) => { ['serv', 'otros', 'cv', 'op', 'act', 'nod', 'rev', 'res'].forEach(k => t[k] = (t[k] || 0) + r[k]); return t; }, {});
        const line = r => `${cell(r.serv)}${cell(r.otros)}${cell(r.cv)}${cell(r.op)}${cell(r.res)}${cell(r.act)}${cell(r.nod)}${cell(r.rev)}`;
        const last = months().slice(-1)[0];
        const debe = SOCIOS.reduce((s, x) => s + socioAcumulado(x, last).debe, 0);
        const sinDato = db.gastos.filter(g => g.libro === 'LLC' && g.estado === 'Sin dato').reduce((s, g) => s + g.monto, 0);
        const k = [['Ingresos LLC', money(tot.serv + tot.otros), 'Servicios, recargos y otros'], ['Resultado', money(tot.res), 'Antes de depreciación'],
            ['La LLC debe a socios', money(debe), 'Reembolsos pendientes'], ['Por aclarar', money(sinDato), 'Gastos con estado "Sin dato"']];
        body.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">${k.map(([a, b, c]) => `<div class="card p-4"><p class="lbl">${a}</p><p class="text-2xl font-semibold mt-1 ${b.startsWith('(') ? 'neg' : ''}">${b}</p><p class="text-[11px] opacity-60">${c}</p></div>`).join('')}</div>
          <div class="card overflow-hidden"><div class="px-5 pt-4 pb-2 flex flex-wrap items-baseline justify-between gap-2"><h3 class="text-2xl italic">Resultado mensual de la LLC</h3><p class="text-xs opacity-60">Antes de depreciación. Toca un encabezado para ordenar.</p></div>
          <div class="overflow-x-auto"><table class="t"><thead><tr>${th('resumen', 'mes', 'Mes')}${th('resumen', 'serv', 'Servicios', 'num')}${th('resumen', 'otros', 'Otros ingresos', 'num')}${th('resumen', 'cv', 'Costo de ventas', 'num')}${th('resumen', 'op', 'Gastos operativos', 'num')}${th('resumen', 'res', 'Resultado', 'num')}${th('resumen', 'act', 'Equipo (activo)', 'num')}${th('resumen', 'nod', 'No deducible', 'num')}${th('resumen', 'rev', 'Por revisar', 'num')}</tr></thead>
          <tbody>${sortList('resumen', rows).map(r => `<tr><td class="whitespace-nowrap">${mesLabel(r.mes)}</td>${line(r)}</tr>`).join('')}</tbody>
          <tfoot><tr class="font-bold"><td>Total</td>${line(tot)}</tr></tfoot></table></div></div>`;
    }

    // ---------- Gastos
    const gf = { q: '', mes: '', pag: '', est: '', cat: '' };
    function badgeEstado(e) {
        const c = { 'Pendiente': 'b-pendr', 'Reembolsado': 'b-ok', 'Aportado como capital': 'b-cap', 'No aplica (pagó la LLC)': 'b-llc', 'Sin dato': 'b-sd' }[e] || 'b-llc';
        return `<span class="badge ${c}">${esc(e === 'No aplica (pagó la LLC)' ? 'Pagó la LLC' : e === 'Aportado como capital' ? 'Capital' : e)}</span>`;
    }
    function viewGastos(body) {
        if (!$('acc-gq')) {
            body.innerHTML = `<div class="card p-3 md:p-4 mb-3 md:mb-4">
                <div class="flex gap-2 items-end">
                  <div class="flex-1"><label class="lbl" for="acc-gq">Buscar</label><input id="acc-gq" placeholder="Descripción o proveedor" type="search"></div>
                  <button type="button" class="soft md:hidden whitespace-nowrap" onclick="Acc.toggleFiltros()" id="acc-gfbtn">Filtros</button>
                </div>
                <div id="acc-gfil" class="hidden md:grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  <div><label class="lbl" for="acc-gmes">Mes</label><select id="acc-gmes"></select></div>
                  <div><label class="lbl" for="acc-gpag">Pagado por</label><select id="acc-gpag"></select></div>
                  <div><label class="lbl" for="acc-gest">Estado</label><select id="acc-gest"></select></div>
                  <div><label class="lbl" for="acc-gcat">Categoría</label><select id="acc-gcat"></select></div>
                  <div class="col-span-2 md:hidden"><label class="lbl" for="acc-gord">Ordenar por</label><select id="acc-gord">
                    <option value="fecha|-1">Más recientes</option><option value="fecha|1">Más antiguos</option><option value="monto|-1">Monto mayor</option><option value="monto|1">Monto menor</option><option value="descripcion|1">Descripción A–Z</option></select></div>
                </div></div>
              <div class="flex flex-wrap items-center justify-between gap-3 mb-3"><p class="text-sm" id="acc-gsum"></p>
                <span id="acc-bulk" class="hidden flex flex-wrap gap-2 items-center"><span class="text-xs opacity-70" id="acc-bulkn"></span><input type="date" id="acc-bulkd" style="width:auto">
                <button class="soft" onclick="Acc.bulkSet('Reembolsado')">Marcar reembolsado</button><button class="soft" onclick="Acc.bulkSet('Aportado como capital')">Pasar a capital</button><button class="soft md:hidden" onclick="Acc.clearSel()">Cancelar</button></span></div>
              <div class="card overflow-hidden hidden md:block"><div class="overflow-auto max-h-[65vh]"><table class="t" id="acc-gtbl"></table></div></div>
              <div class="md:hidden space-y-2" id="acc-gcards"></div>`;
            $('acc-gq').oninput = e => { gf.q = e.target.value; gLimit = 50; tablaGastos(); };
            [['acc-gmes', 'mes'], ['acc-gpag', 'pag'], ['acc-gest', 'est'], ['acc-gcat', 'cat']].forEach(([id, k]) => $(id).onchange = e => { gf[k] = e.target.value; gLimit = 50; tablaGastos(); });
            $('acc-gord').onchange = e => { const [k, d] = e.target.value.split('|'); sortState.gastos = { k, d: Number(d) }; tablaGastos(); };
        }
        $('acc-gord').value = `${sortState.gastos.k}|${sortState.gastos.d}`;
        fill($('acc-gmes'), months().slice().reverse().map(m => ({ v: m, t: mesLabel(m) })), 'Todos');
        fill($('acc-gpag'), PAGADORES, 'Todos'); fill($('acc-gest'), ESTADOS, 'Todos'); fill($('acc-gcat'), db.categorias.map(c => c.name), 'Todas');
        $('acc-gq').value = gf.q; $('acc-gmes').value = gf.mes; $('acc-gpag').value = gf.pag; $('acc-gest').value = gf.est; $('acc-gcat').value = gf.cat;
        tablaGastos();
    }
    let visibles = [];
    function tablaGastos() {
        const q = gf.q.toLowerCase();
        const list = sortList('gastos', db.gastos.filter(g => (!q || (g.descripcion + ' ' + g.proveedor).toLowerCase().includes(q)) && (!gf.mes || ym(g.fecha) === gf.mes)
            && (!gf.pag || g.pagado_por === gf.pag) && (!gf.est || g.estado === gf.est) && (!gf.cat || g.categoria === gf.cat)));
        visibles = list.map(g => g.id);
        const total = list.reduce((s, g) => s + g.monto, 0), pend = list.filter(g => g.estado === 'Pendiente').reduce((s, g) => s + g.monto, 0);
        $('acc-gsum').innerHTML = `<b>${list.length}</b> gastos · total <b>${money(total)}</b> · pendiente de reembolso <b>${money(pend)}</b>`;
        $('acc-gtbl').innerHTML = `<thead><tr><th><input type="checkbox" onchange="Acc.selAll(this)" aria-label="Seleccionar todos"></th>${th('gastos', 'fecha', 'Fecha')}${th('gastos', 'descripcion', 'Descripción')}${th('gastos', 'categoria', 'Categoría')}${th('gastos', 'monto', 'Monto', 'num')}${th('gastos', 'pagado_por', 'Pagado por')}${th('gastos', 'estado', 'Estado')}<th></th></tr></thead><tbody>` +
            list.map(g => `<tr><td><input type="checkbox" ${sel.has(g.id) ? 'checked' : ''} onchange="Acc.toggleSel('${g.id}', this.checked)" aria-label="Seleccionar"></td>
              <td class="whitespace-nowrap">${fdate(g.fecha)}</td>
              <td><div>${esc(g.descripcion)}${g.receipt ? ` <button class="text-[11px] text-[#B76E88] underline" onclick="Acc.verRecibo('${g.id}')">recibo</button>` : ''}</div><div class="text-[11px] opacity-60">${esc(g.proveedor)}${g.proveedor && g.cuenta ? ' · ' : ''}${esc(g.cuenta)}${g.libro !== 'LLC' ? ` <span class="badge ${g.libro.startsWith('NJ') ? 'b-nj' : 'b-sd'}">${esc(g.libro.startsWith('NJ') ? 'NJ fuera' : g.libro)}</span>` : ''}${/jornada NJ/.test(g.nota) ? ' <span class="badge b-nj">viaje NJ</span>' : ''}${g.source === 'telefono' ? ' <span class="badge b-llc">teléfono</span>' : ''}</div></td>
              <td class="text-xs">${esc(g.categoria)}${g.categoria === 'Revisar' ? ' <span class="badge b-sd">revisar</span>' : ''}</td>
              <td class="num">${money(g.monto)}</td><td class="text-xs whitespace-nowrap">${esc(g.pagado_por)}</td>
              <td>${badgeEstado(g.estado)}${g.fecha_reembolso ? `<div class="text-[10px] opacity-60 mt-1">${fdate(g.fecha_reembolso)}</div>` : ''}</td>
              <td><button class="text-xs text-[#B76E88] hover:underline" onclick="Acc.openGasto('${g.id}')">Editar</button></td></tr>`).join('') + '</tbody>';
        // Phone: one card per expense; tap to edit, the box selects it for the bulk actions.
        const corto = c => ({ 'Insumos y productos de tratamiento': 'Insumos', 'Envíos y aranceles de importación': 'Envíos', 'Comidas de negocio (50%)': 'Comidas',
            'Equipo menor y mobiliario': 'Equipo menor', 'Software y suscripciones': 'Software', 'Limpieza y suministros': 'Limpieza', 'Licencias, trámites y legal': 'Trámites' }[c] || c);
        $('acc-gcards').innerHTML = list.slice(0, gLimit).map(g => `<div class="gcard" onclick="Acc.openGasto('${g.id}')">
              <input type="checkbox" class="mt-1 w-5 h-5 accent-[#B76E88] shrink-0" ${sel.has(g.id) ? 'checked' : ''} onclick="event.stopPropagation()" onchange="Acc.toggleSel('${g.id}', this.checked)" aria-label="Seleccionar">
              <div class="flex-1 min-w-0">
                <div class="flex justify-between gap-2"><p class="text-[15px] font-medium leading-snug break-words min-w-0">${esc(g.descripcion)}</p><p class="text-[15px] font-semibold whitespace-nowrap">${money(g.monto)}</p></div>
                <p class="text-[12px] opacity-60 mt-0.5">${fdate(g.fecha)} · ${esc(corto(g.categoria))}${g.proveedor ? ' · ' + esc(g.proveedor) : ''}</p>
                <div class="flex flex-wrap gap-1 mt-1.5 items-center"><span class="badge b-llc">${esc(g.pagado_por)}</span>${badgeEstado(g.estado)}${g.categoria === 'Revisar' ? '<span class="badge b-sd">revisar</span>' : ''}${g.libro !== 'LLC' ? '<span class="badge b-nj">NJ fuera</span>' : ''}${g.source === 'telefono' ? '<span class="badge b-llc">teléfono</span>' : ''}${g.receipt ? `<button class="text-[12px] text-[#B76E88] underline" onclick="event.stopPropagation();Acc.verRecibo('${g.id}')">recibo</button>` : ''}</div>
              </div></div>`).join('') +
            (list.length > gLimit ? `<button class="soft w-full" onclick="Acc.masGastos()">Ver ${Math.min(50, list.length - gLimit)} más</button>` : '') +
            (list.length ? '' : '<p class="text-sm opacity-60 text-center py-8">No hay gastos con estos filtros.</p>');
        updateBulk();
    }
    let gLimit = 50;
    function masGastos() { gLimit += 50; tablaGastos(); }
    function toggleFiltros() { const f = $('acc-gfil'); f.classList.toggle('hidden'); f.classList.toggle('grid'); }
    function clearSel() { sel.clear(); tablaGastos(); }
    function updateBulk() {
        const b = $('acc-bulk'); if (!b) return;
        b.classList.toggle('hidden', !sel.size); $('acc-bulkn').textContent = sel.size + ' seleccionados';
        b.classList.toggle('bulkbar', !!sel.size && window.innerWidth < 768);   // phone: fixed bar at the bottom
    }
    function toggleSel(id, on) { on ? sel.add(id) : sel.delete(id); updateBulk(); }
    function selAll(cb) { visibles.forEach(id => cb.checked ? sel.add(id) : sel.delete(id)); tablaGastos(); }
    async function bulkSet(estado) {
        const d = $('acc-bulkd').value || today();
        const ids = db.gastos.filter(g => sel.has(g.id) && g.pagado_por !== 'LLC').map(g => g.id);
        if (!ids.length) { toast('Ninguno de los seleccionados lo pagó un socio.'); return; }
        const { error } = await _supabase.from('acct_expenses').update({ reimb_status: estado, reimbursed_on: estado === 'Reembolsado' ? d : null }).in('id', ids);
        if (error) { alert('No se pudo guardar: ' + error.message); return; }
        sel.clear(); await refresh(); toast(estado === 'Reembolsado' ? `${ids.length} gastos marcados como reembolsados.` : `${ids.length} gastos pasaron a capital.`);
    }

    // ---------- expense and movement forms
    const DIALOGS = `
    <dialog id="acc-dg" class="acc"><form id="acc-g-form" method="dialog" class="p-6 space-y-3">
      <h3 class="text-2xl italic" id="acc-g-title">Nuevo gasto</h3><input type="hidden" id="acc-g-id">
      <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="acc-g-fecha">Fecha</label><input type="date" id="acc-g-fecha" required></div>
        <div><label class="lbl" for="acc-g-monto">Monto ($)</label><input id="acc-g-monto" inputmode="decimal" required placeholder="0.00" style="font-size:20px;font-weight:600"></div></div>
      <div><label class="lbl" for="acc-g-desc">Descripción</label><input id="acc-g-desc" required></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-g-prov">Proveedor</label><input id="acc-g-prov"></div>
        <div><label class="lbl" for="acc-g-cat">Categoría</label><select id="acc-g-cat"></select></div></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-g-cuenta">Cuenta / tarjeta</label><select id="acc-g-cuenta"></select></div>
        <div><label class="lbl" for="acc-g-pag">Pagado por</label><select id="acc-g-pag"></select></div></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-g-est">Estado reembolso</label><select id="acc-g-est"></select></div>
        <div><label class="lbl" for="acc-g-freemb">Fecha reembolso</label><input type="date" id="acc-g-freemb"></div></div>
      <div><label class="lbl" for="acc-g-lib">Libro</label><select id="acc-g-lib"></select></div>
      <div><label class="lbl" for="acc-g-nota">Nota</label><textarea id="acc-g-nota" rows="2"></textarea></div>
      <div><label class="lbl" for="acc-g-foto">Foto del recibo</label><input type="file" accept="image/*,application/pdf" id="acc-g-foto"><p class="text-[11px] opacity-60 mt-1" id="acc-g-fotoinfo"></p></div>
      <div class="dlg-actions flex justify-between gap-2 pt-2"><button type="button" class="soft text-red-700" id="acc-g-del" onclick="Acc.delGasto()">Eliminar</button>
        <div class="flex gap-2"><button type="button" class="soft" onclick="this.closest('dialog').close()">Cancelar</button><button class="abtn" id="acc-g-save">Guardar</button></div></div>
    </form></dialog>
    <dialog id="acc-dm" class="acc"><form id="acc-m-form" method="dialog" class="p-6 space-y-3">
      <h3 class="text-2xl italic">Movimiento de socio</h3><input type="hidden" id="acc-m-id">
      <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="acc-m-fecha">Fecha</label><input type="date" id="acc-m-fecha" required></div>
        <div><label class="lbl" for="acc-m-monto">Monto ($)</label><input id="acc-m-monto" inputmode="decimal" required></div></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-m-socio">Socio</label><select id="acc-m-socio"><option>Freddy</option><option>Samuel</option><option>Ambos (50/50)</option></select></div>
        <div><label class="lbl" for="acc-m-tipo">Tipo</label><select id="acc-m-tipo"><option>Aporte de capital</option><option>Retiro de capital</option><option>Préstamo del socio</option><option>Pago de préstamo al socio</option></select></div></div>
      <div><label class="lbl" for="acc-m-concepto">Concepto</label><input id="acc-m-concepto" placeholder="Ej. aporte de noviembre para pagar tarjetas" required></div>
      <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="acc-m-conf" checked class="accent-[#B76E88]"> Confirmado (ya pasó el dinero)</label>
      <div class="dlg-actions flex justify-between gap-2 pt-2"><button type="button" class="soft text-red-700" id="acc-m-del" onclick="Acc.delMov()">Eliminar</button>
        <div class="flex gap-2"><button type="button" class="soft" onclick="this.closest('dialog').close()">Cancelar</button><button class="abtn">Guardar</button></div></div>
    </form></dialog>`;
    async function openGasto(id) {
        await (db ? null : open());
        const g = id ? db.gastos.find(x => x.id === id) : { fecha: today(), libro: 'LLC', estado: 'Pendiente', pagado_por: 'Freddy', categoria: 'Insumos y productos de tratamiento', cuenta: 'Chase Ink Business' };
        $('acc-g-title').textContent = id ? 'Editar gasto' : 'Nuevo gasto';
        fill($('acc-g-cat'), db.categorias.map(c => ({ v: c.name, t: `${c.name} · ${c.kind}` })));
        fill($('acc-g-pag'), PAGADORES); fill($('acc-g-est'), ESTADOS); fill($('acc-g-lib'), LIBROS);
        $('acc-g-id').value = id || ''; $('acc-g-fecha').value = g.fecha || ''; $('acc-g-monto').value = g.monto ?? ''; $('acc-g-desc').value = g.descripcion || '';
        $('acc-g-prov').value = g.proveedor || ''; $('acc-g-cat').value = g.categoria; fillCuentas($('acc-g-cuenta'), g.cuenta || 'Sin dato'); $('acc-g-pag').value = g.pagado_por;
        $('acc-g-est').value = g.estado; $('acc-g-freemb').value = g.fecha_reembolso || ''; $('acc-g-lib').value = g.libro; $('acc-g-nota').value = g.nota || ''; $('acc-g-foto').value = '';
        $('acc-g-fotoinfo').textContent = g.receipt ? 'Ya tiene recibo. Si subes otro, reemplaza el anterior.' : '';
        $('acc-g-del').classList.toggle('invisible', !id);
        $('acc-dg').showModal();
    }
    async function uploadReceipt(file) {
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
        const path = `${today().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
        const { error } = await _supabase.storage.from('receipts').upload(path, file, { contentType: file.type || undefined });
        if (error) throw error;
        return path;
    }
    async function saveGasto(ev) {
        ev.preventDefault();
        const monto = amt($('acc-g-monto').value);
        if (monto === null) { alert('Escribe un monto válido.'); return; }
        const id = $('acc-g-id').value, pag = $('acc-g-pag').value;
        let est = $('acc-g-est').value;
        if (pag === 'LLC') est = 'No aplica (pagó la LLC)'; else if (est === 'No aplica (pagó la LLC)') est = 'Pendiente';
        const row = { spent_on: $('acc-g-fecha').value, amount: monto, description: $('acc-g-desc').value.trim(), vendor: $('acc-g-prov').value.trim() || null,
            category: $('acc-g-cat').value, account: $('acc-g-cuenta').value, paid_by: pag, reimb_status: est,
            reimbursed_on: est === 'Reembolsado' ? ($('acc-g-freemb').value || null) : null, ledger: $('acc-g-lib').value, note: $('acc-g-nota').value.trim() || null };
        const btn = $('acc-g-save'); btn.disabled = true;
        try {
            const file = $('acc-g-foto').files[0];
            if (file) row.receipt_path = await uploadReceipt(file);
            const res = id ? await _supabase.from('acct_expenses').update(row).eq('id', id)
                : await _supabase.from('acct_expenses').insert({ ...row, source: 'admin', created_by: await userId() });
            if (res.error) throw res.error;
            $('acc-dg').close(); await refresh(); toast('Gasto guardado.');
        } catch (err) { alert('No se pudo guardar: ' + err.message); }
        finally { btn.disabled = false; }
    }
    async function delGasto() {
        const id = $('acc-g-id').value; if (!id || !confirm('¿Eliminar este gasto? Deja de contar en los totales.')) return;
        const { error } = await _supabase.from('acct_expenses').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) { alert('No se pudo eliminar: ' + error.message); return; }
        $('acc-dg').close(); await refresh(); toast('Gasto eliminado.');
    }
    async function verRecibo(id) {
        const g = db.gastos.find(x => x.id === id);
        const { data, error } = await _supabase.storage.from('receipts').createSignedUrl(g.receipt, 300);
        if (error) { alert('No se pudo abrir el recibo: ' + error.message); return; }
        window.open(data.signedUrl, '_blank', 'noopener');
    }
    async function openMov(id, socio) {
        await (db ? null : open());
        const m = id ? db.movimientos.find(x => x.id === id) : { fecha: today(), socio: socio || 'Freddy', tipo: 'Aporte de capital', confirmado: true };
        $('acc-m-id').value = id || ''; $('acc-m-fecha').value = m.fecha; $('acc-m-monto').value = m.monto ?? ''; $('acc-m-socio').value = m.socio; $('acc-m-tipo').value = m.tipo;
        $('acc-m-concepto').value = m.concepto || ''; $('acc-m-conf').checked = !!m.confirmado; $('acc-m-del').classList.toggle('invisible', !id);
        $('acc-dm').showModal();
    }
    async function saveMov(ev) {
        ev.preventDefault();
        const monto = amt($('acc-m-monto').value);
        if (!monto || monto <= 0) { alert('Escribe un monto mayor que cero.'); return; }
        const id = $('acc-m-id').value;
        const row = { moved_on: $('acc-m-fecha').value, partner: $('acc-m-socio').value, kind: $('acc-m-tipo').value, amount: monto, concept: $('acc-m-concepto').value.trim(), confirmed: $('acc-m-conf').checked };
        const res = id ? await _supabase.from('acct_partner_movements').update(row).eq('id', id) : await _supabase.from('acct_partner_movements').insert({ ...row, created_by: await userId() });
        if (res.error) { alert('No se pudo guardar: ' + res.error.message); return; }
        $('acc-dm').close(); await refresh(); toast('Movimiento guardado.');
    }
    async function delMov() {
        const id = $('acc-m-id').value; if (!id || !confirm('¿Eliminar este movimiento?')) return;
        const { error } = await _supabase.from('acct_partner_movements').update({ deleted_at: new Date().toISOString() }).eq('id', id);
        if (error) { alert('No se pudo eliminar: ' + error.message); return; }
        $('acc-dm').close(); await refresh();
    }

    // ---------- Socios
    function viewSocios(body) {
        const last = months().slice(-1)[0];
        const cards = SOCIOS.map(s => { const a = socioAcumulado(s, last);
            return `<div class="card p-5"><div class="flex items-baseline justify-between"><h3 class="text-3xl italic">${s}</h3><span class="lbl">${SHARE(s) * 100}% de la LLC</span></div>
              <div class="grid grid-cols-3 gap-3 mt-4">
                <div><p class="lbl">Capital</p><p class="text-xl font-semibold">${money(a.capital)}</p><p class="text-[11px] opacity-60">aportes − retiros</p></div>
                <div><p class="lbl">La LLC le debe</p><p class="text-xl font-semibold">${money(a.debe)}</p><p class="text-[11px] opacity-60">gastos por reembolsar</p></div>
                <div><p class="lbl">Préstamos</p><p class="text-xl font-semibold">${money(a.prestamo)}</p><p class="text-[11px] opacity-60">saldo</p></div></div>
              <div class="flex flex-wrap gap-2 mt-4"><button class="soft" onclick="Acc.openMov(null, '${s}')">+ Aporte</button><button class="soft" onclick="Acc.verEstado('${s}')">Ver estado de cuenta</button></div></div>`; }).join('');
        const list = sortList('mov', db.movimientos);
        body.innerHTML = `<div class="grid md:grid-cols-2 gap-4 mb-6">${cards}</div><h3 class="text-2xl italic mb-3">Movimientos de los socios</h3>
          <div class="card overflow-hidden"><div class="overflow-x-auto"><table class="t"><thead><tr>${th('mov', 'fecha', 'Fecha')}${th('mov', 'socio', 'Socio')}${th('mov', 'tipo', 'Tipo')}${th('mov', 'concepto', 'Concepto')}${th('mov', 'monto', 'Monto', 'num')}${th('mov', 'confirmado', 'Estado')}<th></th></tr></thead><tbody>` +
            list.map(m => `<tr><td class="whitespace-nowrap">${fdate(m.fecha)}</td><td class="whitespace-nowrap">${esc(m.socio)}</td><td class="text-xs">${esc(m.tipo)}</td>
              <td><div>${esc(m.concepto)}</div>${m.nota ? `<div class="text-[11px] opacity-60">${esc(m.nota)}</div>` : ''}</td>
              <td class="num ${m.tipo.startsWith('Retiro') || m.tipo.startsWith('Pago') ? 'neg' : ''}">${money(m.monto)}</td>
              <td>${m.confirmado ? '<span class="badge b-ok">Confirmado</span>' : '<span class="badge b-pend">Por confirmar</span>'}</td>
              <td><button class="text-xs text-[#B76E88] hover:underline" onclick="Acc.openMov('${m.id}')">Editar</button></td></tr>`).join('') + '</tbody></table></div></div>';
    }

    // ---------- Estado de cuenta
    let eSocio = 'Freddy', eMes = null;
    function verEstado(s) { eSocio = s; view = 'estado'; render(); }
    function prevMonth(m) { let [y, mo] = m.split('-').map(Number); mo--; if (!mo) { mo = 12; y--; } return `${y}-${String(mo).padStart(2, '0')}`; }
    function viewEstado(body) {
        const ms = months(); if (!eMes || !ms.includes(eMes)) eMes = ms[ms.length - 1];
        const s = eSocio, m = eMes, otro = SOCIOS.find(x => x !== s), tasa = Number(db.cfg.loan_rate || 0);
        const ini = socioAcumulado(s, prevMonth(m)), r = socioMes(s, m);
        const capFin = ini.capital + r.aportes - r.retiros, debeFin = ini.debe + r.gastos - r.reembolsos, presFin = ini.prestamo + r.prestamos - r.pagosPrestamo;
        const line = (a, b, cls = '') => `<div class="stmt-line ${cls}"><span>${a}</span><span class="num">${b}</span></div>`;
        const detail = (arr, useR, empty) => arr.length ? `<table class="t mt-2 mb-4"><tbody>${arr.map(g => `<tr><td class="whitespace-nowrap">${fdate(useR && g.fecha_reembolso ? g.fecha_reembolso : g.fecha)}</td><td>${esc(g.descripcion || g.concepto)}${g.pagado_por === 'Ambos (50/50)' || g.socio === 'Ambos (50/50)' ? ' <span class="text-[10px] opacity-60">(50%)</span>' : ''}</td><td class="num">${money(g.parte)}</td></tr>`).join('')}</tbody></table>` : `<p class="text-xs opacity-60 mt-1 mb-4">${empty}</p>`;
        body.innerHTML = `<div class="card p-4 mb-4 grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
            <div><label class="lbl" for="acc-es">Socio</label><select id="acc-es">${SOCIOS.map(x => `<option ${x === s ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
            <div><label class="lbl" for="acc-em">Mes</label><select id="acc-em">${ms.slice().reverse().map(x => `<option value="${x}" ${x === m ? 'selected' : ''}>${mesLabel(x)}</option>`).join('')}</select></div>
            <div><label class="lbl" for="acc-et">Tasa anual de préstamos (%)</label><input id="acc-et" inputmode="decimal" value="${r2(tasa * 100)}"></div>
            <div class="col-span-2 flex justify-end"><button class="abtn" onclick="Acc.imprimir()">Imprimir / PDF</button></div></div>
          <div class="card p-6 md:p-10 acc-print" id="acc-stmt">
            <div class="flex flex-wrap items-start justify-between gap-4 mb-6"><div><p class="lbl">Piel Spa LLC · Estado de cuenta del socio</p><h2 class="text-4xl italic">${s}</h2><p class="text-sm opacity-70">${mesLargo(m)} · participación ${SHARE(s) * 100}%</p></div>
              <div class="text-right text-xs opacity-60">Generado ${fdate(today())}<br>Documento interno</div></div>
            <div class="grid md:grid-cols-2 gap-8"><div>
              <h3 class="text-2xl italic mb-2">1. Cuenta de capital</h3>
              ${line('Saldo al inicio del mes', money(ini.capital))}${line('(+) Aportes de capital', money(r.aportes))}${line('(−) Retiros de capital', money(r.retiros))}${line('Saldo al final del mes', money(capFin), 'total')}
              ${detail(r.listaMov.filter(x => x.tipo.includes('capital')), false, 'Sin aportes ni retiros este mes.')}
              <h3 class="text-2xl italic mb-2 mt-4">3. Préstamos del socio</h3>
              ${line('Saldo al inicio del mes', money(ini.prestamo))}${line('(+) Nuevos préstamos', money(r.prestamos))}${line('(−) Pagos recibidos', money(r.pagosPrestamo))}
              ${line(`Interés del mes (${r2(tasa * 100)}% anual)`, money(r2(ini.prestamo * tasa / 12)))}${line('Saldo al final del mes', money(presFin), 'total')}
            </div><div>
              <h3 class="text-2xl italic mb-2">2. Gastos de la LLC pagados por el socio</h3>
              ${line('La LLC le debía al inicio del mes', money(ini.debe))}${line('(+) Gastos que pagó este mes', money(r.gastos))}${detail(r.listaGastos, false, 'No pagó gastos de la LLC este mes.')}
              ${line('(−) Reembolsos recibidos', money(r.reembolsos))}${detail(r.listaReemb, true, 'No recibió reembolsos este mes.')}${line('La LLC le debe al final del mes', money(debeFin), 'total')}
            </div></div>
            <p class="text-xs opacity-70 mt-8">Los gastos pagados por ambos socios se reparten según la participación. Los viajes a jornadas de NJ cuentan como gasto de la LLC; el pago a los socios por esas jornadas no.</p>
            <div class="grid grid-cols-2 gap-10 mt-16"><div class="border-t border-[#2A2330] pt-2 text-sm">${s}<br><span class="text-xs opacity-60">Firma y fecha</span></div><div class="border-t border-[#2A2330] pt-2 text-sm">${otro}<br><span class="text-xs opacity-60">Firma y fecha</span></div></div>
          </div>`;
        $('acc-es').onchange = e => { eSocio = e.target.value; render(); };
        $('acc-em').onchange = e => { eMes = e.target.value; render(); };
        $('acc-et').onchange = async e => {
            const n = parseFloat(e.target.value); const v = isNaN(n) ? 0 : n / 100;
            const { error } = await _supabase.from('acct_settings').update({ loan_rate: v, updated_at: new Date().toISOString() }).eq('id', 1);
            if (error) { alert('No se pudo guardar la tasa: ' + error.message); return; }
            db.cfg.loan_rate = v; render();
        };
    }
    function imprimir() { document.body.classList.add('acc-printing'); window.print(); setTimeout(() => document.body.classList.remove('acc-printing'), 500); }

    // ---------- Ingresos
    function viewIngresos(body) {
        const list = sortList('ing', db.ingresos);
        body.innerHTML = `<div class="card p-4 mb-4 text-sm">Los cobros nuevos salen de <b>Cobros</b>. Los de antes vienen del Libro Contable. Todo cobro a un cliente es ingreso de la LLC, con cualquier método de pago.</div>
          <div class="card overflow-hidden"><div class="overflow-x-auto"><table class="t"><thead><tr>${th('ing', 'fecha', 'Fecha')}${th('ing', 'cliente', 'Cliente')}${th('ing', 'servicio', 'Servicio')}${th('ing', 'categoria', 'Categoría')}${th('ing', 'metodo', 'Método')}${th('ing', 'monto', 'Venta', 'num')}${th('ing', 'impuesto', 'Impuesto', 'num')}${th('ing', 'total', 'Total cobrado', 'num')}${th('ing', 'libro', 'Libro')}</tr></thead><tbody>` +
            list.map(i => `<tr class="${i.anulado ? 'opacity-40 line-through' : ''}"><td class="whitespace-nowrap">${i.fecha ? fdate(i.fecha) : '<span class="badge b-sd">sin fecha</span>'}</td><td>${esc(i.cliente)}</td>
              <td><div>${esc(i.servicio)}</div>${i.nota ? `<div class="text-[11px] opacity-60">${esc(i.nota)}</div>` : ''}</td><td class="text-xs whitespace-nowrap">${esc(i.categoria)}</td>
              <td class="text-xs">${esc(i.metodo)}</td><td class="num">${i.monto == null ? '<span class="badge b-sd">falta</span>' : money(i.monto)}</td>${cell(i.impuesto || 0)}
              <td class="num">${i.total == null ? '' : money(i.total)}</td><td><span class="badge ${i.anulado ? 'b-sd' : i.libro === 'LLC' ? 'b-llc' : 'b-nj'}">${i.anulado ? 'Anulado' : i.libro === 'LLC' ? (i.tabla === 'payments' ? 'Cobros' : 'LLC') : 'NJ fuera'}</span></td></tr>`).join('') + '</tbody></table></div></div>';
    }

    // ---------- Impuestos (NY sales tax quarters)
    function trimestres() {
        const out = []; let [y, m] = months()[0].split('-').map(Number);
        if (m <= 2) { y -= 1; m = 12; } else if (m !== 12) m = m - ((m - 3) % 3);
        const lastM = months().slice(-1)[0];
        while (`${y}-${String(m).padStart(2, '0')}` <= lastM) {
            const ms = [0, 1, 2].map(k => { let mm = m + k, yy = y; if (mm > 12) { mm -= 12; yy++; } return `${yy}-${String(mm).padStart(2, '0')}`; });
            let dm = m + 3, dy = y; if (dm > 12) { dm -= 12; dy++; }
            out.push({ inicio: ms[0], meses: ms, vence: `${dy}-${String(dm).padStart(2, '0')}-20` });
            m += 3; if (m > 12) { m -= 12; y++; }
        }
        return out;
    }
    function trimestreData(q) {
        const r = { inicio: q.inicio, vence: q.vence, label: `${mesLabel(q.meses[0])} – ${mesLabel(q.meses[2])}`, cobros: 0, baseServ: 0, baseProd: 0, taxServ: 0, taxProd: 0 };
        db.ingresos.filter(i => !i.anulado && i.libro === 'LLC' && i.tabla === 'payments' && q.meses.includes(ym(i.fecha))).forEach(i => {
            r.cobros++; r.baseServ += i.baseServ || 0; r.baseProd += i.baseProd || 0; r.taxServ += i.taxServ || 0; r.taxProd += i.taxProd || 0;
        });
        r.total = r2(r.taxServ + r.taxProd); return r;
    }
    function viewImpuestos(body) {
        const rows = trimestres().map(trimestreData);
        body.innerHTML = `<div class="card p-4 mb-4 text-sm">Impuesto cobrado a los clientes por trimestre de NY. No es ingreso de la LLC: se guarda y se paga al estado antes de la fecha límite. Solo cuenta lo cobrado en Cobros.</div>
          <div class="card overflow-hidden"><div class="overflow-x-auto"><table class="t"><thead><tr>${th('imp', 'inicio', 'Trimestre')}${th('imp', 'cobros', 'Cobros', 'num')}${th('imp', 'baseServ', 'Ventas servicios', 'num')}${th('imp', 'baseProd', 'Ventas productos', 'num')}${th('imp', 'taxServ', 'Impuesto servicios', 'num')}${th('imp', 'taxProd', 'Impuesto productos', 'num')}${th('imp', 'total', 'Total a pagar', 'num')}${th('imp', 'vence', 'Fecha límite')}</tr></thead><tbody>` +
            sortList('imp', rows).map(r => `<tr><td class="whitespace-nowrap">${r.label}</td><td class="num">${r.cobros}</td>${cell(r.baseServ)}${cell(r.baseProd)}${cell(r.taxServ)}${cell(r.taxProd)}<td class="num font-bold">${money(r.total)}</td>
              <td class="whitespace-nowrap">${fdate(r.vence)}${r.vence < today() && r.total ? ' <span class="badge b-sd">vencido</span>' : ''}</td></tr>`).join('') + '</tbody></table></div></div>';
    }

    // ---------- Conciliación (Chase activity CSV)
    function parseCSV(text) {
        const rows = []; let row = [], cur = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
            else if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; }
            else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
            else cur += ch;
        }
        if (cur || row.length) { row.push(cur); rows.push(row); }
        return rows.filter(r => r.some(c => c.trim()));
    }
    function toIso(s) { s = (s || '').trim(); let m; if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }
    const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    function conciliar(text, nombre) {
        const rows = parseCSV(text); if (rows.length < 2) { alert('El archivo no tiene movimientos.'); return; }
        const h = rows[0].map(x => x.toLowerCase()), ci = re => h.findIndex(x => re.test(x));
        const iD = ci(/posting date|fecha|^date|transaction date/), iT = ci(/description|descrip|detalle/), iA = ci(/^amount|monto|importe/);
        if (iD < 0 || iA < 0) { alert('No encontré las columnas de fecha y monto. Descarga la actividad en CSV desde chase.com.'); return; }
        const dep = rows.slice(1).map((r, k) => ({ k, fecha: toIso(r[iD]), desc: (r[iT] || '').trim(), monto: amt(r[iA]) })).filter(d => d.fecha && d.monto > 0);
        if (!dep.length) { alert('El archivo no tiene depósitos (montos positivos).'); return; }
        const desde = dep.reduce((a, d) => d.fecha < a ? d.fecha : a, '9999'), hasta = dep.reduce((a, d) => d.fecha > a ? d.fecha : a, '0000');
        const cob = db.ingresos.filter(i => !i.anulado && i.libro === 'LLC' && i.fecha && i.total != null && i.metodo !== 'Efectivo' && i.fecha >= addDays(desde, -4) && i.fecha <= hasta)
            .map(i => ({ ...i, esperado: isCard(i.metodo) ? [r2(i.total - (i.comision || 0)), i.total] : [i.total] }));
        const usados = new Set(), pares = [];
        cob.sort((a, b) => a.fecha.localeCompare(b.fecha)).forEach(c => {
            const cand = dep.filter(d => !usados.has(d.k) && d.fecha >= c.fecha && d.fecha <= addDays(c.fecha, 4) && c.esperado.some(e => Math.abs(e - d.monto) < 0.02)).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
            if (cand) { usados.add(cand.k); pares.push({ cobros: [c], dep: cand }); c.ok = true; }
        });
        const porDia = {}; cob.filter(c => !c.ok && isCard(c.metodo)).forEach(c => (porDia[c.fecha] = porDia[c.fecha] || []).push(c));
        Object.entries(porDia).forEach(([f, cs]) => {
            const neto = r2(cs.reduce((s, c) => s + c.esperado[0], 0)), bruto = r2(cs.reduce((s, c) => s + c.total, 0));
            const cand = dep.find(d => !usados.has(d.k) && d.fecha >= f && d.fecha <= addDays(f, 4) && (Math.abs(d.monto - neto) < 0.02 || Math.abs(d.monto - bruto) < 0.02));
            if (cand) { usados.add(cand.k); pares.push({ cobros: cs, dep: cand }); cs.forEach(c => c.ok = true); }
        });
        conc = { nombre, desde, hasta, pares, sinDep: cob.filter(c => !c.ok), sinCobro: dep.filter(d => !usados.has(d.k)) };
        render();
    }
    function viewConciliacion(body) {
        const tabla = (titulo, head, rows) => `<div class="card overflow-hidden"><h3 class="text-xl italic px-5 pt-4 pb-2">${titulo}</h3><div class="overflow-x-auto"><table class="t"><thead><tr>${head.map(x => `<th class="${x.startsWith('$') ? 'num' : ''}">${x.replace('$', '')}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}" class="text-sm opacity-60 text-center py-4">Nada aquí.</td></tr>`}</tbody></table></div></div>`;
        body.innerHTML = `<div class="card p-5 mb-4 text-sm space-y-3">
            <p>QuickAccept no se conecta con este sistema. Para comprobar que cada cobro llegó al banco (y que no falta registrar ninguno):</p>
            <ol class="list-decimal pl-5 space-y-1 text-[13px]"><li>En chase.com abre la cuenta Chase Business, elige las fechas y descarga la actividad en <b>CSV</b>.</li><li>Súbelo aquí. Se cruza cada depósito con los cobros que no fueron en efectivo, por monto y fecha.</li></ol>
            <div class="flex flex-wrap gap-2 items-center"><label class="abtn cursor-pointer">Subir CSV de Chase<input type="file" accept=".csv,text/csv" id="acc-cfile" class="hidden"></label>
              <span class="text-xs opacity-60">${conc ? `${esc(conc.nombre)} · depósitos del ${fdate(conc.desde)} al ${fdate(conc.hasta)}` : ''}</span></div></div>` +
            (conc ? `<div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">${[['Cuadran', conc.pares.length, 'depósitos con su cobro', 'b-ok'], ['Cobros sin depósito', conc.sinDep.length, 'revisa si QuickAccept o el cliente lo pagó', 'b-pend'], ['Depósitos sin cobro', conc.sinCobro.length, 'ingreso o aporte sin registrar', 'b-sd']]
                .map(([a, b, c, cls]) => `<div class="card p-4"><span class="badge ${cls}">${a}</span><p class="text-3xl font-semibold mt-2">${b}</p><p class="text-[11px] opacity-60">${c}</p></div>`).join('')}</div>
              <div class="space-y-4">` +
              tabla('Depósitos sin cobro registrado', ['Fecha', 'Descripción en el banco', '$Monto', ''], conc.sinCobro.map(d => `<tr><td>${fdate(d.fecha)}</td><td class="text-xs">${esc(d.desc)}</td><td class="num">${money(d.monto)}</td>
                <td class="whitespace-nowrap"><button class="text-xs text-[#B76E88] hover:underline mr-2" onclick="Acc.irACobros()">Registrar cobro</button><button class="text-xs opacity-60 hover:underline" onclick="Acc.depAporte('${d.fecha}', ${d.monto})">Es aporte de socio</button></td></tr>`).join('')) +
              tabla('Cobros sin depósito', ['Fecha', 'Cliente', 'Método', '$Esperado'], conc.sinDep.map(c => `<tr><td>${fdate(c.fecha)}</td><td>${esc(c.cliente)}</td><td class="text-xs">${esc(c.metodo)}</td><td class="num">${money(c.esperado[0])}</td></tr>`).join('')) +
              tabla('Cuadran', ['Depósito', 'Cobro(s)', '$Monto'], conc.pares.map(p => `<tr><td>${fdate(p.dep.fecha)}<div class="text-[11px] opacity-60">${esc(p.dep.desc)}</div></td><td class="text-xs">${p.cobros.map(c => `${fdate(c.fecha)} · ${esc(c.cliente)} · ${esc(c.metodo)}`).join('<br>')}</td><td class="num">${money(p.dep.monto)}</td></tr>`).join('')) +
              `<div class="flex justify-end"><button class="abtn" onclick="Acc.guardarConciliacion()">Marcar los cobros que cuadran como conciliados</button></div></div>` : '');
        $('acc-cfile').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => conciliar(String(rd.result), f.name); rd.readAsText(f); };
    }
    async function guardarConciliacion() {
        const ids = conc.pares.flatMap(p => p.cobros).filter(c => c.tabla === 'payments' && !c.conciliado).map(c => c.pid);
        if (!ids.length) { toast('No hay cobros nuevos para marcar.'); return; }
        const { error } = await _supabase.from('payments').update({ reconciled_at: new Date().toISOString() }).in('id', ids);
        if (error) { alert('No se pudo guardar: ' + error.message); return; }
        await refresh(); toast(`${ids.length} cobros marcados como conciliados.`);
    }
    function irACobros() { const link = [...document.querySelectorAll('.nav-link')].find(a => /payments-view/.test(a.getAttribute('onclick') || '')); if (link) link.click(); }
    function depAporte(fecha, monto) { openMov(null, 'Freddy').then(() => { $('acc-m-fecha').value = fecha; $('acc-m-monto').value = monto; }); }

    // ---------- Reportes
    const anios = () => [...new Set(months().map(m => m.slice(0, 4)))].sort();
    let rAnio = null;
    function fiscal(anio, antesDe) {
        const inY = f => f && (antesDe ? f.slice(0, 4) < antesDe : f.slice(0, 4) === anio);
        const r = { l1a: 0, l7: 0, cogs: 0, rent: 0, otras: 0, comidas: 0, comidasNoDed: 0, s179: 0, nodeduc: 0, noGasto: 0, revisar: 0, porCat: {} };
        db.ingresos.filter(i => !i.anulado && i.libro === 'LLC' && inY(i.fecha)).forEach(i => { if (i.categoria === 'Otro ingreso') r.l7 += i.monto || 0; else r.l1a += i.monto || 0; r.l1a += i.recargo || 0; });
        db.gastos.filter(g => g.libro === 'LLC' && inY(g.fecha)).forEach(g => {
            const t = catTipo(g.categoria), v = g.monto; r.porCat[g.categoria] = (r.porCat[g.categoria] || 0) + v;
            if (t === 'Costo de ventas') r.cogs += v; else if (g.categoria === 'Alquiler de cabina') r.rent += v;
            else if (g.categoria === 'Comidas de negocio (50%)') { r.comidas += v / 2; r.comidasNoDed += v / 2; }
            else if (t === 'Gasto operativo') r.otras += v; else if (t === 'Activo') r.s179 += v; else if (t === 'No deducible') r.nodeduc += v;
            else if (t === 'No es gasto') r.noGasto += v; else r.revisar += v;
        });
        r.l21 = r.otras + r.comidas; r.ordinario = r.l1a - r.cogs + r.l7 - r.rent - r.l21; r.capital = r.ordinario - r.s179 - r.nodeduc - r.comidasNoDed;
        Object.keys(r).forEach(k => typeof r[k] === 'number' && (r[k] = r2(r[k])));
        return r;
    }
    function capitalSocio(socio, anio) {
        const mov = (tipo, cond) => db.movimientos.filter(x => x.confirmado && x.tipo === tipo && cond(x.fecha)).reduce((s, x) => s + x.monto * share(x.socio, socio), 0);
        const antes = f => f.slice(0, 4) < anio, en = f => f.slice(0, 4) === anio;
        const inicial = mov('Aporte de capital', antes) - mov('Retiro de capital', antes) + fiscal(anio, anio).capital * SHARE(socio);
        const aportes = mov('Aporte de capital', en), retiros = mov('Retiro de capital', en), resultado = fiscal(anio).capital * SHARE(socio);
        return { inicial: r2(inicial), aportes: r2(aportes), resultado: r2(resultado), retiros: r2(retiros), final: r2(inicial + aportes + resultado - retiros) };
    }
    const lineas1065 = f => [['1a', 'Ingresos brutos (servicios + recargos de tarjeta)', f.l1a], ['2', 'Costo de ventas (todo lo comprado; falta restar el inventario al 31 de dic.)', -f.cogs],
        ['7', 'Otros ingresos', f.l7], ['13', 'Alquiler', -f.rent], ['21', 'Otras deducciones (incluye 50% de comidas)', -f.l21], ['23', 'Resultado ordinario estimado', f.ordinario],
        ['4562', 'Equipo para Sec. 179 (va aparte en el K-1)', f.s179], ['—', 'No deducible (multas y 50% de comidas)', f.nodeduc + f.comidasNoDed],
        ['—', 'No es gasto (depósito de garantía)', f.noGasto], ['—', 'Por revisar antes de declarar', f.revisar]];
    function viewReportes(body) {
        if (!rAnio || !anios().includes(rAnio)) rAnio = anios().slice(-1)[0];
        const f = fiscal(rAnio), cs = SOCIOS.map(s => capitalSocio(s, rAnio));
        const line = (a, b, c, cls = '') => `<div class="stmt-line ${cls}"><span><span class="text-[10px] font-bold text-[#B76E88] inline-block w-10">${a}</span>${b}</span><span class="num ${c < 0 ? 'neg' : ''}">${money(c)}</span></div>`;
        const m2 = [['Saldo al inicio del año', 'inicial'], ['(+) Aportes', 'aportes'], ['(+/−) Resultado asignado', 'resultado'], ['(−) Retiros', 'retiros'], ['Saldo al final del año', 'final']];
        body.innerHTML = `<div class="card p-4 mb-4 flex flex-wrap items-end gap-3"><div class="w-36"><label class="lbl" for="acc-ra">Año fiscal</label><select id="acc-ra">${anios().slice().reverse().map(a => `<option ${a === rAnio ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
            <div class="w-40"><label class="lbl" for="acc-cm">Cierre del mes</label><select id="acc-cm">${months().slice().reverse().map(x => `<option value="${x}">${mesLabel(x)}</option>`).join('')}</select></div><button class="soft" onclick="Acc.cierreMes(document.getElementById('acc-cm').value)">Ver cierre / PDF</button>
            <div class="flex flex-wrap gap-2 ml-auto"><button class="abtn" onclick="Acc.exportContadora()">Reporte para la contadora (Excel)</button><button class="soft" onclick="Acc.exportFormatoSheet()">Excel con formato del Sheet</button></div></div>
          <div class="grid md:grid-cols-2 gap-4"><div class="card p-5"><h3 class="text-2xl italic">Form 1065 (estimado)</h3><p class="text-xs opacity-60 mb-3">Para revisar con la contadora. Libro LLC, sin cobros anulados.</p>
            ${lineas1065(f).map(([a, b, c], i) => line(a, b, c, i === 5 ? 'total' : '')).join('')}
            <details class="mt-4 text-sm"><summary class="cursor-pointer text-[#B76E88] text-xs uppercase tracking-widest font-bold">Gastos por categoría</summary>${Object.entries(f.porCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="flex justify-between py-1 border-b border-[#F4EDF1]"><span>${esc(k)}</span><span class="num">${money(v)}</span></div>`).join('')}</details></div>
          <div class="space-y-4"><div class="card p-5"><h3 class="text-2xl italic">Schedule K-1 por socio</h3><table class="t mt-2"><thead><tr><th>Casilla</th><th class="num">Freddy</th><th class="num">Samuel</th></tr></thead><tbody>
              <tr><td>Box 1 · Resultado ordinario</td>${cell(f.ordinario * SHARE('Freddy'))}${cell(f.ordinario * SHARE('Samuel'))}</tr>
              <tr><td>Box 12 · Deducción Sec. 179</td>${cell(f.s179 * SHARE('Freddy'))}${cell(f.s179 * SHARE('Samuel'))}</tr>
              <tr><td>Box 18 · Gastos no deducibles</td>${cell((f.nodeduc + f.comidasNoDed) * SHARE('Freddy'))}${cell((f.nodeduc + f.comidasNoDed) * SHARE('Samuel'))}</tr></tbody></table></div>
            <div class="card p-5"><h3 class="text-2xl italic">Cuentas de capital (M-2)</h3><table class="t mt-2"><thead><tr><th></th><th class="num">Freddy</th><th class="num">Samuel</th></tr></thead><tbody>${m2.map(([l, k], i) => `<tr class="${i === 4 ? 'font-bold' : ''}"><td>${l}</td>${cell(i === 3 ? -cs[0][k] : cs[0][k])}${cell(i === 3 ? -cs[1][k] : cs[1][k])}</tr>`).join('')}</tbody></table>
              <p class="text-[11px] opacity-60 mt-2">Base fiscal. Lo que la LLC les debe en reembolsos no es capital: es una deuda de la LLC y va aparte. Solo cuenta movimientos confirmados.</p></div></div></div>`;
        $('acc-ra').onchange = e => { rAnio = e.target.value; render(); };
    }
    let xlsxLoading = null;
    function needXlsx() {
        if (window.XLSX) return Promise.resolve();
        return xlsxLoading = xlsxLoading || new Promise((ok, fail) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = () => { xlsxLoading = null; fail(new Error('No se pudo cargar la librería de Excel.')); }; document.head.appendChild(s); });
    }
    const asDate = s => { if (!s) return ''; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
    const sheet = (rows, w) => { const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '': 'Sin datos' }], { cellDates: true }); if (w) ws['!cols'] = w.map(x => ({ wch: x })); return ws; };
    async function exportContadora() {
        try { await needXlsx(); } catch (e) { alert(e.message); return; }
        const anio = rAnio, f = fiscal(anio), wb = XLSX.utils.book_new(), add = (n, rows, w) => XLSX.utils.book_append_sheet(wb, sheet(rows, w), n);
        const enAnio = x => (x.fecha || '').slice(0, 4) === anio;
        add('Resumen 1065', lineas1065(f).map(([a, b, c]) => ({ Línea: a, Concepto: b, Monto: c })), [8, 60, 14]);
        add('K-1', SOCIOS.map(s => ({ Socio: s, Participación: SHARE(s), 'Box 1 Resultado ordinario': r2(f.ordinario * SHARE(s)), 'Box 12 Sec. 179': r2(f.s179 * SHARE(s)), 'Box 18 No deducibles': r2((f.nodeduc + f.comidasNoDed) * SHARE(s)) })));
        add('M-2 Capital', SOCIOS.map(s => { const c = capitalSocio(s, anio); return { Socio: s, 'Saldo inicial': c.inicial, Aportes: c.aportes, 'Resultado asignado': c.resultado, Retiros: c.retiros, 'Saldo final': c.final }; }));
        add('Ingresos', db.ingresos.filter(i => enAnio(i) && i.libro === 'LLC' && !i.anulado).map(i => ({ Fecha: asDate(i.fecha), Cliente: i.cliente, Servicio: i.servicio, Categoría: i.categoria, Método: i.metodo, 'Venta sin impuesto': i.monto, Impuesto: i.impuesto || 0, 'Recargo tarjeta': i.recargo || 0, 'Total cobrado': i.total, Nota: i.nota })), [11, 22, 40, 14, 16, 14, 10, 12, 12, 40]);
        add('Gastos', db.gastos.filter(g => enAnio(g) && g.libro === 'LLC').map(g => { const c = db.categorias.find(x => x.name === g.categoria) || {};
            return { Fecha: asDate(g.fecha), Descripción: g.descripcion, Proveedor: g.proveedor, Categoría: g.categoria, Tipo: c.kind || 'Revisar', 'Línea 1065': c.form_line || '', Monto: g.monto,
                Deducible: g.categoria === 'Comidas de negocio (50%)' ? r2(g.monto / 2) : (['Costo de ventas', 'Gasto operativo', 'Activo'].includes(c.kind) ? g.monto : 0), 'Pagado por': g.pagado_por, Cuenta: g.cuenta, Nota: g.nota }; }), [11, 45, 20, 30, 15, 30, 12, 12, 14, 22, 40]);
        add('Activos Sec. 179', db.gastos.filter(g => enAnio(g) && g.libro === 'LLC' && catTipo(g.categoria) === 'Activo').map(g => ({ Activo: g.descripcion, 'Fecha en servicio': asDate(g.fecha), Costo: g.monto, 'Uso negocio': 1, 'Pagado por': g.pagado_por })), [45, 14, 12, 10, 14]);
        add('Impuesto ventas', trimestres().filter(q => q.meses.some(m => m.startsWith(anio))).map(q => { const r = trimestreData(q);
            return { Trimestre: r.label, 'Ventas servicios': r2(r.baseServ), 'Ventas productos': r2(r.baseProd), 'Impuesto servicios': r2(r.taxServ), 'Impuesto productos': r2(r.taxProd), 'Total a pagar': r.total, 'Fecha límite': asDate(r.vence) }; }));
        const est = []; SOCIOS.forEach(s => { let debe = 0; months().forEach(m => { const r = socioMes(s, m); debe += r.gastos - r.reembolsos;
            if (m.startsWith(anio)) est.push({ Socio: s, Mes: m, Aportes: r2(r.aportes), Retiros: r2(r.retiros), 'Gastos pagados': r2(r.gastos), 'Reembolsos recibidos': r2(r.reembolsos), 'LLC le debe (acumulado)': r2(debe) }); }); });
        add('Socios mensual', est);
        add('Por revisar', [...db.gastos.filter(g => enAnio(g) && g.libro === 'LLC' && (g.categoria === 'Revisar' || g.estado === 'Sin dato')).map(g => ({ Tipo: 'Gasto', Fecha: asDate(g.fecha), Detalle: g.descripcion, Monto: g.monto, Motivo: g.categoria === 'Revisar' ? 'Decidir si es del negocio' : 'Falta estado de reembolso' })),
            ...db.ingresos.filter(i => (enAnio(i) || !i.fecha) && i.monto == null).map(i => ({ Tipo: 'Ingreso', Fecha: asDate(i.fecha), Detalle: `${i.cliente}: ${i.servicio}`, Monto: '', Motivo: 'Falta monto o fecha' })),
            ...db.movimientos.filter(m => enAnio(m) && !m.confirmado).map(m => ({ Tipo: 'Socio', Fecha: asDate(m.fecha), Detalle: `${m.socio}: ${m.concepto}`, Monto: m.monto, Motivo: 'Movimiento sin confirmar' }))]);
        add('NJ fuera de la LLC', [...db.ingresos.filter(i => enAnio(i) && i.libro !== 'LLC' && !i.anulado).map(i => ({ Tipo: 'Ingreso', Fecha: asDate(i.fecha), Detalle: `${i.cliente}: ${i.servicio}`, Monto: i.monto })),
            ...db.gastos.filter(g => enAnio(g) && g.libro !== 'LLC').map(g => ({ Tipo: 'Gasto', Fecha: asDate(g.fecha), Detalle: g.descripcion, Monto: g.monto }))]);
        XLSX.writeFile(wb, `Piel Spa - reporte para la contadora ${anio}.xlsx`);
    }
    async function exportFormatoSheet() {
        try { await needXlsx(); } catch (e) { alert(e.message); return; }
        const wb = XLSX.utils.book_new(), mes = f => f ? asDate(f.slice(0, 7) + '-01') : '';
        XLSX.utils.book_append_sheet(wb, sheet(db.ingresos.map(i => ({ Fecha: asDate(i.fecha), Mes: mes(i.fecha), Cliente: i.cliente, 'Servicio realizado': i.servicio, Categoría: i.categoria,
            'Método de pago': i.metodo, Libro: i.anulado ? 'Anulado' : i.libro, 'Monto del servicio ($)': i.monto, 'Lleva impuesto': i.impuesto ? 'Sí' : 'No', 'Impuesto ($)': i.impuesto || 0,
            'Recargo tarjeta ($)': i.recargo || 0, 'Total cobrado ($)': i.total, Nota: i.nota, Origen: i.tabla === 'payments' ? 'Cobros' : 'Libro original' })), [11, 11, 22, 40, 16, 15, 20, 14, 10, 12, 12, 14, 50, 14]), 'Ingresos');
        XLSX.utils.book_append_sheet(wb, sheet(db.gastos.map(g => ({ Fecha: asDate(g.fecha), Mes: mes(g.fecha), Descripción: g.descripcion, Proveedor: g.proveedor, Categoría: g.categoria, Tipo: catTipo(g.categoria),
            Libro: g.libro, 'Monto ($)': g.monto, 'Cuenta / tarjeta': g.cuenta, 'Método original': '', 'Pagado por': g.pagado_por, 'Estado reembolso': g.estado, 'Fecha reembolso': asDate(g.fecha_reembolso),
            'Mes reembolso': g.estado === 'Reembolsado' ? mes(g.fecha_reembolso || g.fecha) : '', Reembolsable: reembolsable(g) ? 'Sí' : 'No', Nota: g.nota, Origen: g.source })), [11, 11, 45, 20, 30, 15, 20, 12, 22, 10, 14, 22, 12, 11, 11, 50, 12]), 'Gastos');
        XLSX.utils.book_append_sheet(wb, sheet(db.movimientos.map(m => ({ Fecha: asDate(m.fecha), Mes: mes(m.fecha), Socio: m.socio, Tipo: m.tipo, 'Monto ($)': m.monto, Concepto: m.concepto,
            Confirmado: m.confirmado ? 'Sí' : 'No', Origen: 'Contabilidad', Nota: m.nota })), [11, 11, 16, 26, 12, 50, 11, 14, 50]), 'Movimientos socios');
        XLSX.writeFile(wb, `Libro Contable PIEL SPA - datos ${today()}.xlsx`);
    }

    // ---------- Panel: the original Sheet's DASHBOARD, one column per month
    const GRUPOS = [['Costo de ventas', 'Costos variables (insumos y productos)'], ['Gasto operativo', 'Gastos fijos y operativos'],
        ['Activo', 'Equipo (activos)'], ['No deducible', 'No deducible'], ['No es gasto', 'No es gasto (depósitos)'], ['Revisar', 'Por revisar']];
    // Rows: {t:'h'|'r'|'tot'|'sep', label, v:{month:value}, cat?, mov?}
    function panelRows(ms) {
        const rows = [], z = () => Object.fromEntries(ms.map(m => [m, 0]));
        const add = (label, fn, extra = {}) => { const v = z(); ms.forEach(m => v[m] = r2(fn(m))); rows.push({ t: 'r', label, v, ...extra }); return v; };
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
            const vs = cats.map(c => add(c.name, m => gas(c.name, m), { cat: c.name }));
            grupoV[kind] = sum(...vs.map(v => ({ v })));
        });
        const totS = sum(...Object.values(grupoV).map(v => ({ v }))); rows.push({ t: 'tot', label: 'Total gastos', v: totS });
        const ret = add('Retiros de capital (socios)', m => mov('Retiro de capital', m));
        const pp = add('Pagos de préstamos a socios', m => mov('Pago de préstamo al socio', m));
        rows.push({ t: 'tot', label: 'Balance del mes (entradas − salidas)', v: sum({ v: totE }, { v: totS, sign: -1 }, { v: ret, sign: -1 }, { v: pp, sign: -1 }) });
        rows.push({ t: 'h', label: 'C · Resultado y K-1' });
        const res = sum({ v: ve }, { v: re }, { v: ot }, { v: grupoV['Costo de ventas'] || z(), sign: -1 }, { v: grupoV['Gasto operativo'] || z(), sign: -1 });
        rows.push({ t: 'tot', label: 'Resultado (ventas − costos − gastos operativos)', v: res });
        SOCIOS.forEach(s => { const v = z(); ms.forEach(m => v[m] = r2(res[m] * SHARE(s))); rows.push({ t: 'r', label: `${s} · ${SHARE(s) * 100}%`, v }); });
        rows.push({ t: 'h', label: 'D · Socios (saldo al cierre del mes)' });
        SOCIOS.forEach(s => add(`La LLC le debe a ${s}`, m => socioAcumulado(s, m).debe, { acum: true }));
        SOCIOS.forEach(s => add(`Capital de ${s}`, m => socioAcumulado(s, m).capital, { acum: true }));
        add('Impuesto cobrado (se paga al estado)', m => ingLLC(m).reduce((s, i) => s + (i.impuesto || 0), 0));
        return rows;
    }
    let pAnio = null, pMes = null;
    function viewPanel(body) {
        const todos = months(), anios = [...new Set(todos.map(m => m.slice(0, 4)))];
        if (!pAnio || (pAnio !== 'todo' && !anios.includes(pAnio))) pAnio = today().slice(0, 4);
        const ms = pAnio === 'todo' ? todos : todos.filter(m => m.startsWith(pAnio));
        if (!pMes || !ms.includes(pMes)) pMes = ms.includes(today().slice(0, 7)) ? today().slice(0, 7) : ms[ms.length - 1];
        const rows = panelRows(ms);
        const tot = r => r.acum ? r.v[ms[ms.length - 1]] : ms.reduce((s, m) => s + r.v[m], 0);
        const celda = (r, m) => r.cat && r.v[m] ? `<td class="num"><button class="hover:underline" onclick="Acc.irGastos('${esc(r.cat)}','${m}')">${money(r.v[m])}</button></td>` : cell(r.v[m]);
        const sticky = 'position:sticky;left:0;background:inherit;z-index:1';
        body.innerHTML = `<div class="card p-4 mb-4 flex flex-wrap items-end gap-3">
            <div class="w-32"><label class="lbl" for="acc-pa">Año</label><select id="acc-pa">${anios.map(a => `<option ${a === pAnio ? 'selected' : ''}>${a}</option>`).join('')}<option value="todo" ${pAnio === 'todo' ? 'selected' : ''}>Todo</option></select></div>
            <div class="w-40 md:hidden"><label class="lbl" for="acc-pm">Mes</label><select id="acc-pm">${ms.slice().reverse().map(m => `<option value="${m}" ${m === pMes ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')}</select></div>
            <p class="text-xs opacity-60 md:ml-auto">Como el DASHBOARD del Sheet. Toca un monto de gasto para ver el detalle. Solo libro LLC.</p></div>
          <div class="card overflow-hidden hidden md:block"><div class="overflow-x-auto"><table class="t">
            <thead><tr><th style="${sticky};background:#FDFBFC;z-index:2">Concepto</th>${ms.map(m => `<th class="num">${mesLabel(m)}</th>`).join('')}<th class="num">Total</th></tr></thead>
            <tbody>${rows.map(r => r.t === 'h' ? `<tr><td colspan="${ms.length + 2}" class="pt-5 font-bold text-[#B76E88] uppercase text-[11px] tracking-widest" style="background:#fff">${esc(r.label)}</td></tr>`
                : r.t === 'sub' ? `<tr><td colspan="${ms.length + 2}" class="text-[11px] font-semibold opacity-70" style="background:#FDFBFC">${esc(r.label)}</td></tr>`
                : `<tr class="${r.t === 'tot' ? 'font-bold' : ''}" style="background:${r.t === 'tot' ? '#FBF0F3' : '#fff'}"><td class="whitespace-nowrap" style="${sticky}">${esc(r.label)}</td>${ms.map(m => celda(r, m)).join('')}${cell(tot(r))}</tr>`).join('')}</tbody></table></div></div>
          <div class="md:hidden space-y-1">${rows.map(r => r.t === 'h' ? `<p class="pt-4 pb-1 font-bold text-[#B76E88] uppercase text-[11px] tracking-widest">${esc(r.label)}</p>`
                : r.t === 'sub' ? `<p class="pt-2 text-[12px] font-semibold opacity-70">${esc(r.label)}</p>`
                : (r.v[pMes] || r.t === 'tot') ? `<div class="flex justify-between gap-3 px-3 py-2 rounded-lg ${r.t === 'tot' ? 'bg-[#FBF0F3] font-bold' : 'bg-white border border-[#EDE1E7]'}" ${r.cat ? `onclick="Acc.irGastos('${esc(r.cat)}','${pMes}')"` : ''}><span class="text-sm">${esc(r.label)}</span><span class="num text-sm ${r.v[pMes] < 0 ? 'neg' : ''}">${money(r.v[pMes])}</span></div>` : '').join('')}
            <p class="text-[11px] opacity-60 pt-2">En el teléfono se muestra un mes; las filas en cero se ocultan.</p></div>`;
        $('acc-pa').onchange = e => { pAnio = e.target.value; render(); };
        $('acc-pm').onchange = e => { pMes = e.target.value; render(); };
    }
    function irGastos(cat, mes) { gf.q = ''; gf.cat = cat; gf.mes = mes; gf.pag = ''; gf.est = ''; view = 'gastos'; render(); }

    // ---------- Gastos fijos (monthly, created by acct_generate_recurring)
    function viewFijos(body) {
        const list = db.fijos;
        const mensual = list.filter(f => f.active).reduce((s, f) => s + Number(f.amount), 0);
        body.innerHTML = `<div class="card p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
            <p class="text-sm">Cada gasto fijo se crea solo cada mes el día indicado, como pendiente si lo paga un socio. Si un mes fue distinto, corrige ese gasto en Gastos.<br><b>${money(mensual)}</b> al mes en gastos fijos activos.</p>
            <button class="abtn rose" onclick="Acc.openFijo()">+ Gasto fijo</button></div>
          <div class="grid md:grid-cols-2 gap-3">${list.length ? list.map(f => `<div class="gcard" onclick="Acc.openFijo('${f.id}')">
              <div class="flex-1 min-w-0"><div class="flex justify-between gap-2"><p class="font-medium">${esc(f.description)}</p><p class="font-semibold whitespace-nowrap">${money(Number(f.amount))}</p></div>
              <p class="text-[12px] opacity-60">Día ${f.day_of_month} de cada mes · ${esc(f.category)}${f.vendor ? ' · ' + esc(f.vendor) : ''}</p>
              <div class="flex flex-wrap gap-1 mt-1"><span class="badge b-llc">${esc(f.paid_by)}</span>${f.active ? '<span class="badge b-ok">Activo</span>' : '<span class="badge b-pend">Pausado</span>'}<span class="text-[11px] opacity-60">desde ${fdate(f.starts_on)}${f.ends_on ? ' hasta ' + fdate(f.ends_on) : ''}</span></div></div></div>`).join('')
            : '<p class="text-sm opacity-60">Todavía no hay gastos fijos. Agrega la renta, Claude, el teléfono, el seguro…</p>'}</div>`;
    }
    function openFijo(id) {
        let dlg = $('acc-df');
        if (!dlg) {
            document.body.insertAdjacentHTML('beforeend', `<dialog id="acc-df" class="acc"><form id="acc-f-form" method="dialog" class="p-6 space-y-3">
              <h3 class="text-2xl italic" id="acc-f-title">Gasto fijo</h3><input type="hidden" id="acc-f-id">
              <div><label class="lbl" for="acc-f-desc">Descripción</label><input id="acc-f-desc" required placeholder="Ej. Renta del local, Claude, Tello"></div>
              <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="acc-f-monto">Monto al mes ($)</label><input id="acc-f-monto" inputmode="decimal" required></div>
                <div><label class="lbl" for="acc-f-dia">Día del mes</label><input id="acc-f-dia" inputmode="numeric" required></div></div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-f-cat">Categoría</label><select id="acc-f-cat"></select></div>
                <div><label class="lbl" for="acc-f-prov">Proveedor</label><input id="acc-f-prov"></div></div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="acc-f-pag">Lo paga</label><select id="acc-f-pag"><option>LLC</option><option>Freddy</option><option>Samuel</option><option>Ambos (50/50)</option></select></div>
                <div><label class="lbl" for="acc-f-cuenta">Cuenta / tarjeta</label><select id="acc-f-cuenta"></select></div></div>
              <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="acc-f-desde">Desde</label><input type="date" id="acc-f-desde" required></div>
                <div><label class="lbl" for="acc-f-hasta">Hasta (opcional)</label><input type="date" id="acc-f-hasta"></div></div>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="acc-f-act" class="accent-[#B76E88]"> Activo</label>
              <p class="text-[11px] opacity-60">Al guardar se crean los meses que ya pasaron desde la fecha "Desde". Si ya cargaste a mano algún mes, pon "Desde" en el mes siguiente.</p>
              <div class="dlg-actions flex justify-end gap-2 pt-2"><button type="button" class="soft" onclick="this.closest('dialog').close()">Cancelar</button><button class="abtn">Guardar</button></div>
            </form></dialog>`);
            dlg = $('acc-df');
            $('acc-f-form').addEventListener('submit', saveFijo);
        }
        const f = id ? db.fijos.find(x => x.id === id) : { description: '', amount: '', day_of_month: 1, category: 'Software y suscripciones', paid_by: 'LLC', account: 'Débito Chase Business', starts_on: today(), active: true };
        fill($('acc-f-cat'), db.categorias.filter(c => ['Gasto operativo', 'Costo de ventas'].includes(c.kind)).map(c => c.name));
        $('acc-f-title').textContent = id ? 'Editar gasto fijo' : 'Nuevo gasto fijo';
        $('acc-f-id').value = id || ''; $('acc-f-desc').value = f.description; $('acc-f-monto').value = f.amount; $('acc-f-dia').value = f.day_of_month;
        $('acc-f-cat').value = f.category; $('acc-f-prov').value = f.vendor || ''; $('acc-f-pag').value = f.paid_by; fillCuentas($('acc-f-cuenta'), f.account || 'Sin dato');
        $('acc-f-desde').value = f.starts_on; $('acc-f-hasta').value = f.ends_on || ''; $('acc-f-act').checked = !!f.active;
        dlg.showModal();
    }
    async function saveFijo(ev) {
        ev.preventDefault();
        const amount = amt($('acc-f-monto').value), dia = parseInt($('acc-f-dia').value, 10);
        if (!amount || amount <= 0) { alert('Escribe el monto.'); return; }
        if (!(dia >= 1 && dia <= 31)) { alert('El día debe estar entre 1 y 31.'); return; }
        const id = $('acc-f-id').value;
        const row = { description: $('acc-f-desc').value.trim(), amount, day_of_month: dia, category: $('acc-f-cat').value, vendor: $('acc-f-prov').value.trim() || null,
            paid_by: $('acc-f-pag').value, account: $('acc-f-cuenta').value, starts_on: $('acc-f-desde').value, ends_on: $('acc-f-hasta').value || null, active: $('acc-f-act').checked };
        const res = id ? await _supabase.from('acct_recurring').update(row).eq('id', id) : await _supabase.from('acct_recurring').insert({ ...row, created_by: await userId() });
        if (res.error) { alert('No se pudo guardar: ' + res.error.message); return; }
        const { data: n, error } = await _supabase.rpc('acct_generate_recurring');
        $('acc-df').close(); await refresh();
        toast(error ? 'Guardado. No se pudieron crear los meses: ' + error.message : n ? `Guardado. Se crearon ${n} gastos de meses que ya pasaron.` : 'Gasto fijo guardado.');
    }

    // ---------- Cierre del mes (printable: Imprimir → Guardar como PDF)
    function cierreMes(m) {
        let host = $('acc-cierre');
        if (!host) { document.body.insertAdjacentHTML('beforeend', '<dialog id="acc-cierre" class="acc" style="width:min(900px,calc(100vw - 16px))"><div class="p-4 flex justify-end gap-2 no-print border-b border-[#EDE1E7] sticky top-0 bg-white z-10"><button class="soft" onclick="this.closest(\'dialog\').close()">Cerrar</button><button class="abtn" onclick="Acc.imprimir()">Imprimir / PDF</button></div><div class="p-6 md:p-10 acc-print" id="acc-cierre-body"></div></dialog>'); host = $('acc-cierre'); }
        const rows = panelRows([m]), v = r => r.v ? r.v[m] : 0;
        const gas = db.gastos.filter(g => g.libro === 'LLC' && ym(g.fecha) === m).sort((a, b) => a.categoria.localeCompare(b.categoria) || a.fecha.localeCompare(b.fecha));
        const porCat = {}; gas.forEach(g => (porCat[g.categoria] = porCat[g.categoria] || []).push(g));
        const ing = db.ingresos.filter(i => !i.anulado && ym(i.fecha) === m).sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));
        const line = (a, b, cls = '') => `<div class="stmt-line ${cls}"><span>${a}</span><span class="num">${b}</span></div>`;
        const socio = s => { const ini = socioAcumulado(s, prevMonth(m)), r = socioMes(s, m);
            return `<div class="acc-nobreak"><h4 class="text-xl italic mt-2">${s}</h4>${line('Capital al inicio', money(ini.capital))}${line('(+) Aportes', money(r.aportes))}${line('(−) Retiros', money(r.retiros))}${line('Capital al final', money(ini.capital + r.aportes - r.retiros), 'total')}
              ${line('La LLC le debía al inicio', money(ini.debe))}${line('(+) Gastos que pagó', money(r.gastos))}${line('(−) Reembolsos recibidos', money(r.reembolsos))}${line('La LLC le debe al final', money(ini.debe + r.gastos - r.reembolsos), 'total')}</div>`; };
        $('acc-cierre-body').innerHTML = `
          <div class="flex flex-wrap items-start justify-between gap-4 mb-6"><div><p class="lbl">Piel Spa LLC · Cierre del mes</p><h2 class="text-4xl italic">${mesLargo(m)}</h2></div>
            <div class="text-right text-xs opacity-60">Generado ${fdate(today())}<br>Documento interno · Form 1065, socios 50/50</div></div>
          <div class="grid md:grid-cols-2 gap-8">
            <div class="acc-nobreak"><h3 class="text-2xl italic mb-2">Resumen</h3>${rows.filter(r => r.t !== 'h' && r.t !== 'sub' && (v(r) || r.t === 'tot')).map(r => line(esc(r.label), money(v(r)), r.t === 'tot' ? 'total' : '')).join('')}</div>
            <div><h3 class="text-2xl italic mb-2">Socios</h3>${SOCIOS.map(socio).join('')}</div>
          </div>
          <h3 class="text-2xl italic mt-8 mb-2">Gastos del mes (${gas.length})</h3>
          ${Object.entries(porCat).map(([c, list]) => `<div class="acc-nobreak mb-3"><p class="font-semibold text-sm flex justify-between"><span>${esc(c)}</span><span class="num">${money(list.reduce((s, g) => s + g.monto, 0))}</span></p>
            <table class="t"><tbody>${list.map(g => `<tr><td class="whitespace-nowrap">${fdate(g.fecha)}</td><td>${esc(g.descripcion)}</td><td class="text-xs">${esc(g.pagado_por)}</td><td class="num">${money(g.monto)}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<p class="text-sm opacity-60">Sin gastos.</p>'}
          <h3 class="text-2xl italic mt-8 mb-2">Ingresos del mes (${ing.length})</h3>
          ${ing.length ? `<table class="t"><thead><tr><th>Fecha</th><th>Cliente</th><th>Servicio</th><th>Método</th><th class="num">Venta</th><th class="num">Impuesto</th><th>Libro</th></tr></thead><tbody>${ing.map(i => `<tr><td class="whitespace-nowrap">${fdate(i.fecha)}</td><td>${esc(i.cliente)}</td><td class="text-xs">${esc(i.servicio)}</td><td class="text-xs">${esc(i.metodo)}</td><td class="num">${money(i.monto)}</td>${cell(i.impuesto || 0)}<td class="text-xs">${i.libro === 'LLC' ? 'LLC' : 'NJ fuera'}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm opacity-60">Sin ingresos.</p>'}
          <div class="grid grid-cols-2 gap-10 mt-16 acc-nobreak">${SOCIOS.map(s => `<div class="border-t border-[#2A2330] pt-2 text-sm">${s}<br><span class="text-xs opacity-60">Firma y fecha</span></div>`).join('')}</div>`;
        host.showModal();
    }

    // ---------- Google Sheets: the sheet pulls everything with its own key (tools/contabilidad-sheets-sync.gs)
    async function openSheets() {
        const { data: key, error } = await _supabase.rpc('accounting_sync_key');
        if (error) { alert(/accounting_sync_key/.test(error.message) ? 'Falta correr el SQL de supabase/migrations/20261121_accounting_fixed_and_sync.sql.' : error.message); return; }
        let dlg = $('acc-ds');
        if (!dlg) { document.body.insertAdjacentHTML('beforeend', `<dialog id="acc-ds" class="acc" style="width:min(640px,calc(100vw - 32px))"><div class="p-6 space-y-4 max-h-[85vh] overflow-y-auto" id="acc-ds-body"></div></dialog>`); dlg = $('acc-ds'); }
        const site = location.origin.includes('localhost') ? 'https://piel-spa.com' : location.origin;
        $('acc-ds-body').innerHTML = `<div class="flex items-start justify-between gap-3"><h3 class="text-3xl italic">Google Sheets</h3><button class="text-2xl opacity-40 hover:opacity-100 leading-none" onclick="this.closest('dialog').close()" aria-label="Cerrar">&times;</button></div>
          <p class="text-sm">El Sheet se actualiza solo cada 10 minutos con todo lo de Contabilidad: Panel, Gastos, Ingresos, Socios, Estado de socios y Gastos fijos. El día 1 de cada mes guarda el cierre del mes anterior en PDF en tu Google Drive.</p>
          <ol class="list-decimal pl-5 text-sm space-y-2">
            <li>Con la cuenta <b>pielspanyc@gmail.com</b>, abre <a class="underline text-[#B76E88]" href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a> y llámalo <b>Libro Contable PIEL SPA</b> (uno solo para todos los años; la primera carga llena las pestañas).</li>
            <li>Menú <b>Extensiones → Apps Script</b>. Borra lo que haya y pega el código de <a class="underline text-[#B76E88]" href="${esc(site)}/tools/contabilidad-sheets-sync.gs" target="_blank" rel="noopener">${esc(site)}/tools/contabilidad-sheets-sync.gs</a>. Guarda.</li>
            <li>Vuelve al Sheet y recarga la página. Aparece el menú <b>Piel Spa · Contabilidad</b>.</li>
            <li>Menú → <b>Configurar clave</b> y pega esta clave:
              <div class="flex gap-2 mt-1"><input readonly value="${esc(key)}" id="acc-ds-key" class="font-mono text-xs"><button class="soft" onclick="navigator.clipboard.writeText(document.getElementById('acc-ds-key').value).then(()=>this.textContent='Copiada')">Copiar</button></div></li>
            <li>Menú → <b>Activar actualización automática</b> y acepta los permisos de Google.</li>
            <li>Menú → <b>Actualizar ahora</b> para la primera carga.</li>
          </ol>
          <p class="text-[12px] opacity-70">Las pestañas que escribe el sistema terminan en "· Sistema" y se reescriben cada vez: no escribas en ellas. Tus otras pestañas no se tocan. La clave solo sirve para leer la contabilidad; no la compartas.</p>`;
        if (!dlg.open) dlg.showModal();
    }

    // ---------- iPhone: home-screen page and the "Gasto Piel" Shortcut
    const ATAJO_URL = 'https://qkjmrnqkoipdltauweub.supabase.co/functions/v1/gasto-atajo';
    async function sha256(v) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
    async function openIphone() {
        let dlg = $('acc-di');
        if (!dlg) {
            document.body.insertAdjacentHTML('beforeend', `<dialog id="acc-di" class="acc" style="width:min(680px,calc(100vw - 32px))"><div class="p-6 space-y-5 max-h-[85vh] overflow-y-auto" id="acc-di-body"></div></dialog>`);
            dlg = $('acc-di');
        }
        const { data: toks, error } = await _supabase.from('acct_shortcut_tokens').select('id, partner, label, default_account, created_at, last_used_at').is('revoked_at', null).order('created_at');
        if (error) { alert(/acct_shortcut/.test(error.message) ? 'Falta correr el SQL de supabase/migrations/20261121_accounting_shortcut.sql.' : error.message); return; }
        const site = location.origin.includes('localhost') ? 'https://piel-spa.com' : location.origin;
        $('acc-di-body').innerHTML = `
          <div class="flex items-start justify-between gap-3"><h3 class="text-3xl italic">Gastos desde el iPhone</h3><button class="text-2xl opacity-40 hover:opacity-100 leading-none" onclick="this.closest('dialog').close()" aria-label="Cerrar">&times;</button></div>
          <div class="card p-4 space-y-2"><p class="lbl">Opción 1 · Ícono en la pantalla (lo más simple)</p>
            <ol class="list-decimal pl-5 text-sm space-y-1"><li>En el iPhone abre <b>${esc(site)}/gasto.html</b> en Safari e inicia sesión con tu usuario del admin.</li>
            <li>Toca Compartir <span aria-hidden="true">⬆︎</span> → <b>Agregar a inicio</b>. Queda como la app "Gasto Piel".</li></ol>
            <p class="text-[12px] opacity-70">Se abre directo en el formulario: monto, qué compraste, categoría, quién pagó y foto.</p></div>
          <div class="card p-4 space-y-3"><p class="lbl">Opción 2 · Widget de Atajos y Siri (sin abrir nada)</p>
            <p class="text-sm">Un toque en el widget (o "Oye Siri, Gasto Piel") te pregunta el monto, qué compraste, la categoría y si quieres foto, y lo guarda. Cada teléfono necesita su propio código.</p>
            <div class="grid grid-cols-3 gap-2 items-end">
              <div><label class="lbl" for="acc-di-p">Teléfono de</label><select id="acc-di-p"><option>Freddy</option><option>Samuel</option><option value="LLC">La LLC</option></select></div>
              <div><label class="lbl" for="acc-di-c">Tarjeta que más usa</label><select id="acc-di-c"></select></div>
              <button class="abtn" onclick="Acc.crearCodigo()">Crear código</button></div>
            <div id="acc-di-new"></div>
            ${(toks || []).length ? `<table class="t"><thead><tr><th>Teléfono</th><th>Tarjeta</th><th>Creado</th><th>Último uso</th><th></th></tr></thead><tbody>${toks.map(t => `<tr><td>${esc(t.label || t.partner)}</td><td class="text-xs">${esc(t.default_account || '')}</td><td class="text-xs">${fdate(t.created_at.slice(0, 10))}</td><td class="text-xs">${t.last_used_at ? fdate(t.last_used_at.slice(0, 10)) : '—'}</td><td><button class="text-xs text-red-700 hover:underline" onclick="Acc.revocarCodigo('${t.id}')">Desactivar</button></td></tr>`).join('')}</tbody></table>` : '<p class="text-xs opacity-60">Todavía no hay códigos.</p>'}
          </div>
          <details class="card p-4" open><summary class="lbl cursor-pointer">Cómo armar el atajo "Gasto Piel" (una sola vez por teléfono)</summary>
            <ol class="list-decimal pl-5 text-sm space-y-2 mt-3">
              <li>Abre la app <b>Atajos</b> → <b>+</b> → ponle de nombre <b>Gasto Piel</b>.</li>
              <li>Agrega <b>Solicitar entrada</b> · tipo <b>Número</b> · pregunta "Monto".</li>
              <li>Agrega <b>Solicitar entrada</b> · tipo <b>Texto</b> · pregunta "¿Qué compraste?".</li>
              <li>Agrega <b>Lista</b> con: <code>Insumos, Envíos, Transporte, Comidas, Equipo menor, Software, Limpieza, Reventa, Otro</code>. Debajo, <b>Elegir de la lista</b> · pregunta "Categoría".</li>
              <li>Agrega <b>Elegir del menú</b> · pregunta "¿Foto del recibo?" · opciones <b>Sí</b> y <b>No</b>. Dentro de "Sí" pon <b>Tomar foto</b>. Deja "No" vacío.</li>
              <li>Agrega <b>Obtener contenido de URL</b>: URL <code class="break-all">${ATAJO_URL}</code> · Método <b>POST</b> · Encabezados: <code>x-gasto-token</code> = tu código · Cuerpo <b>Formulario</b> con los campos:
                <code>monto</code> = Entrada proporcionada (la 1.ª), <code>descripcion</code> = Entrada proporcionada (la 2.ª), <code>categoria</code> = Elemento elegido, <code>foto</code> (tipo Archivo) = Resultado del menú.</li>
              <li>Agrega <b>Mostrar notificación</b> con "Contenido de la URL". Ahí sale "✅ Guardado…".</li>
              <li>Para el widget: mantén presionada la pantalla de inicio → <b>+</b> → <b>Atajos</b> → elige <b>Gasto Piel</b>.</li>
            </ol>
            <p class="text-[12px] opacity-70 mt-3">Si pagó otro socio o la LLC, puedes agregar un campo <code>pagado_por</code> (Freddy, Samuel o LLC). Todo lo del atajo entra como pendiente de reembolso y se corrige en Gastos si hace falta.</p>
          </details>`;
        fillCuentas($('acc-di-c'), 'Chase Ink Business');
        if (!dlg.open) dlg.showModal();
    }
    async function crearCodigo() {
        const partner = $('acc-di-p').value, cuenta = $('acc-di-c').value;
        const bytes = crypto.getRandomValues(new Uint8Array(24));
        const token = 'gp_' + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': 'x', '/': 'y', '=': '' }[c]));
        const { error } = await _supabase.from('acct_shortcut_tokens').insert({ token_hash: await sha256(token), user_id: await userId(), partner,
            default_account: cuenta, label: partner === 'LLC' ? 'Teléfono de la LLC' : `iPhone de ${partner}` });
        if (error) { alert('No se pudo crear: ' + error.message); return; }
        await openIphone();
        $('acc-di-new').innerHTML = `<div class="border-2 border-[#B76E88] rounded-xl p-3 space-y-2"><p class="text-sm font-semibold">Código para el iPhone de ${esc(partner)}. Cópialo ahora: no se vuelve a mostrar.</p>
          <div class="flex gap-2"><input readonly value="${esc(token)}" id="acc-di-tok" class="font-mono text-xs"><button class="soft" onclick="navigator.clipboard.writeText(document.getElementById('acc-di-tok').value).then(()=>this.textContent='Copiado')">Copiar</button></div>
          <p class="text-[11px] opacity-70">Pégalo en el encabezado <code>x-gasto-token</code> del atajo (paso 6). Mándatelo por AirDrop o Notas, no por WhatsApp.</p></div>`;
    }
    async function revocarCodigo(id) {
        if (!confirm('¿Desactivar este código? El atajo de ese teléfono deja de funcionar.')) return;
        const { error } = await _supabase.from('acct_shortcut_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
        if (error) { alert(error.message); return; }
        openIphone();
    }

    window.Acc = { open, refresh, irGastos, openFijo, cierreMes, openSheets, openIphone, crearCodigo, revocarCodigo, masGastos, toggleFiltros, clearSel, sortBy, toggleSel, selAll, bulkSet, openGasto, delGasto, verRecibo, openMov, delMov, verEstado, imprimir,
        guardarConciliacion, irACobros, depAporte, exportContadora, exportFormatoSheet };
})();
