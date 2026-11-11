// Supabase Edge Function: ingreso a Guestly con código al correo (sin contraseña).
//
//   POST { accion: "enviar",    email }            → manda un código de 6 dígitos (vence en 10 min)
//   POST { accion: "verificar", email, codigo }    → si es correcto devuelve { token, cuentas: [...] }
//   POST { accion: "sesion",    token }            → reanuda la sesión guardada en el navegador → { cuentas }
//   POST { accion: "salir",     token }            → cierra esa sesión
//   POST { accion: "clave",     email, pass }      → ingreso con contraseña (se verifica encriptada) → { token, cuentas }
//   POST { accion: "comprobar", email, pass }      → solo verifica la contraseña (para cambiarla) → { ok, ids }
//   POST { accion: "bday",      token_invitacion } → ingreso del cumpleañero por su link personal → { token, cuentas }
//
// Las contraseñas se guardan encriptadas (bcrypt) en la tabla users_claves (ver sql-claves.sql).
// La verificación la hace la base de datos (función guestly_verificar_clave); el navegador nunca ve una clave.
//
// Los códigos y sesiones se guardan solo como hash (SHA-256) en tablas con RLS activado y sin políticas:
// el navegador no las puede leer; solo esta función (service role).
// Se puede desplegar con la verificación JWT activada (la app llama con la anon key).

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VENCE_MIN = 10;          // minutos que dura un código
const MAX_INTENTOS = 5;        // intentos fallidos por código
const ESPERA_SEG = 45;         // tiempo mínimo entre envíos al mismo correo
const MAX_POR_HORA = 6;        // envíos por correo por hora
const SESION_HORAS = 12;      // la sesión vence 12 h después del último uso (se renueva al usarla); además la app la cierra tras 15 min sin uso
const MAX_FALLOS_CLAVE = 10;   // contraseñas incorrectas por correo cada 15 minutos

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
const dbGet = async (t: string, q: string) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: hdr }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };
const dbPost = async (t: string, row: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: "POST", headers: { ...hdr, Prefer: "return=minimal" }, body: JSON.stringify([row]) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); };
const dbPatch = async (t: string, q: string, p: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { method: "PATCH", headers: { ...hdr, Prefer: "return=minimal" }, body: JSON.stringify(p) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); };

const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map(b => b.toString(16).padStart(2, "0")).join("");
const normEmail = (e: unknown) => String(e || "").trim().toLowerCase();
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;
const codigo6 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, "0"); };
const tokenNuevo = () => { const a = new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join(""); };

// Nunca devolver la columna de contraseña al navegador
const sinClave = (u: any) => { const { pass, ...resto } = u || {}; return resto; };
// Cuentas activas con ese correo (una persona puede tener varias: embajadora + compradora de mesa, etc.)
const cuentasDe = async (email: string) => {
  const us = await dbGet("users", `email=ilike.${encodeURIComponent(email)}`);
  return (us || []).filter((u: any) => u.activo !== false && u.active !== false).map(sinClave);
};
const nuevaSesion = async (email: string) => {
  const token = tokenNuevo(), ahora = new Date().toISOString();
  await dbPost("login_sesiones", {
    token_hash: await sha(token), email, created_at: ahora, ultimo_uso_at: ahora,
    expira_at: new Date(Date.now() + SESION_HORAS * 3600e3).toISOString(),
  });
  return token;
};

// IDs de las cuentas de ese correo cuya contraseña coincide. La compara la base de datos contra la versión encriptada.
async function idsConClave(email: string, pass: string): Promise<string[]> {
  if (!pass) return [];
  const r = await fetch(`${SB_URL}/rest/v1/rpc/guestly_verificar_clave`, { method: "POST", headers: hdr, body: JSON.stringify({ p_email: email, p_pass: pass }) });
  if (r.ok) return ((await r.json()) || []).map((x: any) => typeof x === "string" ? x : x?.id).filter(Boolean);
  if (r.status === 404) {
    // Todavía no se instaló sql-claves.sql: comparar como antes (transición)
    const us = await dbGet("users", `email=ilike.${encodeURIComponent(email)}&select=id,pass`);
    return us.filter((u: any) => u.pass && u.pass === pass).map((u: any) => u.id);
  }
  throw new Error("No se pudo verificar la contraseña");
}
// Freno contra quien prueba muchas claves (si la tabla no existe todavía, no frena)
async function fallosRecientes(email: string) {
  try { return (await dbGet("login_intentos", `email=eq.${encodeURIComponent(email)}&created_at=gte.${new Date(Date.now() - 15 * 60e3).toISOString()}&select=id`)).length; } catch { return 0; }
}
async function anotarFallo(email: string) {
  try { await dbPost("login_intentos", { id: crypto.randomUUID(), email, created_at: new Date().toISOString() }); } catch { /* sin tabla */ }
}

function correoCodigo(codigo: string, nombre: string) {
  const F = "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#F2F2EF">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2EF"><tr><td align="center" style="padding:36px 12px 40px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px;max-width:100%">
<tr><td align="center" style="padding:0 0 24px"><img src="https://guestly.cl/brand/logo-email.png" alt="GUESTLY" width="184" height="32" style="display:block;width:184px;height:32px;border:0"></td></tr>
<tr><td style="background:#FFFFFF;border-radius:16px;padding:0">
  <div style="height:4px;background:#2BE07B;border-radius:16px 16px 0 0"></div>
  <div style="padding:32px 36px 36px;text-align:center">
    <p style="margin:0 0 8px;${F}font-size:22px;font-weight:800;color:#0B0B0C">Tu código para entrar</p>
    <p style="margin:0 0 24px;${F}font-size:14px;color:#555;line-height:1.5">${nombre ? `Hola ${nombre}, ` : ""}usa este código para ingresar a Guestly. Vence en ${VENCE_MIN} minutos.</p>
    <div style="${F}font-size:36px;font-weight:800;letter-spacing:10px;color:#0B0B0C;background:#E3FAEC;border-radius:12px;padding:18px 0">${codigo}</div>
    <p style="margin:24px 0 0;${F}font-size:12px;color:#888;line-height:1.5">Si no pediste este código, ignora este correo. Nadie puede entrar a tu cuenta sin él.</p>
  </div>
</td></tr>
<tr><td align="center" style="padding:24px 0 0"><span style="${F}font-size:11px;color:#999">Powered by <a href="https://guestly.cl" style="color:#13894A;text-decoration:none;font-weight:600">Guestly.cl</a></span></td></tr>
</table></td></tr></table></body></html>`;
}

async function enviar(body: any) {
  const email = normEmail(body?.email);
  if (!emailOk(email)) return json({ error: "Correo no válido" }, 400);
  const hace1h = new Date(Date.now() - 3600e3).toISOString();
  const recientes = await dbGet("login_codigos", `email=eq.${encodeURIComponent(email)}&created_at=gte.${hace1h}&order=created_at.desc&select=created_at`);
  if (recientes.length && Date.now() - new Date(recientes[0].created_at).getTime() < ESPERA_SEG * 1000)
    return json({ error: `Espera unos segundos antes de pedir otro código` }, 429);
  if (recientes.length >= MAX_POR_HORA) return json({ error: "Pediste demasiados códigos. Intenta en una hora o entra con tu contraseña." }, 429);
  const cuentas = await cuentasDe(email);
  // Respuesta igual exista o no la cuenta (no revelamos qué correos están registrados)
  if (!cuentas.length) return json({ ok: true });
  const codigo = codigo6();
  await dbPost("login_codigos", {
    id: crypto.randomUUID(), email, codigo_hash: await sha(email + ":" + codigo), intentos: 0, usado: false,
    expira_at: new Date(Date.now() + VENCE_MIN * 60e3).toISOString(), created_at: new Date().toISOString(),
  });
  const nombre = String(cuentas.find((u: any) => u.name)?.name || "").split(" ")[0];
  const r = await fetch(`${SB_URL}/functions/v1/send-email`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}` },
    body: JSON.stringify({ to: email, subject: `${codigo} es tu código para entrar a Guestly`, html: correoCodigo(codigo, nombre) }),
  });
  if (!r.ok) return json({ error: "No pudimos enviar el correo. Intenta de nuevo." }, 502);
  return json({ ok: true });
}

async function verificar(body: any) {
  const email = normEmail(body?.email), codigo = String(body?.codigo || "").replace(/\D/g, "");
  if (!emailOk(email) || codigo.length !== 6) return json({ error: "Código incorrecto" }, 400);
  const ahora = new Date().toISOString();
  const c = (await dbGet("login_codigos", `email=eq.${encodeURIComponent(email)}&usado=eq.false&expira_at=gt.${ahora}&order=created_at.desc&limit=1`))[0];
  if (!c) return json({ error: "El código venció. Pide uno nuevo." }, 400);
  if ((c.intentos || 0) >= MAX_INTENTOS) return json({ error: "Demasiados intentos. Pide un código nuevo." }, 400);
  if (c.codigo_hash !== await sha(email + ":" + codigo)) {
    await dbPatch("login_codigos", `id=eq.${c.id}`, { intentos: (c.intentos || 0) + 1 });
    const quedan = MAX_INTENTOS - (c.intentos || 0) - 1;
    return json({ error: quedan > 0 ? `Código incorrecto. Te quedan ${quedan} intento(s).` : "Demasiados intentos. Pide un código nuevo." }, 400);
  }
  await dbPatch("login_codigos", `id=eq.${c.id}`, { usado: true });
  const cuentas = await cuentasDe(email);
  if (!cuentas.length) return json({ error: "No encontramos una cuenta con ese correo" }, 400);
  const token = await nuevaSesion(email);
  return json({ ok: true, token, cuentas });
}

async function clave(body: any, soloComprobar: boolean) {
  const email = normEmail(body?.email), pass = String(body?.pass ?? "");
  if (!emailOk(email) || !pass) return json({ error: "Email o contraseña incorrectos." }, 400);
  if (await fallosRecientes(email) >= MAX_FALLOS_CLAVE) return json({ error: "Demasiados intentos. Espera unos minutos o entra con código al correo." }, 429);
  const ids = await idsConClave(email, pass);
  const cuentas = ids.length ? (await cuentasDe(email)).filter((u: any) => ids.includes(u.id)) : [];
  if (!cuentas.length) { await anotarFallo(email); return json({ error: soloComprobar ? "La contraseña actual no es correcta" : "Email o contraseña incorrectos." }, 400); }
  if (soloComprobar) return json({ ok: true, ids: cuentas.map((u: any) => u.id) });
  const token = await nuevaSesion(email);
  return json({ ok: true, token, cuentas });
}

// El cumpleañero entra con su link personal (?bday_panel=TOKEN), sin escribir clave
async function bday(body: any) {
  const t = String(body?.token_invitacion || "");
  if (!t || t.length > 200) return json({ error: "Link no válido o expirado." }, 400);
  const c = (await dbGet("bday_cumpleaneros", `token_invitacion=eq.${encodeURIComponent(t)}&select=email`))[0];
  if (!c?.email) return json({ error: "Link no válido o expirado." }, 400);
  const email = normEmail(c.email);
  const u = (await dbGet("users", `email=eq.${encodeURIComponent(c.email)}&role=eq.cumpleanero`))[0];
  if (!u) return json({ error: "Tu usuario aún no está activo.", sinUsuario: true }, 400);
  const token = await nuevaSesion(email);
  return json({ ok: true, token, email, cuentas: [sinClave(u)] });
}

async function sesion(body: any) {
  const token = String(body?.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Sesión no válida" }, 401);
  const h = await sha(token);
  const s = (await dbGet("login_sesiones", `token_hash=eq.${h}&expira_at=gt.${new Date().toISOString()}`))[0];
  if (!s) return json({ error: "Sesión vencida" }, 401);
  // Sesión deslizante: mientras se use, se renueva por otras SESION_HORAS (la app igual la cierra tras 15 min sin uso)
  dbPatch("login_sesiones", `token_hash=eq.${h}`, { ultimo_uso_at: new Date().toISOString(), expira_at: new Date(Date.now() + SESION_HORAS * 3600e3).toISOString() }).catch(() => {});
  const cuentas = await cuentasDe(s.email);
  if (!cuentas.length) return json({ error: "Cuenta no encontrada" }, 401);
  return json({ ok: true, email: s.email, cuentas });
}

async function salir(body: any) {
  const token = String(body?.token || "");
  if (/^[0-9a-f]{64}$/.test(token)) await dbPatch("login_sesiones", `token_hash=eq.${await sha(token)}`, { expira_at: new Date().toISOString() });
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const a = body?.accion;
    if (a === "enviar") return await enviar(body);
    if (a === "verificar") return await verificar(body);
    if (a === "sesion") return await sesion(body);
    if (a === "salir") return await salir(body);
    if (a === "clave") return await clave(body, false);
    if (a === "comprobar") return await clave(body, true);
    if (a === "bday") return await bday(body);
    return json({ error: "acción no válida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
