import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// "Gasto Piel" iPhone Shortcut → one row in acct_expenses.
// The Shortcut sends the header x-gasto-token (made in Contabilidad → iPhone) and a
// form (or JSON) with: monto, descripcion, categoria, and optionally foto, pagado_por,
// cuenta, proveedor, fecha. It answers in plain text so the Shortcut can show it.
// Deployed with --no-verify-jwt: the token is the credential, checked here.

const CATEGORIAS: Record<string, string> = {
  insumos: "Insumos y productos de tratamiento",
  envios: "Envíos y aranceles de importación",
  transporte: "Transporte",
  comidas: "Comidas de negocio (50%)",
  "equipo menor": "Equipo menor y mobiliario",
  equipo: "Equipo (activo)",
  software: "Software y suscripciones",
  limpieza: "Limpieza y suministros",
  reventa: "Producto para reventa",
  alquiler: "Alquiler de cabina",
  telefono: "Teléfono e internet",
  publicidad: "Publicidad y marketing",
  educacion: "Educación y cursos",
  otro: "Revisar",
};
const PAGADORES = ["Freddy", "Samuel", "LLC"];
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

async function sha256(value: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-gasto-token, content-type" } });
  if (req.method !== "POST") return text("Usa POST.", 405);

  const token = (req.headers.get("x-gasto-token") || "").trim();
  if (token.length < 20) return text("⚠️ Falta el código del atajo. Créalo en el admin: Contabilidad → iPhone.", 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: tok } = await db.from("acct_shortcut_tokens").select("*").eq("token_hash", await sha256(token)).is("revoked_at", null).maybeSingle();
  if (!tok) return text("⚠️ Este código ya no sirve. Crea uno nuevo en el admin: Contabilidad → iPhone.", 401);

  // Form (Shortcuts "Formulario") or JSON.
  const fields: Record<string, string> = {};
  let foto: File | null = null;
  const type = req.headers.get("content-type") || "";
  try {
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[plain(k)] = v;
        else if (v.size) foto = v;
      }
    } else {
      const body = await req.json();
      for (const [k, v] of Object.entries(body || {})) if (v != null) fields[plain(k)] = String(v);
      if (fields.foto_base64) {
        const bin = Uint8Array.from(atob(fields.foto_base64.replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0));
        foto = new File([bin], "recibo.jpg", { type: "image/jpeg" });
      }
    }
  } catch {
    return text("⚠️ No entendí lo que mandó el atajo.", 400);
  }

  const monto = Number(String(fields.monto || "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(monto) || monto <= 0) return text("⚠️ Falta el monto.", 400);
  const descripcion = (fields.descripcion || "").trim();
  if (!descripcion) return text("⚠️ Falta qué compraste.", 400);
  const categoria = CATEGORIAS[plain(fields.categoria || "insumos")] ?? "Revisar";
  const pagado = PAGADORES.find((p) => plain(p) === plain(fields.pagado_por || "")) || tok.partner;
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(fields.fecha || "")
    ? fields.fecha
    : new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

  let receipt_path: string | null = null;
  if (foto) {
    const ext = (foto.type.split("/")[1] || "jpg").replace(/[^a-z0-9]/g, "").replace("jpeg", "jpg");
    receipt_path = `${fecha.slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    const up = await db.storage.from("receipts").upload(receipt_path, foto, { contentType: foto.type || "image/jpeg" });
    if (up.error) receipt_path = null; // keep the expense even if the photo fails
  }

  const { error } = await db.from("acct_expenses").insert({
    spent_on: fecha,
    description: descripcion.slice(0, 300),
    vendor: (fields.proveedor || "").trim() || null,
    category: categoria,
    ledger: "LLC",
    amount: Math.round(monto * 100) / 100,
    account: (fields.cuenta || "").trim() || tok.default_account || (pagado === "LLC" ? "Débito Chase Business" : "Sin dato"),
    paid_by: pagado,
    reimb_status: pagado === "LLC" ? "No aplica (pagó la LLC)" : "Pendiente",
    receipt_path,
    note: foto && !receipt_path ? "Desde el atajo del iPhone. La foto no se pudo subir." : "Desde el atajo del iPhone.",
    source: "telefono",
    created_by: tok.user_id,
  });
  if (error) return text("⚠️ No se pudo guardar: " + error.message, 500);
  await db.from("acct_shortcut_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", tok.id);

  const short = Object.entries(CATEGORIAS).find(([, v]) => v === categoria)?.[0] ?? categoria;
  return text(`✅ Guardado: $${monto.toFixed(2)} · ${descripcion} · ${short} · pagó ${pagado}${receipt_path ? " · con recibo" : ""}`);
});
