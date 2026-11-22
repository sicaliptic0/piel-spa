// "Productos y servicios" (admin-only). Productos = public.sale_products: what Piel Spa sells,
// with prices, stock and expiry. Cobros sells from this list. Servicios comes later.
// Loaded by admin.html after its main script; renders into #products-view; handlers on window.Prod.
(function () {
    'use strict';
    const CATEGORIAS = ['Protector solar', 'Limpiador', 'Sérum', 'Crema', 'Contorno de ojos', 'Tratamiento', 'Mascarilla', 'Kit', 'Otro'];
    const VENCE_PRONTO_DIAS = 60;
    let rows = [], built = false, tab = 'productos', filtro = 'todos', q = '', verEliminados = false;

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
              <button class="pbtn" onclick="Prod.abrir()">+ Producto</button>
            </div>
            <div id="prod-body"><p class="text-sm opacity-50 text-center py-10">Cargando…</p></div></div>`;
        root.querySelectorAll('.sub').forEach(b => b.onclick = () => { tab = b.dataset.t; render(); });
        document.body.insertAdjacentHTML('beforeend', DIALOG);
        $('prod-form').addEventListener('submit', guardar);
    }
    async function open() {
        build();
        const { data, error } = await _supabase.from('sale_products').select('*').order('brand').order('name');
        if (error) { $('prod-body').innerHTML = `<p class="text-sm text-red-500 text-center py-8">${esc(/sale_products/.test(error.message) ? 'Falta correr el SQL de supabase/migrations/20261121_sale_products.sql.' : error.message)}</p>`; return; }
        rows = data || [];
        render();
    }

    function render() {
        document.querySelectorAll('#products-view .sub').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
        if (tab === 'servicios') {
            $('prod-body').innerHTML = `<div class="card p-8 text-center text-sm opacity-70">La lista de servicios y sus precios va aquí. Todavía no está armada.</div>`;
            return;
        }
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
          <div class="card overflow-hidden hidden md:block"><div class="overflow-x-auto"><table class="t"><thead><tr><th>Producto</th><th>Categoría</th><th class="num">Precio sugerido</th><th class="num">Precio Piel Spa</th><th class="num">Costo</th><th class="num">Margen</th><th class="num">Stock</th><th>Vence</th><th></th></tr></thead><tbody>
            ${list.map(p => `<tr onclick="Prod.abrir('${p.id}')" class="${p.active ? '' : 'opacity-50'}"><td><div class="font-medium">${esc(p.name)}</div><div class="text-[11px] opacity-60">${esc(p.brand)}${p.size ? ' · ' + esc(p.size) : ''}${p.sku ? ' · ' + esc(p.sku) : ''}</div></td>
              <td class="text-xs">${esc(p.category || '')}</td><td class="num">${money(p.suggested_price)}</td><td class="num font-semibold">${money(p.sale_price)}</td><td class="num">${money(p.cost)}</td>
              <td class="num">${margen(p) != null ? margen(p) + '%' : '–'}</td><td class="num">${p.stock_qty}</td><td class="whitespace-nowrap text-xs">${fdate(p.expires_on)}</td><td><div class="flex flex-wrap gap-1">${estado(p)}</div></td></tr>`).join('')}
          </tbody></table></div></div>
          <div class="md:hidden space-y-2">${list.map(p => `<div class="pcard ${p.active ? '' : 'opacity-50'}" onclick="Prod.abrir('${p.id}')">
              <div class="flex justify-between gap-2"><div class="min-w-0"><p class="font-medium leading-snug">${esc(p.name)}</p><p class="text-[12px] opacity-60">${esc(p.brand)}${p.size ? ' · ' + esc(p.size) : ''}</p></div>
              <div class="text-right"><p class="font-semibold">${money(precio(p))}</p><p class="text-[11px] opacity-60">${p.stock_qty} en stock</p></div></div>
              <div class="flex flex-wrap gap-1 mt-1.5">${estado(p)}${p.expires_on ? `<span class="text-[11px] opacity-60">vence ${fdate(p.expires_on)}</span>` : ''}</div></div>`).join('')}</div>
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

    window.Prod = { open, abrir, eliminar };
})();
