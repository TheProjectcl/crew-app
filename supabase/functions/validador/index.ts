// Supabase Edge Function: acceso al VALIDADOR QR de la puerta (guestly.cl/validar).
//
// El validador NO tiene cuenta. Entra con:
//   1) el CÓDIGO DEL EVENTO (6 dígitos, fijo y único, se genera solo)
//   2) el PIN dinámico (6 dígitos, cambia cada 12 horas: a las 06:00 y a las 18:00 hora de Chile)
//   3) su nombre (queda registrado en cada QR que valida)
// El código y el PIN los ve el productor en el dashboard del evento.
//
//   POST { accion: "pin", evento_id, auth: { email, pass } | { email, tok } }  → { codigo, pin, cambia_at }  (solo admins)
//   POST { accion: "entrar", codigo, pin, nombre }                              → { token, evento, ... }
//   POST { accion: "sesion", token }                                            → { evento, ... }
//   POST { accion: "salir", token }
//
// La sesión del validador dura hasta que termina el evento (día siguiente al evento, 12:00 hora de Chile).
// Se publica con verificación JWT activada (la app llama con la anon key).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TZ = "America/Santiago";
const H12 = 12 * 3600e3;
const CORTE_H = 6; // los PIN cambian a las 06:00 y 18:00 (hora de Chile): un mismo PIN cubre toda la noche
const MAX_FALLOS = 10; // intentos fallidos por código de evento cada 10 minutos

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
const dbGet = async (t: string, q: string) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: hdr }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };
const dbPost = async (t: string, row: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: "POST", headers: { ...hdr, Prefer: "return=minimal" }, body: JSON.stringify([row]) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); };
const dbPatch = async (t: string, q: string, p: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { method: "PATCH", headers: { ...hdr, Prefer: "return=representation" }, body: JSON.stringify(p) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const tokenNuevo = () => { const a = new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join(""); };
const seis = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(100000 + (a[0] % 900000)); };

// Hora local de Chile (con horario de verano) → milisegundos "como si fuera UTC"
function localMs(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
function ventana(d = new Date()) {
  const loc = localMs(d), off = loc - Math.floor(d.getTime() / 1000) * 1000;
  const idx = Math.floor((loc - CORTE_H * 3600e3) / H12);
  const cambia = (idx + 1) * H12 + CORTE_H * 3600e3 - off; // UTC real del próximo cambio
  return { idx, cambia_at: new Date(cambia).toISOString() };
}
async function pinDe(eventoId: string, idx: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SB_SERVICE + ":validador"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${eventoId}:${idx}`)));
  const n = ((sig[0] << 24) | (sig[1] << 16) | (sig[2] << 8) | sig[3]) >>> 0;
  return String(n % 1000000).padStart(6, "0");
}
// Fin de la sesión: día siguiente al evento a las 12:00 (Chile). Mínimo 6 h, máximo 48 h desde ahora.
function finSesion(fecha?: string) {
  const ahora = Date.now();
  let fin = ahora + 12 * 3600e3;
  if (fecha && /^\d{4}-\d{2}-\d{2}/.test(fecha)) {
    const [y, m, d] = fecha.slice(0, 10).split("-").map(Number);
    const mediodiaLocal = Date.UTC(y, m - 1, d + 1, 12, 0, 0);
    const off = localMs(new Date(mediodiaLocal)) - mediodiaLocal;
    fin = mediodiaLocal - off;
  }
  return new Date(Math.min(Math.max(fin, ahora + 6 * 3600e3), ahora + 48 * 3600e3)).toISOString();
}

async function codigoDeEvento(ev: any) {
  if (ev.codigo_validador) return ev.codigo_validador;
  for (let i = 0; i < 20; i++) {
    const c = seis();
    const ya = await dbGet("eventos", `codigo_validador=eq.${c}&select=id`);
    if (ya.length) continue;
    try {
      const r = await dbPatch("eventos", `id=eq.${ev.id}&codigo_validador=is.null`, { codigo_validador: c });
      if (r.length) return c;
      const actual = (await dbGet("eventos", `id=eq.${ev.id}&select=codigo_validador`))[0];
      if (actual?.codigo_validador) return actual.codigo_validador;
    } catch { /* choque con el índice único: probar otro */ }
  }
  throw new Error("No se pudo generar el código del evento");
}

// Verifica que quien pide el PIN sea admin de la productora del evento (o superadmin)
async function esAdminDe(auth: any, prodId: string) {
  const email = String(auth?.email || "").trim().toLowerCase();
  if (!email) return false;
  let ok = false;
  if (auth?.tok && /^[0-9a-f]{64}$/.test(auth.tok)) {
    const s = (await dbGet("login_sesiones", `token_hash=eq.${await sha(auth.tok)}&expira_at=gt.${new Date().toISOString()}&select=email`))[0];
    ok = !!s && String(s.email).toLowerCase() === email;
  }
  const us = await dbGet("users", `email=ilike.${encodeURIComponent(email)}`);
  const validos = ok ? us : us.filter((u: any) => auth?.pass && u.pass === auth.pass);
  return validos.some((u: any) => u.role === "superadmin" || (["owner", "coordinator"].includes(u.role) && u.productora_id === prodId));
}

async function pin(body: any) {
  const ev = (await dbGet("eventos", `id=eq.${encodeURIComponent(String(body?.evento_id || ""))}&select=id,productora_id,codigo_validador`))[0];
  if (!ev) return json({ error: "Evento no encontrado" }, 404);
  if (!(await esAdminDe(body?.auth, ev.productora_id))) return json({ error: "Sin permiso" }, 403);
  const codigo = await codigoDeEvento(ev);
  const v = ventana();
  return json({ codigo, pin: await pinDe(ev.id, v.idx), cambia_at: v.cambia_at });
}

const datosEvento = (ev: any, nombre: string, expira: string) => ({
  evento_id: ev.id, productora_id: ev.productora_id, evento: ev.name, fecha: ev.date, lugar: ev.venue || "", nombre, expira_at: expira,
});

async function entrar(body: any) {
  const codigo = String(body?.codigo || "").replace(/\D/g, ""), p = String(body?.pin || "").replace(/\D/g, "");
  const nombre = String(body?.nombre || "").trim().slice(0, 60);
  if (codigo.length !== 6) return json({ error: "El código del evento tiene 6 dígitos" }, 400);
  if (!nombre) return json({ error: "Escribe tu nombre" }, 400);
  const hace10 = new Date(Date.now() - 10 * 60e3).toISOString();
  const fallos = await dbGet("validador_intentos", `codigo=eq.${codigo}&created_at=gte.${hace10}&select=id`);
  if (fallos.length >= MAX_FALLOS) return json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
  const ev = (await dbGet("eventos", `codigo_validador=eq.${codigo}&select=id,productora_id,name,date,venue`))[0];
  const v = ventana();
  // Se acepta el PIN actual y el anterior (por si cambió justo mientras lo dictaban)
  const ok = ev && p.length === 6 && (p === await pinDe(ev.id, v.idx) || p === await pinDe(ev.id, v.idx - 1));
  if (!ok) {
    await dbPost("validador_intentos", { id: crypto.randomUUID(), codigo, created_at: new Date().toISOString() });
    return json({ error: ev ? "PIN incorrecto. Pídele el PIN vigente al productor." : "No existe un evento con ese código" }, 400);
  }
  const token = tokenNuevo(), expira = finSesion(ev.date);
  await dbPost("validador_sesiones", { token_hash: await sha(token), evento_id: ev.id, nombre, created_at: new Date().toISOString(), expira_at: expira });
  return json({ ok: true, token, ...datosEvento(ev, nombre, expira) });
}

async function sesion(body: any) {
  const t = String(body?.token || "");
  if (!/^[0-9a-f]{64}$/.test(t)) return json({ error: "Sesión no válida" }, 401);
  const s = (await dbGet("validador_sesiones", `token_hash=eq.${await sha(t)}&expira_at=gt.${new Date().toISOString()}`))[0];
  if (!s) return json({ error: "Sesión vencida" }, 401);
  const ev = (await dbGet("eventos", `id=eq.${s.evento_id}&select=id,productora_id,name,date,venue`))[0];
  if (!ev) return json({ error: "Evento no encontrado" }, 401);
  return json({ ok: true, ...datosEvento(ev, s.nombre, s.expira_at) });
}

async function salir(body: any) {
  const t = String(body?.token || "");
  if (/^[0-9a-f]{64}$/.test(t)) await dbPatch("validador_sesiones", `token_hash=eq.${await sha(t)}`, { expira_at: new Date().toISOString() });
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const a = body?.accion;
    if (a === "pin") return await pin(body);
    if (a === "entrar") return await entrar(body);
    if (a === "sesion") return await sesion(body);
    if (a === "salir") return await salir(body);
    return json({ error: "acción no válida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
