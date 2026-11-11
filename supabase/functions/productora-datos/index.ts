// Supabase Edge Function: datos bancarios y de facturación de la productora.
// Se ingresan UNA vez (solo el dueño de la productora) y quedan bloqueados: después solo Guestly (superadmin) los cambia.
//
//   POST { accion: "ver", productora_id }                       → datos bancarios públicos (los ven los compradores de mesas)
//   POST { accion: "ver_varias", ids: [...] }                    → lo mismo para varias productoras
//   POST { accion: "mis", productora_id, auth: { email, tok } }  → todos los datos (dueño, coordinador o superadmin)
//   POST { accion: "guardar", productora_id, auth, datos }       → primer ingreso (dueño) o cambio (solo superadmin)
//
// Se publica con verificación JWT activada (la app llama con la anon key).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
const dbGet = async (t: string, q: string) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: hdr }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };
const dbUpsert = async (t: string, row: unknown) => {
  const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: "POST", headers: { ...hdr, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify([row]) });
  if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return (await r.json())[0];
};
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const idOk = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

const BANCO = ["banco", "tipo_cuenta", "numero_cuenta", "titular", "rut_titular", "email_pagos"];
const FACT = ["razon_social", "rut_empresa", "giro", "direccion", "comuna", "email_facturacion", "representante_nombre", "representante_rut", "telefono"];
const OBLIGATORIOS = ["banco", "tipo_cuenta", "numero_cuenta", "titular", "rut_titular", ...FACT];
const NOMBRES: Record<string, string> = {
  banco: "banco", tipo_cuenta: "tipo de cuenta", numero_cuenta: "número de cuenta", titular: "titular", rut_titular: "RUT del titular",
  razon_social: "razón social", rut_empresa: "RUT de la empresa", giro: "giro", direccion: "dirección", comuna: "comuna",
  email_facturacion: "correo de facturación", representante_nombre: "nombre del representante legal", representante_rut: "RUT del representante legal", telefono: "teléfono",
};
// Lo que ve cualquier comprador (mismo formato que usaban los eventos: datos_pago)
const publico = (d: any) => d ? { banco: d.banco || "", tipo: d.tipo_cuenta || "", numero: d.numero_cuenta || "", titular: d.titular || "", rut: d.rut_titular || "", email: d.email_pagos || "" } : null;

// Quién llama: sesión vigente (token) → sus cuentas activas
async function cuentasDe(auth: any) {
  const email = String(auth?.email || "").trim().toLowerCase();
  const tok = String(auth?.tok || "");
  if (!email || !/^[0-9a-f]{64}$/.test(tok)) return [];
  const s = (await dbGet("login_sesiones", `token_hash=eq.${await sha(tok)}&expira_at=gt.${new Date().toISOString()}&select=email`))[0];
  if (!s || String(s.email).toLowerCase() !== email) return [];
  return (await dbGet("users", `email=ilike.${encodeURIComponent(email)}`)).filter((u: any) => u.activo !== false && u.active !== false);
}
const esSuper = (us: any[]) => us.some((u) => u.role === "superadmin");
const rolEn = (us: any[], prodId: string) => us.filter((u) => u.productora_id === prodId).map((u) => u.role);

async function ver(body: any) {
  if (!idOk(body?.productora_id)) return json({ error: "Productora no válida" }, 400);
  const d = (await dbGet("productora_datos", `productora_id=eq.${body.productora_id}`))[0];
  return json({ ok: true, completo: !!d, datos_pago: publico(d) });
}
async function verVarias(body: any) {
  const ids = (Array.isArray(body?.ids) ? body.ids : []).filter(idOk).slice(0, 50);
  if (!ids.length) return json({ ok: true, productoras: {} });
  const rows = await dbGet("productora_datos", `productora_id=in.(${ids.join(",")})`);
  return json({ ok: true, productoras: Object.fromEntries(rows.map((d: any) => [d.productora_id, publico(d)])) });
}
async function mis(body: any) {
  const pid = body?.productora_id;
  if (!idOk(pid)) return json({ error: "Productora no válida" }, 400);
  const us = await cuentasDe(body?.auth);
  const roles = rolEn(us, pid), sup = esSuper(us);
  if (!sup && !roles.some((r) => ["owner", "coordinator"].includes(r))) return json({ error: "Sin permiso" }, 403);
  const d = (await dbGet("productora_datos", `productora_id=eq.${pid}`))[0] || null;
  const puedeEditar = sup || (!d && roles.includes("owner"));
  return json({ ok: true, datos: d, bloqueado: !!d && !sup, puede_editar: puedeEditar, es_superadmin: sup });
}
async function guardar(body: any) {
  const pid = body?.productora_id;
  if (!idOk(pid)) return json({ error: "Productora no válida" }, 400);
  const us = await cuentasDe(body?.auth);
  const sup = esSuper(us), roles = rolEn(us, pid);
  const actual = (await dbGet("productora_datos", `productora_id=eq.${pid}`))[0];
  if (actual && !sup) return json({ error: "Estos datos ya están ingresados y bloqueados. Para cambiarlos escribe a Guestly." }, 403);
  if (!actual && !sup && !roles.includes("owner")) return json({ error: "Solo el dueño de la productora puede ingresar estos datos." }, 403);
  const d: Record<string, string> = {};
  for (const k of [...BANCO, ...FACT]) d[k] = String(body?.datos?.[k] ?? "").trim().slice(0, k === "direccion" || k === "giro" || k === "razon_social" ? 200 : 120);
  const falta = OBLIGATORIOS.filter((k) => !d[k]);
  if (falta.length) return json({ error: "Falta: " + falta.map((k) => NOMBRES[k] || k).join(", ") }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email_facturacion)) return json({ error: "El correo de facturación no es válido" }, 400);
  if (d.email_pagos && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email_pagos)) return json({ error: "El correo para comprobantes no es válido" }, 400);
  const quien = String(body?.auth?.email || "").toLowerCase(), ahora = new Date().toISOString();
  const row = await dbUpsert("productora_datos", {
    productora_id: pid, ...d,
    ...(actual ? {} : { creado_por: quien, created_at: ahora }),
    actualizado_por: quien, updated_at: ahora,
  });
  return json({ ok: true, datos: row, datos_pago: publico(row), bloqueado: !sup });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const a = body?.accion;
    if (a === "ver") return await ver(body);
    if (a === "ver_varias") return await verVarias(body);
    if (a === "mis") return await mis(body);
    if (a === "guardar") return await guardar(body);
    return json({ error: "acción no válida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
