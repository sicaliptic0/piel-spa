// "Productos y servicios" (admin-only). Productos = public.sale_products: what Piel Spa sells,
// with prices, stock and expiry. Servicios = public.sale_services.
// Loaded by admin.html after its main script; renders into #products-view; handlers on window.Prod.
(function () {
    'use strict';
    const CATEGORIAS = ['Protector solar', 'Limpiador', 'Sérum', 'Crema', 'Contorno de ojos', 'Tratamiento', 'Mascarilla', 'Kit', 'Otro'];
    const VENCE_PRONTO_DIAS = 60;
    let rows = [], built = false, tab = 'productos', filtro = 'todos', q = '', verEliminados = false;
    const SERVICE_STATUS = { available: 'Disponible', assessment: 'Tras valoración', soon: 'Próximamente', pending: 'Pendiente', category: 'Categoría' };
    const WEB_SERVICE_GROUPS = ['Consulta', 'Mantenimiento de mi piel', 'Manchas y melasma', 'Acné y brotes', 'Textura y poros',
        'Vello no deseado', 'Relajación y drenaje', 'Arrugas', 'Flacidez', 'Luminosidad e hidratación', 'Pérdida de volumen', 'Ojeras'];
    const groupRank = category => WEB_SERVICE_GROUPS.includes(category) ? WEB_SERVICE_GROUPS.indexOf(category) : WEB_SERVICE_GROUPS.length;
    let services = [], serviceError = '', showArchived = false, request = 0;
    let serviceBusy = false;
    const selectedServices = new Set();

    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = n => n == null || n === '' ? '–' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const today = () => (typeof clinicDateIso === 'function' ? clinicDateIso(0) : new Date().toISOString().slice(0, 10));
    const fdate = d => d ? d.split('-').reverse().join('/') : '';
    const num = s => { const t = String(s ?? '').replace(/[$,\s]/g, ''); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
    const diasPara = d => d ? Math.round((new Date(d + 'T12:00:00') - new Date(today() + 'T12:00:00')) / 86400000) : null;
    const precio = p => p.sale_price ?? p.suggested_price;
    const margen = p => { const pv = precio(p), c = p.cost; return pv && c != null ? Math.round((pv - c) / pv * 100) : null; };
    function toast(msg) {
        let t = $('prod-toast');
        if (!t) { t = document.createElement('div'); t.id = 'prod-toast'; t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#2A2330] text-white text-sm px-4 py-2 rounded-full z-[90] pointer-events-none'; t.style.transition = 'opacity .3s'; document.body.appendChild(t); }
        t.textContent = msg; t.style.opacity = 1; clearTimeout(t._h); t._h = setTimeout(() => t.style.opacity = 0, 2400);
    }
    function estado(p) {
        const out = [];
        const d = diasPara(p.expires_on);
        if (d != null && d < 0) out.push(['Vencido', 'b-red']);
        else if (d != null && d <= VENCE_PRONTO_DIAS) out.push([`Vence en ${d} días`, 'b-amber']);
        if (p.stock_qty <= 0) out.push(['Sin stock', 'b-red']);
        else if (p.min_stock != null && p.stock_qty <= p.min_stock) out.push(['Stock bajo', 'b-amber']);
        if (!p.sales_taxable) out.push(['Sin sales tax', 'b-grey']);
        if (!p.active) out.push(['Eliminado', 'b-grey']);
        return out.map(([t, c]) => `<span class="pbadge ${c}">${esc(t)}</span>`).join('');
    }

    const CSS = `
      .prod .card { background:#fff; border:1px solid #EDE1E7; border-radius:14px; }
      .prod .lbl { font-size:9px; text-transform:uppercase; letter-spacing:.1em; font-weight:700; color:#B76E88; }
      .prod .sub { padding:7px 14px; font-size:10px; text-transform:uppercase; letter-spacing:.12em; border-radius:99px; border:1px solid #EDE1E7; background:#fff; white-space:nowrap; }
      .prod .sub.on { background:#2A2330; color:#fff; border-color:#2A2330; font-weight:700; }
      .prod .pbtn { background:#B76E88; color:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.12em; font-weight:700; padding:9px 18px; border-radius:99px; }
      .prod .pbtn.dark { background:#2A2330; }
      .prod .soft { border:1px solid #EDE1E7; background:#fff; font-size:10px; text-transform:uppercase; letter-spacing:.1em; font-weight:600; padding:8px 14px; border-radius:99px; }
      .prod .pbadge { font-size:9px; padding:2px 8px; border-radius:99px; text-transform:uppercase; font-weight:700; white-space:nowrap; }
      .prod .b-red { background:#F8D4D4; color:#7A1F1F; } .prod .b-amber { background:#FEF3C7; color:#92400E; } .prod .b-grey { background:#EDE1E7; color:#2A2330; }
      .prod table.t { width:100%; font-size:13px; border-collapse:collapse; }
      .prod table.t th { text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.1em; color:#8A7F8F; font-weight:700; padding:8px 10px; border-bottom:1px solid #EDE1E7; background:#FDFBFC; white-space:nowrap; }
      .prod table.t td { padding:9px 10px; border-bottom:1px solid #F4EDF1; vertical-align:top; }
      .prod table.t tbody tr { cursor:pointer; } .prod table.t tbody tr:hover td { background:#FDF7FA; }
      .prod .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; } .prod th.num { text-align:right; }
      .prod .svc-grip { cursor:grab; padding:6px; font-size:18px; color:#71364c; }
      .prod .svc-order { min-width:32px; min-height:32px; border-radius:6px; }
      .prod .svc-order:hover:not(:disabled) { background:#F4EDF1; }
      .prod .svc-order:disabled { opacity:.25; }
      .prod .svc-drop-before { box-shadow:inset 0 2px #B76E88; }
      .prod .svc-drop-after { box-shadow:inset 0 -2px #B76E88; }
      .prod table.t tbody tr.brand-row { cursor:default; } .prod table.t tbody tr.brand-row td, .prod table.t tbody tr.brand-row:hover td { background:#FBF0F3; }
      .prod .pcard { background:#fff; border:1px solid #EDE1E7; border-radius:12px; padding:12px; cursor:pointer; }
      dialog.prod { border:none; border-radius:16px; padding:0; width:min(620px, calc(100vw - 32px)); }
      dialog.prod::backdrop { background:rgba(42,35,48,.35); }
      @media (max-width:767px) { .prod input, .prod select, .prod textarea { font-size:16px !important; }
        dialog.prod { width:100vw; max-width:100vw; height:100dvh; max-height:100dvh; margin:0; border-radius:0; }
        dialog.prod .dlg-actions { position:sticky; bottom:0; background:#fff; padding:12px 0 calc(12px + env(safe-area-inset-bottom)); border-top:1px solid #EDE1E7; } }`;

    function build() {
        if (built) return; built = true;
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
        const root = $('products-view'); root.classList.add('prod');
        root.innerHTML = `<div class="max-w-6xl mx-auto">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-5">
              <div class="flex gap-2"><button class="sub" data-t="productos">Productos</button><button class="sub" data-t="servicios">Servicios</button></div>
              <button class="pbtn" id="prod-add" onclick="Prod.add()">+ Producto</button>
            </div>
            <div id="prod-body"><p class="text-sm opacity-50 text-center py-10">Cargando…</p></div></div>`;
        root.querySelectorAll('.sub').forEach(b => b.onclick = () => { tab = b.dataset.t; return open(); });
        document.body.insertAdjacentHTML('beforeend', DIALOG + SERVICE_DIALOG);
        $('prod-form').addEventListener('submit', guardar);
        $('svc-form').addEventListener('submit', saveService);
    }
    async function open() {
        build();
        const current = ++request;
        updateTabs();
        $('prod-body').innerHTML = '<p class="text-sm opacity-60 text-center py-8">Cargando…</p>';
        if (tab === 'servicios') {
            const { data, error } = await _supabase.from('sale_services').select('*').order('sort_order').order('name').order('code');
            if (current !== request) return;
            services = data || [];
            serviceError = error ? error.message : '';
            renderServices();
            return;
        }
        const { data, error } = await _supabase.from('sale_products').select('*').order('brand').order('name');
        if (current !== request) return;
        if (error) { $('prod-body').innerHTML = `<p class="text-sm text-red-500 text-center py-8">${esc(/sale_products/.test(error.message) ? 'Falta correr el SQL de supabase/migrations/20261121_sale_products.sql.' : error.message)}</p>`; return; }
        rows = data || [];
        render();
    }

    function updateTabs() {
        document.querySelectorAll('#products-view .sub').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
        $('prod-add').textContent = tab === 'servicios' ? '+ Servicio' : '+ Producto';
    }

    function grupos(list) {
        const m = new Map();
        list.slice().sort((a, b) => a.brand.localeCompare(b.brand, 'es', { sensitivity: 'base' }) || a.name.localeCompare(b.name, 'es'))
            .forEach(p => { const k = p.brand.trim().toLowerCase(); if (!m.has(k)) m.set(k, [p.brand.trim(), []]); m.get(k)[1].push(p); });
        return [...m.values()];
    }
    const resumenMarca = items => {
        const u = items.reduce((s, p) => s + Math.max(0, p.stock_qty), 0), c = items.reduce((s, p) => s + Math.max(0, p.stock_qty) * Number(p.cost || 0), 0);
        return `${items.length} ${items.length === 1 ? 'producto' : 'productos'} · ${u} en stock · ${money(c)} al costo`;
    };

    function render() {
        const activos = rows.filter(p => p.active);
        const unidades = activos.reduce((s, p) => s + Math.max(0, p.stock_qty), 0);
        const alCosto = activos.reduce((s, p) => s + Math.max(0, p.stock_qty) * Number(p.cost || 0), 0);
        const alPrecio = activos.reduce((s, p) => s + Math.max(0, p.stock_qty) * Number(precio(p) || 0), 0);
        const porVencer = activos.filter(p => { const d = diasPara(p.expires_on); return d != null && d <= VENCE_PRONTO_DIAS; }).length;
        const bajo = activos.filter(p => p.stock_qty <= 0 || (p.min_stock != null && p.stock_qty <= p.min_stock)).length;
        const k = [['Productos a la venta', activos.length, ''], ['Unidades en stock', unidades, ''], ['Inventario al costo', money(alCosto), 'para el cierre de año'],
            ['Inventario a precio de venta', money(alPrecio), ''], ['Por vencer o vencidos', porVencer, `${VENCE_PRONTO_DIAS} días o menos`], ['Stock bajo o agotado', bajo, '']];
        const term = q.toLowerCase();
        const list = rows.filter(p => (verEliminados || p.active) && (!term || `${p.brand} ${p.name} ${p.sku || ''} ${p.category || ''}`.toLowerCase().includes(term))
            && (filtro === 'todos' || (filtro === 'vencer' && (() => { const d = diasPara(p.expires_on); return d != null && d <= VENCE_PRONTO_DIAS; })())
                || (filtro === 'stock' && (p.stock_qty <= 0 || (p.min_stock != null && p.stock_qty <= p.min_stock)))));
        $('prod-body').innerHTML = `
          <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">${k.map(([a, b, c]) => `<div class="card p-3"><p class="lbl">${a}</p><p class="text-xl font-semibold mt-1">${b}</p>${c ? `<p class="text-[11px] opacity-60">${c}</p>` : ''}</div>`).join('')}</div>
          <div class="card p-3 mb-4 flex flex-wrap gap-3 items-end">
            <div class="flex-1 min-w-[180px]"><label class="lbl" for="prod-q">Buscar</label><input id="prod-q" type="search" placeholder="Marca, producto o código" value="${esc(q)}"></div>
            <div><label class="lbl" for="prod-f">Mostrar</label><select id="prod-f"><option value="todos">Todos</option><option value="vencer">Por vencer</option><option value="stock">Stock bajo</option></select></div>
            <label class="flex items-center gap-2 text-xs pb-2"><input type="checkbox" id="prod-del" class="accent-[#B76E88]" ${verEliminados ? 'checked' : ''}> Ver eliminados</label>
          </div>
          <div class="card overflow-hidden hidden md:block"><div class="overflow-x-auto"><table class="t"><thead><tr><th>Marca</th><th>Producto</th><th>Categoría</th><th class="num">Precio sugerido</th><th class="num">Precio Piel Spa</th><th class="num">Costo</th><th class="num">Margen</th><th class="num">Stock</th><th>Vence</th><th></th></tr></thead><tbody>
            ${grupos(list).map(([marca, items]) => `<tr class="brand-row"><td colspan="10"><span class="font-bold">${esc(marca)}</span> <span class="text-[11px] opacity-60">· ${resumenMarca(items)}</span></td></tr>` + items.map(p => `<tr onclick="Prod.abrir('${p.id}')" class="${p.active ? '' : 'opacity-50'}"><td class="text-xs whitespace-nowrap opacity-70">${esc(p.brand)}</td><td><div class="font-medium">${esc(p.name)}</div><div class="text-[11px] opacity-60">${p.size ? esc(p.size) : ''}${p.sku ? (p.size ? ' · ' : '') + esc(p.sku) : ''}</div></td>
              <td class="text-xs">${esc(p.category || '')}</td><td class="num">${money(p.suggested_price)}</td><td class="num font-semibold">${money(p.sale_price)}</td><td class="num">${money(p.cost)}</td>
              <td class="num">${margen(p) != null ? margen(p) + '%' : '–'}</td><td class="num">${p.stock_qty}</td><td class="whitespace-nowrap text-xs">${fdate(p.expires_on)}</td><td><div class="flex flex-wrap gap-1">${estado(p)}</div></td></tr>`).join('')).join('')}
          </tbody></table></div></div>
          <div class="md:hidden space-y-2">${grupos(list).map(([marca, items]) => `<p class="pt-3 pb-1 font-bold text-[#B76E88] uppercase text-[11px] tracking-widest">${esc(marca)} <span class="normal-case tracking-normal font-normal opacity-70">· ${resumenMarca(items)}</span></p>` + items.map(p => `<div class="pcard ${p.active ? '' : 'opacity-50'}" onclick="Prod.abrir('${p.id}')">
              <div class="flex justify-between gap-2"><div class="min-w-0"><p class="font-medium leading-snug">${esc(p.name)}</p><p class="text-[12px] opacity-60">${esc(p.brand)}${p.size ? ' · ' + esc(p.size) : ''}</p></div>
              <div class="text-right"><p class="font-semibold">${money(precio(p))}</p><p class="text-[11px] opacity-60">${p.stock_qty} en stock</p></div></div>
              <div class="flex flex-wrap gap-1 mt-1.5">${estado(p)}${p.expires_on ? `<span class="text-[11px] opacity-60">vence ${fdate(p.expires_on)}</span>` : ''}</div></div>`).join('')).join('')}</div>
          ${list.length ? '' : '<p class="text-sm opacity-60 text-center py-8">No hay productos con este filtro.</p>'}
          <p class="text-[12px] opacity-60 mt-4">Los protectores solares están sin sales tax, como indicaron. Confírmenlo con la contadora: en NY depende de si se venden como medicamento OTC (con "Drug Facts") o como cosmético. El inventario al costo del 31 de diciembre es el que pide la contadora para el costo de ventas.</p>`;
        $('prod-q').oninput = e => { q = e.target.value; const pos = e.target.selectionStart; render(); const el = $('prod-q'); el.focus(); el.setSelectionRange(pos, pos); };
        $('prod-f').value = filtro; $('prod-f').onchange = e => { filtro = e.target.value; render(); };
        $('prod-del').onchange = e => { verEliminados = e.target.checked; render(); };
    }

    const DIALOG = `<dialog id="prod-dlg" class="prod"><form id="prod-form" method="dialog" class="p-6 space-y-3">
        <h3 class="text-2xl italic" id="prod-title" style="font-family:'Cormorant Garamond',serif">Producto</h3><input type="hidden" id="pf-id">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="lbl" for="pf-brand">Marca</label><input id="pf-brand" required placeholder="mesoestetic, Colorescience…" list="pf-brands"><datalist id="pf-brands"></datalist></div>
          <div><label class="lbl" for="pf-cat">Categoría</label><select id="pf-cat">${CATEGORIAS.map(c => `<option>${c}</option>`).join('')}</select></div></div>
        <div><label class="lbl" for="pf-name">Producto</label><input id="pf-name" required></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="pf-size">Tamaño</label><input id="pf-size" placeholder="50 ml"></div>
          <div><label class="lbl" for="pf-sku">Código / SKU</label><input id="pf-sku" placeholder="Opcional"></div></div>
        <div class="grid grid-cols-3 gap-3"><div><label class="lbl" for="pf-sug">Precio sugerido</label><input id="pf-sug" inputmode="decimal" placeholder="$"></div>
          <div><label class="lbl" for="pf-price">Precio Piel Spa</label><input id="pf-price" inputmode="decimal" placeholder="$"></div>
          <div><label class="lbl" for="pf-cost">Costo</label><input id="pf-cost" inputmode="decimal" placeholder="$"></div></div>
        <p class="text-[11px] opacity-60" id="pf-margin"></p>
        <div class="grid grid-cols-3 gap-3"><div><label class="lbl" for="pf-stock">Cantidad en stock</label><input id="pf-stock" inputmode="numeric"></div>
          <div><label class="lbl" for="pf-min">Avisar con</label><input id="pf-min" inputmode="numeric" placeholder="ej. 2"></div>
          <div><label class="lbl" for="pf-exp">Vence</label><input id="pf-exp" type="date"></div></div>
        <div class="grid grid-cols-2 gap-3"><div><label class="lbl" for="pf-lot">Lote</label><input id="pf-lot" placeholder="Opcional"></div>
          <div><label class="lbl" for="pf-sup">Proveedor</label><input id="pf-sup" list="pf-sups"><datalist id="pf-sups"></datalist></div></div>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="pf-tax" class="accent-[#B76E88] w-5 h-5"> Lleva sales tax al venderlo</label>
        <div><label class="lbl" for="pf-notes">Notas</label><textarea id="pf-notes" rows="2" placeholder="Para quién es, cómo se usa, dónde está guardado…"></textarea></div>
        <div class="dlg-actions flex justify-between gap-2 pt-2"><button type="button" class="soft text-red-700" id="pf-del" onclick="Prod.eliminar()">Eliminar</button>
          <div class="flex gap-2"><button type="button" class="soft" onclick="this.closest('dialog').close()">Cancelar</button><button class="pbtn dark" id="pf-save">Guardar</button></div></div>
      </form></dialog>`;
    function abrir(id) {
        const p = id ? rows.find(x => x.id === id) : { brand: '', name: '', category: 'Protector solar', stock_qty: 0, sales_taxable: true, active: true };
        $('prod-title').textContent = id ? 'Editar producto' : 'Nuevo producto';
        $('pf-brands').innerHTML = [...new Set(rows.map(r => r.brand))].map(b => `<option value="${esc(b)}">`).join('');
        $('pf-sups').innerHTML = [...new Set(rows.map(r => r.supplier).filter(Boolean))].map(b => `<option value="${esc(b)}">`).join('');
        $('pf-id').value = id || ''; $('pf-brand').value = p.brand || ''; $('pf-name').value = p.name || ''; $('pf-size').value = p.size || ''; $('pf-sku').value = p.sku || '';
        $('pf-cat').value = CATEGORIAS.includes(p.category) ? p.category : 'Otro';
        $('pf-sug').value = p.suggested_price ?? ''; $('pf-price').value = p.sale_price ?? ''; $('pf-cost').value = p.cost ?? '';
        $('pf-stock').value = p.stock_qty ?? 0; $('pf-min').value = p.min_stock ?? ''; $('pf-exp').value = p.expires_on || ''; $('pf-lot').value = p.lot || '';
        $('pf-sup').value = p.supplier || ''; $('pf-tax').checked = p.sales_taxable !== false; $('pf-notes').value = p.notes || '';
        $('pf-del').textContent = p.active === false ? 'Volver a poner a la venta' : 'Eliminar';
        $('pf-del').classList.toggle('invisible', !id);
        margenInfo();
        ['pf-price', 'pf-cost', 'pf-sug'].forEach(i => $(i).oninput = margenInfo);
        $('prod-dlg').showModal();
    }
    function margenInfo() {
        const pv = num($('pf-price').value) ?? num($('pf-sug').value), c = num($('pf-cost').value);
        $('pf-margin').textContent = pv && c != null && !isNaN(pv) && !isNaN(c) ? `Ganancia por unidad ${money(pv - c)} · margen ${Math.round((pv - c) / pv * 100)}%` : '';
    }
    async function guardar(ev) {
        ev.preventDefault();
        const vals = { suggested_price: num($('pf-sug').value), sale_price: num($('pf-price').value), cost: num($('pf-cost').value) };
        if (Object.values(vals).some(v => Number.isNaN(v))) { alert('Los precios deben ser números, por ejemplo 55 o 55.50.'); return; }
        const stock = parseInt($('pf-stock').value || '0', 10), min = $('pf-min').value.trim() === '' ? null : parseInt($('pf-min').value, 10);
        if (isNaN(stock) || stock < 0 || (min !== null && (isNaN(min) || min < 0))) { alert('La cantidad y el aviso deben ser números enteros.'); return; }
        const id = $('pf-id').value;
        const row = { brand: $('pf-brand').value.trim(), name: $('pf-name').value.trim(), size: $('pf-size').value.trim() || null, sku: $('pf-sku').value.trim() || null,
            category: $('pf-cat').value, ...vals, stock_qty: stock, min_stock: min, expires_on: $('pf-exp').value || null, lot: $('pf-lot').value.trim() || null,
            supplier: $('pf-sup').value.trim() || null, sales_taxable: $('pf-tax').checked, notes: $('pf-notes').value.trim() || null, updated_at: new Date().toISOString() };
        const btn = $('pf-save'); btn.disabled = true;
        const res = id ? await _supabase.from('sale_products').update(row).eq('id', id)
            : await _supabase.from('sale_products').insert({ ...row, created_by: (await _supabase.auth.getUser()).data.user?.id || null });
        btn.disabled = false;
        if (res.error) { alert('No se pudo guardar: ' + res.error.message); return; }
        $('prod-dlg').close(); toast('Producto guardado.'); open();
        if (typeof loadPayProducts === 'function') loadPayProducts();
    }
    async function eliminar() {
        const id = $('pf-id').value, p = rows.find(x => x.id === id); if (!p) return;
        const volver = p.active === false;
        if (!volver && !confirm(`¿Quitar "${p.name}" de la venta? Deja de salir en Cobros; las ventas que ya tuvo se conservan.`)) return;
        const { error } = await _supabase.from('sale_products').update({ active: volver, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) { alert('No se pudo cambiar: ' + error.message); return; }
        $('prod-dlg').close(); toast(volver ? 'Producto de nuevo a la venta.' : 'Producto eliminado de la venta.'); open();
        if (typeof loadPayProducts === 'function') loadPayProducts();
    }

    function renderServices() {
        if (serviceError) {
            $('prod-body').innerHTML = `<p class="text-sm text-red-700 py-4" role="alert">No se pudo cargar Servicios. ${esc(serviceError)}</p>`;
            return;
        }
        const visible = services.filter(s => s.active !== showArchived).sort((a, b) =>
            groupRank(a.category) - groupRank(b.category) || a.category.localeCompare(b.category, 'es'));
        const visibleCodes = new Set(visible.map(s => s.code));
        for (const code of selectedServices) if (!visibleCodes.has(code)) selectedServices.delete(code);
        const action = showArchived ? 'Desarchivar' : 'Archivar';
        const disabled = serviceBusy ? 'disabled' : '';
        $('prod-body').innerHTML = `
          <div class="card p-4 mb-4 text-sm space-y-2">
            <p>Montos en USD por la unidad indicada. NYC es una referencia de mercado basada en una muestra pequeña. Tarifario interno muestra importes por confirmar.</p>
            <p>En Cobros, elige el servicio y confirma el monto acordado. Usa el precio Piel Spa o la promoción si corresponde. Si solo realiza la consulta, registra su tarifa. Si realiza un tratamiento, registra el tratamiento una sola vez con la consulta incluida.</p>
            <p>El pago registrado aparece en Contabilidad → Ingresos. Guarda el comprobante y usa el registro de Cobros al conciliar para evitar duplicados.</p>
          </div>
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="svc-archived" ${showArchived ? 'checked' : ''} ${disabled}> Solo archivados</label>
            <button class="soft" type="button" id="svc-bulk" disabled>${action} seleccionados</button>
            <span class="text-sm opacity-70" id="svc-count" aria-live="polite"></span>
          </div>
          ${!showArchived && visible.length > 1 ? '<p class="text-xs opacity-70 mb-3">Arrastra por el asa o usa Subir y Bajar para ordenar dentro de cada categoría. Puedes arrastrar juntas las filas marcadas de la misma categoría.</p>' : ''}
          ${visible.length ? `<div class="card overflow-x-auto"><table class="t">
            <thead><tr><th><input type="checkbox" id="svc-select-all" aria-label="Seleccionar todos los servicios visibles" ${disabled}></th>${showArchived ? '' : '<th>Orden</th>'}<th>Servicio</th><th>Estado</th><th class="num">Sugerido NYC</th><th class="num">Precio Piel Spa</th><th class="num">Promoción</th><th class="num">Tarifario interno</th><th><span class="sr-only">Acciones</span></th></tr></thead>
            <tbody>${visible.map((s, index) => `${visible[index - 1]?.category !== s.category ? `<tr><th colspan="${showArchived ? 8 : 9}" scope="rowgroup">${esc(s.category)}</th></tr>` : ''}<tr data-svc-row="${esc(s.code)}">
              <td><input type="checkbox" data-svc-select="${esc(s.code)}" aria-label="Seleccionar ${esc(s.name)}" ${selectedServices.has(s.code) ? 'checked' : ''} ${disabled}></td>
              ${showArchived ? '' : `<td class="whitespace-nowrap"><span class="svc-grip" draggable="${!serviceBusy}" data-svc-drag="${esc(s.code)}" aria-hidden="true" title="Arrastrar">⠿</span>
                <button type="button" class="svc-order" data-svc-move="-1" aria-label="Subir ${esc(s.name)}" title="Subir" ${disabled || (visible[index - 1]?.category !== s.category ? 'disabled' : '')}>↑</button>
                <button type="button" class="svc-order" data-svc-move="1" aria-label="Bajar ${esc(s.name)}" title="Bajar" ${disabled || (visible[index + 1]?.category !== s.category ? 'disabled' : '')}>↓</button></td>`}
              <td class="min-w-[210px]"><strong>${esc(s.name)}</strong><div class="text-xs opacity-70">${esc(s.category)} · ${esc(s.unit)} · ${esc(s.billing_code || s.code)}</div></td>
              <td>${s.active ? esc(SERVICE_STATUS[s.status]) : 'Archivado'}</td>
              <td class="num">${money(s.nyc_price)}</td><td class="num">${money(s.sale_price)}</td><td class="num">${money(s.promo_price)}</td>
              <td class="num">${money(s.reference_price)}${s.reference_promo == null ? '' : `<div class="text-xs">Promo ${money(s.reference_promo)}</div>`}</td>
              <td class="whitespace-nowrap"><button type="button" class="soft" data-service-code="${esc(s.code)}" ${disabled}>Editar</button>
                <button type="button" class="soft" data-svc-toggle="${esc(s.code)}" aria-label="${action} ${esc(s.name)}" ${disabled}>${action}</button></td></tr>`).join('')}</tbody>
          </table></div>` : '<p class="text-sm opacity-60 py-4">No hay servicios en esta vista.</p>'}`;
        $('svc-archived').onchange = e => { showArchived = e.target.checked; selectedServices.clear(); renderServices(); };
        const body = $('prod-body');
        const checks = [...body.querySelectorAll('[data-svc-select]')];
        const all = $('svc-select-all');
        function updateSelection() {
            $('svc-count').textContent = serviceBusy ? 'Guardando…' : `${selectedServices.size} seleccionados`;
            $('svc-bulk').disabled = serviceBusy || !selectedServices.size;
            if (all) {
                all.checked = selectedServices.size === checks.length;
                all.indeterminate = !all.checked && selectedServices.size > 0;
            }
        }
        checks.forEach(box => box.onchange = () => {
            if (box.checked) selectedServices.add(box.dataset.svcSelect);
            else selectedServices.delete(box.dataset.svcSelect);
            updateSelection();
        });
        if (all) all.onchange = () => {
            selectedServices.clear();
            for (const box of checks) {
                box.checked = all.checked;
                if (all.checked) selectedServices.add(box.dataset.svcSelect);
            }
            updateSelection();
        };
        $('svc-bulk').onclick = () => setServiceActive([...selectedServices], showArchived);
        body.querySelectorAll('[data-service-code]').forEach(b => b.onclick = () => editService(b.dataset.serviceCode));
        body.querySelectorAll('[data-svc-toggle]').forEach(b => b.onclick = () => setServiceActive([b.dataset.svcToggle], showArchived));
        updateSelection();
        if (!showArchived && !serviceBusy) bindServiceOrder(body, visible);
    }

    function bindServiceOrder(body, visible) {
        const codes = visible.map(s => s.code);
        const categoryByCode = new Map(visible.map(s => [s.code, s.category]));
        let dragging = null, marker = null;
        function clearMarker() {
            marker?.classList.remove('svc-drop-before', 'svc-drop-after');
            marker = null;
        }
        body.querySelectorAll('[data-svc-drag]').forEach(grip => {
            grip.ondragstart = event => {
                const code = grip.dataset.svcDrag;
                dragging = selectedServices.has(code) ? codes.filter(item => selectedServices.has(item) && categoryByCode.get(item) === categoryByCode.get(code)) : [code];
                event.dataTransfer.setData('text/plain', code);
                event.dataTransfer.effectAllowed = 'move';
            };
            grip.ondragend = () => { dragging = null; clearMarker(); };
        });
        body.querySelectorAll('[data-svc-row]').forEach(row => {
            const target = row.dataset.svcRow;
            const canDrop = () => dragging && !dragging.includes(target) && categoryByCode.get(dragging[0]) === categoryByCode.get(target);
            const after = event => {
                const bounds = row.getBoundingClientRect();
                return event.clientY > bounds.top + bounds.height / 2;
            };
            row.ondragover = event => {
                if (!canDrop()) { clearMarker(); return; }
                event.preventDefault();
                clearMarker();
                marker = row;
                row.classList.add(after(event) ? 'svc-drop-after' : 'svc-drop-before');
            };
            row.ondrop = event => {
                event.preventDefault();
                clearMarker();
                if (canDrop()) moveServices(codes, dragging, target, after(event));
                dragging = null;
            };
            row.querySelectorAll('[data-svc-move]').forEach(button => button.onclick = () => {
                const delta = Number(button.dataset.svcMove);
                return moveServices(codes, [target], codes[codes.indexOf(target) + delta], delta > 0);
            });
        });
    }

    function moveServices(codes, moving, target, after) {
        const next = codes.filter(code => !moving.includes(code));
        const index = next.indexOf(target);
        if (index < 0) return;
        next.splice(index + Number(after), 0, ...moving);
        if (next.every((code, position) => code === codes[position])) return;
        return updateServices(() => _supabase.rpc('reorder_sale_services', { p_codes: next }), 'Orden guardado.');
    }

    async function updateServices(save, message) {
        if (serviceBusy) return;
        serviceBusy = true;
        renderServices();
        try {
            const { error } = await save();
            if (error) throw error;
            toast(message);
            if (typeof loadPayServices === 'function') loadPayServices();
        } catch (error) {
            alert(`No se pudo actualizar el catálogo. ${error.message}`);
        } finally {
            serviceBusy = false;
            if (tab === 'servicios') await open();
        }
    }

    function setServiceActive(codes, active) {
        if (!codes.length) return;
        const verb = active ? 'Desarchivar' : 'Archivar';
        const label = codes.length === 1 ? services.find(s => s.code === codes[0])?.name : `${codes.length} servicios`;
        if (!confirm(`¿${verb} ${label}?`)) return;
        return updateServices(async () => {
            const result = await _supabase.from('sale_services').update({ active, updated_at: new Date().toISOString() })
                .in('code', codes).eq('active', !active).select('code');
            if (!result.error) for (const row of result.data) selectedServices.delete(row.code);
            return result;
        }, active ? 'Servicios desarchivados.' : 'Servicios archivados.');
    }

    const SERVICE_FIELDS = { billing_code: 'Código de servicio', name: 'Servicio', category: 'Categoría', unit: 'Unidad de cobro', nyc_price: 'Sugerido NYC', sale_price: 'Precio Piel Spa', promo_price: 'Promoción' };
    const SERVICE_DIALOG = `<dialog id="svc-dialog" class="prod" aria-labelledby="svc-title"><form id="svc-form" class="p-6 space-y-3">
        <h3 class="text-2xl italic" id="svc-title" style="font-family:'Cormorant Garamond',serif"></h3>
        <input type="hidden" id="svc-identity">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${Object.entries(SERVICE_FIELDS).map(([key, label]) => `<div><label class="lbl" for="svc-${key}">${label}</label><input id="svc-${key}"
            ${key.endsWith('_price') ? 'type="number" min="0" max="99999999.99" step="0.01" inputmode="decimal"' : 'required'}
            ${key === 'billing_code' ? 'maxlength="40" autocomplete="off" autocapitalize="characters" aria-describedby="svc-code-help"' : ''}></div>`).join('')}
          <div><label class="lbl" for="svc-status">Estado</label><select id="svc-status">${Object.entries(SERVICE_STATUS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></div>
        </div>
        <p class="text-xs opacity-70" id="svc-code-help">Usa letras, números, guion o guion bajo. El cambio se aplica a los cobros nuevos.</p>
        <p class="text-xs opacity-70" id="svc-reference"></p>
        <div><label class="lbl" for="svc-notes">Notas</label><textarea id="svc-notes" rows="3"></textarea></div>
        <p id="svc-error" class="text-sm text-red-700" role="alert"></p>
        <div class="dlg-actions flex flex-wrap justify-between gap-2 pt-2">
          <button type="button" class="soft text-red-700" id="svc-archive" onclick="Prod.archiveService()">Archivar</button>
          <div class="flex gap-2"><button type="button" class="soft" onclick="this.closest('dialog').close()">Cancelar</button><button class="pbtn dark" id="svc-save">Guardar</button></div>
        </div>
      </form></dialog>`;

    function editService(code) {
        const service = services.find(s => s.code === code);
        $('svc-title').textContent = service ? 'Editar servicio' : 'Nuevo servicio';
        for (const key of Object.keys(SERVICE_FIELDS)) $('svc-' + key).value = service?.[key] ?? '';
        $('svc-identity').value = service?.code || '';
        $('svc-billing_code').value = service?.billing_code || service?.code || '';
        $('svc-status').value = service?.status || 'pending';
        $('svc-notes').value = service?.notes || '';
        $('svc-reference').textContent = service?.reference_price == null ? '' :
            `Tarifario interno ${service.source_code || ''} · Regular ${money(service.reference_price)} · Promoción ${money(service.reference_promo)}`;
        $('svc-error').textContent = '';
        $('svc-archive').classList.toggle('invisible', !service);
        $('svc-archive').textContent = service?.active === false ? 'Restaurar' : 'Archivar';
        $('svc-dialog').showModal();
    }

    async function writeService(query) {
        const save = $('svc-save'), archive = $('svc-archive');
        if (save.disabled) return;
        save.disabled = archive.disabled = true;
        $('svc-error').textContent = '';
        try {
            const { error } = await query.select('code').single();
            if (error) throw error;
            $('svc-dialog').close();
            toast('Catálogo actualizado.');
            if (tab === 'servicios') open();
            if (typeof loadPayServices === 'function') loadPayServices();
        } catch (error) {
            $('svc-error').textContent = error.code === '23505' ? 'Ese código ya está en uso. Escribe uno diferente.' : `No se pudo guardar. ${error.message}`;
        } finally {
            save.disabled = archive.disabled = false;
        }
    }

    function saveService(event) {
        event.preventDefault();
        const identity = $('svc-identity').value;
        const row = Object.fromEntries(Object.keys(SERVICE_FIELDS).map(key => {
            const value = $('svc-' + key).value.trim();
            return [key, key.endsWith('_price') ? num(value) : value];
        }));
        row.billing_code = row.billing_code.toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(row.billing_code)) {
            $('svc-error').textContent = 'Escribe un código de hasta 40 caracteres. Empieza con una letra o número y usa solo letras, números, guiones o guion bajo.';
            $('svc-billing_code').focus();
            return;
        }
        if (!row.name || !row.category || !row.unit) {
            $('svc-error').textContent = 'Completa el nombre, la categoría y la unidad.';
            return;
        }
        row.status = $('svc-status').value;
        row.notes = $('svc-notes').value.trim() || null;
        row.updated_at = new Date().toISOString();
        const table = _supabase.from('sale_services');
        return writeService(identity ? table.update(row).eq('code', identity) : table.insert(row));
    }

    function archiveService() {
        const service = services.find(s => s.code === $('svc-identity').value);
        if (!service || (service.active && !confirm(`¿Archivar "${service.name}"? Se conservarán los cobros registrados.`))) return;
        return writeService(_supabase.from('sale_services').update({ active: !service.active, updated_at: new Date().toISOString() }).eq('code', service.code));
    }

    function add() {
        if (tab === 'servicios') {
            if (!serviceBusy) editService();
        }
        else abrir();
    }

    window.Prod = { open, add, abrir, eliminar, archiveService };
})();
