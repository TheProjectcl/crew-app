// Supabase Edge Function: cartelera pública de guestly.cl.
// Entrega SOLO los eventos que su productora publicó, y solo campos públicos (nada de datos de pago, listas ni personas).
//
//   POST { accion: "listar" }                        → { eventos: [...] }  próximos eventos publicados de todas las productoras
//   POST { accion: "evento", id }                    → { evento, mas: [...] }
//   POST { accion: "productora", id }                → { productora, eventos: [...] }
//   POST { accion: "contacto", nombre, productora, correo, whatsapp, mensaje } → guarda el mensaje y avisa a Guestly por correo
//
// Se publica con verificación JWT activada (la página llama con la anon key).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "America/Santiago";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
const dbGet = async (t: string, q: string) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: hdr }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };
const dbPost = async (t: string, row: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: "POST", headers: { ...hdr, Prefer: "return=minimal" }, body: JSON.stringify([row]) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); };

const hoyChile = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const idOk = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const urlOk = (u: unknown) => typeof u === "string" && /^https:\/\//.test(u) ? u : null;

const CAMPOS_EV = "id,name,date,start_time,venue,status,productora_id,publicado,destacado,pub_cf,pub_embajadores,flyer_url,descripcion";

// Solo lo que puede ver cualquiera
async function armar(evs: any[]) {
  if (!evs.length) return [];
  const prodIds = [...new Set(evs.map((e) => e.productora_id).filter(idOk))];
  const evIds = evs.map((e) => e.id).filter(idOk);
  const [prods, cfgs] = await Promise.all([
    prodIds.length ? dbGet("productoras", `id=in.(${prodIds.join(",")})&select=id,nombre,logo_url`) : [],
    evIds.length ? dbGet("cf_config", `evento_id=in.(${evIds.join(",")})&select=evento_id,activo`).catch(() => []) : [],
  ]);
  const P = Object.fromEntries(prods.map((p: any) => [p.id, p]));
  const cfActivo = new Set(cfgs.filter((c: any) => c.activo).map((c: any) => c.evento_id));
  const hoy = hoyChile();
  return evs.map((e) => {
    const p = P[e.productora_id] || {};
    return {
      id: e.id, nombre: e.name || "", fecha: e.date || null, hora: e.start_time || null, lugar: e.venue || "",
      flyer: urlOk(e.flyer_url), descripcion: e.descripcion || "", destacado: !!e.destacado,
      pasado: !!(e.date && e.date < hoy),
      productora: { id: e.productora_id || null, nombre: p.nombre || "", logo: urlOk(p.logo_url) },
      cf: !!e.pub_cf && cfActivo.has(e.id),
      embajadores: !!e.pub_embajadores,
    };
  });
}

const visibles = (extra = "") => `publicado=eq.true&status=in.(active,draft)${extra}&select=${CAMPOS_EV}&order=date.asc`;

async function listar() {
  const evs = await dbGet("eventos", visibles(`&date=gte.${hoyChile()}`) + "&limit=200");
  return json({ eventos: await armar(evs) });
}

async function evento(body: any) {
  if (!idOk(body?.id)) return json({ error: "Evento no encontrado" }, 404);
  const e = (await dbGet("eventos", `id=eq.${body.id}&publicado=eq.true&status=neq.cancelled&select=${CAMPOS_EV}`))[0];
  if (!e) return json({ error: "Evento no encontrado" }, 404);
  const [ev] = await armar([e]);
  let mas: any[] = [];
  if (idOk(e.productora_id)) {
    const otros = await dbGet("eventos", visibles(`&productora_id=eq.${e.productora_id}&date=gte.${hoyChile()}&id=neq.${e.id}`) + "&limit=12");
    mas = await armar(otros);
  }
  return json({ evento: ev, mas });
}

async function productora(body: any) {
  if (!idOk(body?.id)) return json({ error: "Productora no encontrada" }, 404);
  const p = (await dbGet("productoras", `id=eq.${body.id}&select=id,nombre,logo_url`))[0];
  if (!p) return json({ error: "Productora no encontrada" }, 404);
  const evs = await dbGet("eventos", visibles(`&productora_id=eq.${p.id}&date=gte.${hoyChile()}`) + "&limit=50");
  return json({ productora: { id: p.id, nombre: p.nombre || "", logo: urlOk(p.logo_url) }, eventos: await armar(evs) });
}

async function contacto(body: any) {
  const t = (k: string, n: number) => String(body?.[k] ?? "").trim().slice(0, n);
  const nombre = t("nombre", 80), prod = t("productora", 120), correo = t("correo", 160).toLowerCase(), wsp = t("whatsapp", 30), mensaje = t("mensaje", 2000);
  if (!nombre) return json({ error: "Escribe tu nombre" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: "Escribe un correo válido" }, 400);
  if (body?.web) return json({ ok: true }); // campo trampa para robots
  const hace1h = new Date(Date.now() - 3600e3).toISOString();
  const recientes = await dbGet("contactos", `correo=eq.${encodeURIComponent(correo)}&created_at=gte.${hace1h}&select=id`);
  if (recientes.length >= 3) return json({ error: "Ya recibimos tu mensaje. Te escribiremos pronto." }, 429);
  await dbPost("contactos", { id: crypto.randomUUID(), nombre, productora: prod, correo, whatsapp: wsp, mensaje, created_at: new Date().toISOString() });
  // Aviso por correo a los administradores de Guestly (superadmin)
  try {
    const admins = (await dbGet("users", "role=eq.superadmin&select=email")).map((u: any) => String(u.email || "").trim()).filter((e: string) => /@/.test(e));
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.6">
      <p style="font-size:18px;font-weight:bold;margin:0 0 12px">Nuevo contacto desde guestly.cl</p>
      <p style="margin:0"><b>Nombre:</b> ${esc(nombre)}<br><b>Productora:</b> ${esc(prod) || "—"}<br><b>Correo:</b> ${esc(correo)}<br><b>WhatsApp:</b> ${esc(wsp) || "—"}</p>
      <p style="margin:12px 0 0;white-space:pre-wrap">${esc(mensaje) || "(sin mensaje)"}</p></div>`;
    for (const to of [...new Set(admins)]) {
      await fetch(`${SB_URL}/functions/v1/send-email`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}` },
        body: JSON.stringify({ to, subject: `Contacto Guestly: ${nombre}${prod ? " · " + prod : ""}`, html }),
      });
    }
  } catch { /* el mensaje ya quedó guardado */ }
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const a = body?.accion;
    if (a === "listar") return await listar();
    if (a === "evento") return await evento(body);
    if (a === "productora") return await productora(body);
    if (a === "contacto") return await contacto(body);
    return json({ error: "acción no válida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
