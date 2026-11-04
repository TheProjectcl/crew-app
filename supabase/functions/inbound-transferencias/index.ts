// Supabase Edge Function: recibe avisos de transferencia (correo reenviado vía Resend Inbound)
// y los guarda en la tabla `transferencias` para conciliarlos en Guestly.
//
// Acepta:
//  1) Webhook de Resend  (type: "email.received") → descarga el cuerpo con RESEND_API_KEY
//  2) JSON genérico      { from, to, subject, text, html }  (Zapier/Make/Cloudflare Email Worker, pruebas con curl)
//
// Secrets necesarios (supabase secrets set ...):
//  RESEND_API_KEY   = clave de Resend (la misma del envío)
//  INBOUND_KEY      = clave larga inventada; se pasa en la URL del webhook ?key=...
//  (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase solo)
//
// Deploy:  supabase functions deploy inbound-transferencias --no-verify-jwt

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const INBOUND_KEY = Deno.env.get("INBOUND_KEY") || "";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n").replace(/<\/t[dh]>/gi, " \t ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function limpiarNombre(s: string) { return s.replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim(); }

// Extrae los datos del aviso. Tolerante: si algo no se encuentra queda vacío y se corrige en Guestly.
function parsear(texto: string, asunto: string) {
  const t = texto.replace(/\r/g, "");
  const todo = asunto + "\n" + t;
  const out: Record<string, string | number | null> = { monto: null, nombre: "", rut: "", banco: "", email: "", comentario: "", cuenta_destino: "", fecha: null };
  // Monto: primer "$ 25.000" o "$25.000,00"
  const mm = todo.match(/\$\s?([\d]{1,3}(?:\.[\d]{3})+|[\d]+)(?:,\d{2})?/);
  if (mm) out.monto = parseInt(mm[1].replace(/\./g, ""), 10);
  // RUT
  const mr = todo.match(/(\d{1,2}\.?\d{3}\.?\d{3}\s?-\s?[\dkK])/);
  if (mr) out.rut = mr[1].replace(/\s/g, "").toUpperCase();
  // Nombre: varios formatos de Santander / otros bancos
  const pats = [
    /(?:transferencia|dep[oó]sito|abono)\s+(?:recibid[oa]\s+)?(?:de|desde)\s+(?:la cuenta de\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ' ]{4,60}?)(?=\s+(?:RUT|Rut|rut|por|con|,|\.|\n|desde|al|a su))/,
    /(?:Nombre|Titular|Origen|Remitente|De)\s*[:：]\s*([A-ZÁÉÍÓÚÑa-záéíóúñ' ]{4,60})/,
    /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ' ]{3,60})\s+(?:RUT|Rut)\s*[:：]?\s*\d/,
  ];
  for (const p of pats) { const m = todo.match(p); if (m) { out.nombre = limpiarNombre(m[1]); break; } }
  // Banco de origen
  const mb = todo.match(/Banco(?:\s+de\s+origen|\s+origen)?\s*[:：]?\s*((?:Banco\s+)?[A-ZÁÉÍÓÚÑa-záéíóúñ]+(?:\s+(?:de|del)\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+|\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/);
  if (mb) out.banco = limpiarNombre(mb[1].replace(/\s+(?:Fecha|Monto|Nombre|RUT|Rut|Mensaje|Comentario|Glosa|Cuenta|el|la|a)$/i, ""));
  // Correo del emisor (excluye casillas del banco y de guestly)
  const emails = (todo.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map((e) => e.toLowerCase());
  out.email = emails.find((e) => !/santander|bancoestado|bci\.|itau|scotiabank|bancochile|falabella|guestly|resend|noreply|no-reply/.test(e)) || "";
  // Comentario / mensaje / glosa
  const mc = todo.match(/(?:Comentario|Mensaje|Glosa|Asunto|Motivo)\s*[:：]\s*([^\n]{1,120})/i);
  if (mc) out.comentario = limpiarNombre(mc[1]);
  // Cuenta destino (últimos dígitos)
  const md = todo.match(/cuenta(?:\s+(?:corriente|vista|destino))?(?:\s+(?:n[úu]mero|N[°º]\.?|nro\.?))?\s*[:：]?\s*[*xX•·]*\s?(\d{3,})/i);
  if (md) out.cuenta_destino = md[1].slice(-4);
  // Fecha dd-mm-aaaa hh:mm
  const mf = todo.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (mf) { const [_, d, m, y, hh, mi] = mf; out.fecha = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${(hh || "12").padStart(2, "0")}:${mi || "00"}:00-03:00`; }
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, info: "inbound-transferencias" });
  const url = new URL(req.url);
  if (INBOUND_KEY && url.searchParams.get("key") !== INBOUND_KEY) return json({ error: "unauthorized" }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  let from = "", to: string[] = [], subject = "", text = "", html = "", email_id = "", received_at = new Date().toISOString();
  if (body?.type === "email.received" && body?.data?.email_id) {
    email_id = body.data.email_id; from = body.data.from || ""; to = body.data.to || []; subject = body.data.subject || ""; received_at = body.data.created_at || received_at;
    if (!RESEND_KEY) return json({ error: "RESEND_API_KEY missing" }, 500);
    const r = await fetch(`https://api.resend.com/emails/receiving/${email_id}`, { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
    if (!r.ok) return json({ error: "resend fetch failed", detail: await r.text() }, 502);
    const e = await r.json(); html = e.html || ""; text = e.text || ""; if (e.headers?.from) from = e.headers.from;
  } else if (body?.type && body.type !== "email.received") {
    return json({ ok: true, ignored: body.type }); // otros eventos de Resend (delivered, etc.)
  } else {
    from = body.from || ""; to = Array.isArray(body.to) ? body.to : [body.to || ""]; subject = body.subject || ""; text = body.text || ""; html = body.html || ""; email_id = body.message_id || body.id || `manual_${Date.now()}`;
  }
  const texto = text && text.trim().length > 40 ? text : htmlToText(html);
  const todo = (subject + "\n" + texto).toLowerCase();

  // Productora destino: alias en la casilla  →  <alias>@pagos.guestly.cl  ó  pagos+<alias>@guestly.cl
  let alias = "";
  for (const d of to) { const m = String(d).toLowerCase().match(/^(?:pagos\+)?([a-z0-9._-]+)@/); if (m && m[1] !== "pagos") { alias = m[1]; break; } }
  const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=representation" };
  let productora_id: string | null = null;
  if (alias) { const r = await fetch(`${SB_URL}/rest/v1/productoras?pagos_alias=eq.${encodeURIComponent(alias)}&select=id`, { headers: hdr }); const a = await r.json(); productora_id = a?.[0]?.id || null; }
  if (!productora_id) { const r = await fetch(`${SB_URL}/rest/v1/productoras?select=id&limit=2`, { headers: hdr }); const a = await r.json(); if (a?.length === 1) productora_id = a[0].id; }

  // Correo de verificación de reenvío de Gmail: se guarda como "sistema" para leer el código desde Guestly
  const esVerificacion = /confirmaci[oó]n de reenv[ií]o|forwarding confirmation|código de confirmación|confirmation code/i.test(subject + " " + texto);
  const esTransferencia = /transferencia|dep[oó]sito|abono|te han transferido|has recibido/i.test(todo);
  const esSaliente = /has (?:realizado|enviado|efectuado)|transferencia (?:enviada|realizada|efectuada)|enviaste|realizaste/i.test(todo) && !/recibid|te han transferido|has recibido/i.test(todo);
  if (!esVerificacion && (!esTransferencia || esSaliente)) return json({ ok: true, skipped: esSaliente ? "saliente" : "no es aviso de transferencia" });

  const p = esVerificacion ? { monto: null, nombre: "Gmail — verificación de reenvío", rut: "", banco: "", email: "", comentario: (texto.match(/\b\d{6,9}\b/) || [""])[0], cuenta_destino: "", fecha: null } : parsear(texto, subject);
  const row = {
    id: crypto.randomUUID(), productora_id, email_id, asunto: subject.slice(0, 200), remitente: from.slice(0, 200),
    fecha: p.fecha || received_at, monto: p.monto, nombre: p.nombre, rut: p.rut, banco: p.banco, email: p.email, comentario: p.comentario, cuenta_destino: p.cuenta_destino,
    origen: "email", estado: esVerificacion ? "sistema" : "pendiente", raw: texto.slice(0, 6000), created_at: new Date().toISOString(),
  };
  const ins = await fetch(`${SB_URL}/rest/v1/transferencias`, { method: "POST", headers: { ...hdr, Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify([row]) });
  if (!ins.ok) { const d = await ins.text(); if (/duplicate|23505/.test(d)) return json({ ok: true, duplicate: true }); return json({ error: d }, 500); }
  return json({ ok: true, id: row.id, parsed: { monto: p.monto, nombre: p.nombre, rut: p.rut } });
});
