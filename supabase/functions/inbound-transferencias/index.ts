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
function limpiarNombre(s: string) { return s.replace(/\s+/g, " ").replace(/^[\s:|.,;-]+|[\s:|.,;-]+$/g, "").trim(); }
const digitos = (s: string) => (s || "").replace(/\D/g, "");

// Banco emisor según la casilla que manda el aviso
const BANCOS: [RegExp, string][] = [
  [/santander/i, "Banco Santander"], [/bancochile|bchile/i, "Banco de Chile"], [/bci\.cl/i, "Bci"], [/falabella/i, "Banco Falabella"],
  [/scotiabank/i, "Scotiabank"], [/tenpo/i, "Tenpo"], [/losandes/i, "TAPP Caja Los Andes"], [/bice/i, "Banco BICE"], [/consorcio/i, "Banco Consorcio"],
  [/somosmach|\bmach\b/i, "MACH"], [/bancoestado/i, "BancoEstado"], [/itau/i, "Itaú"], [/security/i, "Banco Security"], [/ripley/i, "Banco Ripley"],
  [/coopeuch/i, "Coopeuch"], [/mercadopago|mercadolibre/i, "Mercado Pago"], [/internacional/i, "Banco Internacional"],
];
const bancoDeRemitente = (from: string, texto: string) => { for (const [re, n] of BANCOS) if (re.test(from)) return n; const m = texto.match(/Banco de origen\s*[|:]*\s*([^|\n]+)/i); return m ? limpiarNombre(m[1]) : ""; };

// ¿El aviso es de una transferencia que YO hice (saliente)? → no se concilia
function esSaliente(t: string) {
  return /Te enviamos el detalle de la transferencia realizada/i.test(t) && /Datos de origen/i.test(t)
    || /ha realizado una transferencia[\s\S]{0,200}Enviamos a usted el detalle/i.test(t)
    || /transferencia (?:enviada|realizada) con [eé]xito/i.test(t) && !/recibid/i.test(t);
}
// ¿El aviso es para la cuenta de la productora? tokens: nombres, RUT o cuentas (se comparan sin puntos/guiones)
function esParaDestino(t: string, tokens: string[]) {
  if (!tokens.length) return true;
  const txt = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const num = t.replace(/[\s.\-]/g, "");
  return tokens.some((tok) => { const k = tok.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); if (!k) return false; return /^\d+$/.test(k.replace(/[.\-\s]/g, "")) ? num.includes(k.replace(/[.\-\s]/g, "")) : txt.includes(k); });
}

// Extrae los datos del aviso (formatos reales de los bancos chilenos). Lo que no se encuentra queda vacío y se corrige en Guestly.
function parsear(texto: string, asunto: string, from: string, destinoTokens: string[]) {
  let t = texto.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  // Reenviado a mano ("---------- Forwarded message / Mensaje reenviado ----------"): el banco real está en el De:/From: del encabezado,
  // y ese encabezado (Date/Subject/Asunto/To…) se quita para que no se confunda con los datos del aviso.
  const fwd = t.match(/-{3,}\s*(?:Forwarded message|Mensaje reenviado)\s*-{3,}\s*\n((?:\s*(?:De|From|Date|Fecha|Subject|Asunto|To|Para|Cc)\s*:[^\n]*\n)+)/i);
  if (fwd) {
    const de = fwd[1].match(/(?:De|From)\s*:[^\n]*?([\w.+-]+@[\w-]+\.[\w.-]+)/i);
    if (de) from = de[1];
    t = t.replace(fwd[0], "\n");
  }
  asunto = asunto.replace(/^\s*(?:(?:fwd?|rv|re|reenv)\s*:\s*)+/i, "");
  const todo = asunto + "\n" + t;
  const out: Record<string, string | number | null> = { monto: null, nombre: "", rut: "", banco: "", email: "", comentario: "", cuenta_destino: "", fecha: null };
  // ── Quién transfirió ──
  const pats: RegExp[] = [
    /nuestro\(?a?\)?\s+cliente(?:\s+el\s+Sr\(a\))?\s+([^|]{3,90}?)\s+(?:realiz[oó]|ha efectuado|ha instruido|ha realizado|hoy\b)/i,         // Santander, Bco Chile, Falabella, Scotia
    /transferencia de fondos de\s+([^\n|]+?)\s+hacia/i,                                                                                   // BCI
    /La transferencia de\s+([^\n|]+?)\s+por\s+\$/i,                                                                                       // Tenpo
    /informamos que\s+([^\n|]+?)\s+ha enviado una transferencia/i,                                                                        // Caja Los Andes
    /por parte de:\s*([^\n|,]+)/i,                                                                                                        // Consorcio
    /transferencia de\s+([^\n|]+?)\s+sin costo desde/i,                                                                                   // MACH
    /Recibiste una transferencia de\s+([^\n|]+)/i,                                                                                        // MACH (asunto)
    /Cuenta de origen[\s|]*Nombre\s*\|?\s*([^|\n]+)/i,                                                                                    // BICE
    /Datos originador[\s\S]{0,80}?Nombre:\s*\|?\s*([^|\n]+)/i,                                                                            // Consorcio (tabla)
    /has recibido una transferencia(?: de fondos)? (?:de|desde|por parte de)\s+([^\n|,]+)/i,
    /(?:Nombre|Titular)(?: de)? (?:origen|ordenante|emisor|remitente)(?:\s*[:|])*\s*([^|\n]+)/i,
  ];
  for (const p of pats) { const m = todo.match(p); if (m) { const n = limpiarNombre(m[1]); if (n.length >= 3 && !/^\$|sin costo/i.test(n)) { out.nombre = n; break; } } }
  // ── Monto (prefiere el etiquetado; si no, el primer $) ──
  const mm = todo.match(/(?:Monto(?:\s+(?:recibido|transferido|transferencia|Transacci[oó]n))?|por el monto)(?:\s*[:|])*\s*\$?\s*([\d]{1,3}(?:\.[\d]{3})+|[\d]{4,})/i)
    || todo.match(/\$\s?([\d]{1,3}(?:\.[\d]{3})+|[\d]{4,})/);
  if (mm) out.monto = parseInt(mm[1].replace(/\./g, ""), 10);
  // ── RUT del que transfirió: el primero que NO sea de la productora ──
  const destNum = destinoTokens.map((k) => k.replace(/[.\-\s]/g, "")).filter((k) => /^\d+$/.test(k));
  const ruts = [...todo.matchAll(/(\d{1,2}\.?\d{3}\.?\d{3})\s?-\s?([\dkK])\b|\bRut:?\s*\|?\s*(\d{7,8})([\dkK])\b/gi)].map((m) => (m[1] ? m[1].replace(/\./g, "") + "-" + m[2] : m[3] + "-" + m[4]).toUpperCase());
  const orig = todo.match(/Datos originador[\s\S]{0,200}?Rut:\s*\|?\s*(\d{7,9}[\dkK]?)/i);
  if (orig) { const d = orig[1]; out.rut = d.length >= 8 ? d.slice(0, -1) + "-" + d.slice(-1) : d; }
  else { const r = ruts.find((x) => !destNum.some((k) => x.replace(/[-]/g, "").startsWith(k) || k.startsWith(x.replace(/[-]/g, "")))); if (r) out.rut = r; }
  // ── Banco emisor ──
  out.banco = bancoDeRemitente(from, todo);
  // ── Correo del emisor (si el banco lo incluye y no es el nuestro) ──
  const emails = (todo.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map((e) => e.toLowerCase());
  out.email = emails.find((e) => !/santander|bancochile|bci|itau|scotiabank|falabella|bice|consorcio|tenpo|mach|losandes|bancoestado|guestly|resend|noreply|no-reply|no\.reply|fturub|circlegroup|taskpro/.test(e)) || "";
  // ── Mensaje / comentario / asunto del pago ──
  const mc = [...todo.matchAll(/(?:Comentario|Mensaje|Asunto|Glosa|Motivo)(?:\s*[:|])*\s*([^|\n]*)/gi)].map((m) => limpiarNombre(m[1]).replace(/\s*(?:C[oó]digo de transacci[oó]n|Hora|Fecha|N[°º] de Transacci[oó]n).*$/i, "")).filter((v) => v && !/^sin mensaje$|^transferencia realizada$|^:?$/i.test(v));
  if (mc.length) out.comentario = mc[0].slice(0, 160);
  // ── Cuenta de destino (últimos 4) ──
  const md = todo.match(/(?:Cuenta(?: de)? destino|N[úu]mero de cuenta|N[°º] de cuenta|Nº cuenta de destino|cuenta Nro\.?|Cuenta Corriente|tu cuenta N°)(?:\s*[:|])*\s*(?:Cuenta (?:Corriente|Vista)\s*)?([\d][\d.\- ]{5,})/i);
  if (md) out.cuenta_destino = digitos(md[1]).slice(-4);
  // ── Fecha y hora ──
  let fecha: string | null = null;
  const f1 = todo.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\D{1,12}(\d{1,2}):(\d{2}))?/);           // dd/mm/yyyy [hh:mm]
  const f2 = todo.match(/(\d{4})-(\d{2})-(\d{2})/);                                                        // yyyy-mm-dd
  const f3 = todo.match(/(\d{1,2})\s+(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[a-z]*\.?\s+(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?/i); // 23 oct 2026 - 14:13
  const hm = todo.match(/\bHora(?:\s*[:|])*\s*(\d{1,2}):(\d{2})/i);
  if (f1) fecha = `${f1[3]}-${f1[2].padStart(2, "0")}-${f1[1].padStart(2, "0")}T${(f1[4] || hm?.[1] || "12").padStart(2, "0")}:${f1[5] || hm?.[2] || "00"}:00-03:00`;
  else if (f3) { const mes = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"].indexOf(f3[2].toLowerCase().slice(0, 3)) + 1; fecha = `${f3[3]}-${String(mes).padStart(2, "0")}-${f3[1].padStart(2, "0")}T${(f3[4] || "12").padStart(2, "0")}:${f3[5] || "00"}:00-03:00`; }
  else if (f2) fecha = `${f2[1]}-${f2[2]}-${f2[3]}T${(hm?.[1] || "12").padStart(2, "0")}:${hm?.[2] || "00"}:00-03:00`;
  out.fecha = fecha;
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
  let productora_id: string | null = null, destinoTokens: string[] = [];
  if (alias) { const r = await fetch(`${SB_URL}/rest/v1/productoras?pagos_alias=eq.${encodeURIComponent(alias)}&select=id,pagos_destino`, { headers: hdr }); const a = await r.json(); productora_id = a?.[0]?.id || null; destinoTokens = String(a?.[0]?.pagos_destino || "").split(/[,;\n]/).map((x: string) => x.trim()).filter(Boolean); }
  if (!productora_id) { const r = await fetch(`${SB_URL}/rest/v1/productoras?select=id,pagos_destino&limit=2`, { headers: hdr }); const a = await r.json(); if (a?.length === 1) { productora_id = a[0].id; destinoTokens = String(a[0].pagos_destino || "").split(/[,;\n]/).map((x: string) => x.trim()).filter(Boolean); } }

  // Correo de verificación de reenvío de Gmail: se guarda como "sistema" para leer el código desde Guestly
  const esVerificacion = /confirmaci[oó]n de reenv[ií]o|forwarding confirmation|código de confirmación|confirmation code/i.test(subject + " " + texto);
  const esTransferencia = /transferencia|dep[oó]sito|abono|te han transferido|has recibido/i.test(todo);
  if (!esVerificacion) {
    if (!esTransferencia) return json({ ok: true, skipped: "no es aviso de transferencia" });
    if (esSaliente(subject + "\n" + texto)) return json({ ok: true, skipped: "transferencia saliente (la hiciste tú)" });
    if (!esParaDestino(subject + "\n" + texto, destinoTokens)) return json({ ok: true, skipped: "no es para la cuenta de la productora" });
  }
  const p = esVerificacion ? { monto: null, nombre: "Gmail — verificación de reenvío", rut: "", banco: "", email: "", comentario: (texto.match(/\b\d{6,9}\b/) || [""])[0], cuenta_destino: "", fecha: null } : parsear(texto, subject, from, destinoTokens);
  const row = {
    id: crypto.randomUUID(), productora_id, email_id, asunto: subject.slice(0, 200), remitente: from.slice(0, 200),
    fecha: p.fecha || received_at, monto: p.monto, nombre: p.nombre, rut: p.rut, banco: p.banco, email: p.email, comentario: p.comentario, cuenta_destino: p.cuenta_destino,
    origen: "email", estado: esVerificacion ? "sistema" : "pendiente", raw: texto.slice(0, 6000), created_at: new Date().toISOString(),
  };
  const ins = await fetch(`${SB_URL}/rest/v1/transferencias`, { method: "POST", headers: { ...hdr, Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify([row]) });
  if (!ins.ok) { const d = await ins.text(); if (/duplicate|23505/.test(d)) return json({ ok: true, duplicate: true }); return json({ error: d }, 500); }
  return json({ ok: true, id: row.id, parsed: { monto: p.monto, nombre: p.nombre, rut: p.rut } });
});
