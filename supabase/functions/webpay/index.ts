// Supabase Edge Function: pagos con Webpay Plus (Transbank) para Guestly.
//
// Acciones:
//   POST  ?accion=crear    { tipo: "cf", id: <orden cf> }  → crea la transacción y devuelve { url, token }
//                           El MONTO se calcula aquí desde la base de datos (nunca se confía en el navegador)
//                           y se le suma el cargo por servicio (% configurado en la productora).
//   GET/POST ?accion=retorno  ← Transbank devuelve al comprador aquí (token_ws | TBK_TOKEN | TBK_ORDEN_COMPRA)
//                           → confirma (commit) con Transbank, marca la orden como pagada y redirige a
//                             https://guestly.cl/?pago=<id> para mostrar el resultado.
//   GET   ?accion=estado   → { ambiente } para mostrar en el panel si estamos en pruebas o producción.
//
// Secrets (Supabase → Edge Functions → Secrets). Si no están, usa el AMBIENTE DE PRUEBAS público de Transbank:
//   TBK_COMMERCE_CODE  = código de comercio de producción (lo entrega Transbank / tu ejecutivo)
//   TBK_API_KEY        = Api Key Secret de producción (la entrega Transbank tras la validación)
//   TBK_ENV            = "produccion" para cobrar de verdad (cualquier otro valor = pruebas)
// Deploy SIN verificación JWT (Transbank llama al retorno sin token):  supabase functions deploy webpay --no-verify-jwt

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://guestly.cl";

// Credenciales públicas del ambiente de integración de Transbank (documentación oficial)
const TBK_INT = { code: "597055555532", key: "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C", host: "https://webpay3gint.transbank.cl" };
const PROD = (Deno.env.get("TBK_ENV") || "").toLowerCase() === "produccion" && !!Deno.env.get("TBK_COMMERCE_CODE") && !!Deno.env.get("TBK_API_KEY");
const TBK = PROD
  ? { code: Deno.env.get("TBK_COMMERCE_CODE")!, key: Deno.env.get("TBK_API_KEY")!, host: "https://webpay3g.transbank.cl" }
  : TBK_INT;
const AMBIENTE = PROD ? "produccion" : "pruebas";
const TBK_PATH = "/rswebpaytransaction/api/webpay/v1.2/transactions";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const volverA = (pagoId: string) => new Response(null, { status: 303, headers: { Location: `${SITE}/?pago=${encodeURIComponent(pagoId)}` } });

const hdr = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };
const dbGet = async (t: string, q: string) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { headers: hdr }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return await r.json(); };
const dbPost = async (t: string, row: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}`, { method: "POST", headers: { ...hdr, Prefer: "return=representation" }, body: JSON.stringify([row]) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); return (await r.json())[0]; };
const dbPatch = async (t: string, q: string, patch: unknown) => { const r = await fetch(`${SB_URL}/rest/v1/${t}?${q}`, { method: "PATCH", headers: { ...hdr, Prefer: "return=minimal" }, body: JSON.stringify(patch) }); if (!r.ok) throw new Error(`${t}: ${await r.text()}`); };

const tbk = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${TBK.host}${TBK_PATH}${path}`, {
    method, headers: { "Tbk-Api-Key-Id": TBK.code, "Tbk-Api-Key-Secret": TBK.key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text(); let data: any = {}; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error(`Transbank ${r.status}: ${txt.slice(0, 300)}`);
  return data;
};

// Calcula qué se cobra según el tipo de pago (por ahora: orden de Close Friends)
async function calcular(tipo: string, id: string, body?: any) {
  // Pago de prueba suelto (sin orden): solo en el ambiente de integración.
  // (El producto de prueba de $50 para la puesta en producción ya se usó el 09-11-2026 y quedó desactivado.)
  if (tipo === "test") {
    if (PROD) throw new Error("Los pagos de prueba están desactivados");
    return { base: Math.max(50, Math.min(500000, Math.round(Number(body?.monto) || 1000))), evento_id: null, productora_id: null, ref: null, glosa: "PRUEBA" };
  }
  if (tipo === "cf") {
    const o = (await dbGet("cf_ordenes", `id=eq.${encodeURIComponent(id)}&select=id,codigo,estado,monto_total,evento_id,productora_id,postulante_id`))[0];
    if (!o) throw new Error("Orden no encontrada");
    if (["conciliado", "confirmado"].includes(o.estado)) throw new Error("Esta orden ya está pagada");
    if (["vencido", "rechazado", "cancelado"].includes(o.estado)) throw new Error("Esta orden ya no está disponible");
    const ev = (await dbGet("eventos", `id=eq.${o.evento_id}&select=id,productora_id`))[0];
    return { base: Math.round(Number(o.monto_total) || 0), evento_id: o.evento_id, productora_id: o.productora_id || ev?.productora_id, ref: o.id, glosa: o.codigo };
  }
  throw new Error("Tipo de pago no soportado");
}

async function crear(body: any) {
  const tipo = String(body?.tipo || ""), id = String(body?.id || "");
  const c = await calcular(tipo, id, body);
  if (!c.base || c.base < 50) throw new Error("Monto inválido");
  let pct = 0;
  if (tipo !== "test") {
    const prod = (await dbGet("productoras", `id=eq.${c.productora_id}&select=id,webpay_modo,webpay_cargo_pct`))[0] || {};
    if (!prod.webpay_modo || prod.webpay_modo === "off") throw new Error("El pago con tarjeta no está habilitado");
    if (prod.webpay_modo === "activo" && !PROD) throw new Error("Webpay aún no está conectado a producción");
    pct = Math.max(0, Math.min(30, Number(prod.webpay_cargo_pct ?? 10)));
  }
  const cargo = Math.round(c.base * pct / 100);
  const total = c.base + cargo;
  const pagoId = crypto.randomUUID();
  const buyOrder = ("GL" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase().slice(0, 26);
  const ret = `${SB_URL}/functions/v1/webpay?accion=retorno`;
  await dbPost("pagos_webpay", {
    id: pagoId, productora_id: c.productora_id, evento_id: c.evento_id, tipo, ref_id: c.ref, buy_order: buyOrder,
    monto_base: c.base, cargo, cargo_pct: pct, total, estado: "creado", ambiente: AMBIENTE,
    volver: typeof body?.volver === "string" ? body.volver.slice(0, 500) : null, created_at: new Date().toISOString(),
  });
  const t = await tbk("POST", "", { buy_order: buyOrder, session_id: pagoId, amount: total, return_url: ret });
  await dbPatch("pagos_webpay", `id=eq.${pagoId}`, { token: t.token, estado: "en_webpay" });
  return { url: t.url, token: t.token, pago_id: pagoId, base: c.base, cargo, total, ambiente: AMBIENTE };
}

// ── Entrada confirmada: QR + correo, todo en el servidor (no depende de que el comprador vuelva a la página) ──
const QR_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const qrToken = () => { const a = new Uint8Array(14); crypto.getRandomValues(a); let s = ""; for (const b of a) s += QR_CHARS[b % 32]; return s; };
const qrLink = (t: string) => `${SITE}/?q=${t}`;
const qrImg = (t: string, s = 520) => `https://api.qrserver.com/v1/create-qr-code/?size=${s}x${s}&margin=6&data=${encodeURIComponent(qrLink(t))}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const clp = (n: unknown) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CL");

function correoConfirmada(o: { ev: any; prod: any; nombre: string; mensaje: string; codigo: string; toks: { t: string }[]; pago: any }) {
  
  const F="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const M="font-family:'JetBrains Mono','SF Mono',Menlo,Consolas,'Courier New',monospace;";
  const e=esc, cap=(t:string)=>t?t.charAt(0).toUpperCase()+t.slice(1):t;
  const DIAS=["domingo","lunes","martes","miércoles","jueves","viernes","sábado"],MESES=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  let fecha="Por confirmar"; if(o.ev?.date){const d=new Date(o.ev.date+"T12:00:00");fecha=`${cap(DIAS[d.getDay()])} ${d.getDate()} de ${MESES[d.getMonth()]}`;}
  const hora=o.ev?.start_time?`${String(o.ev.start_time).slice(0,5)} horas`:"Por confirmar";
  const lugar=o.ev?.venue||"Por confirmar";
  const n=(o.toks||[]).length;
  const lbl=(t:string)=>`<p style="margin:10px 0 0;${M}font-size:9px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#8A8A90">${t}</p>`;
  const val=(t:string)=>`<p style="margin:3px 0 0;${F}font-size:13px;line-height:18px;font-weight:700;color:#FFFFFF">${t}</p>`;
  const muesca=`<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="14" height="28" style="background:#F2F2EF;border-radius:0 14px 14px 0;font-size:0;line-height:0">&nbsp;</td><td valign="middle" style="padding:0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:2px dashed #2E2E33;font-size:0;line-height:0">&nbsp;</td></tr></table></td><td width="14" height="28" style="background:#F2F2EF;border-radius:14px 0 0 14px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>`;
  const stub=(t:{t:string},i:number)=>`${muesca}
<tr><td align="center" style="padding:16px 24px 6px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#FFFFFF;border-radius:16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:5px;background:#2BE07B;border-radius:16px 16px 0 0;font-size:0;line-height:0">&nbsp;</td></tr><tr><td style="padding:14px 14px 12px"><a href="${qrLink(t.t)}" target="_blank" style="text-decoration:none"><img src="${qrImg(t.t)}" width="260" height="260" alt="QR de ingreso" style="display:block;width:260px;height:260px;border:0"></a></td></tr></table></td></tr></table></td></tr>
<tr><td align="center" style="padding:2px 24px 0"><p style="margin:0;${M}font-size:10px;font-weight:600;letter-spacing:2.4px;text-transform:uppercase;color:#8A8A90">${n>1?`Entrada ${i+1} de ${n}`:"Acceso · QR personal"}</p><p style="margin:6px 0 0;${M}font-size:13px;letter-spacing:3px;color:#FFFFFF">${t.t}</p></td></tr>
<tr><td align="center" style="padding:14px 24px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#13261B;border:1px solid #1E4D32;border-radius:999px;padding:7px 16px;${F}font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#2BE07B">Listo para entrar</td></tr></table></td></tr>
<tr><td align="center" style="padding:10px 24px 20px"><a href="${qrLink(t.t)}" target="_blank" style="${F}font-size:12px;font-weight:600;color:#8A8A90;text-decoration:underline">Abrir entrada digital</a></td></tr>`;
  const miniFlyer=o.ev?.flyer_url?`<td width="112" valign="top"><img src="${e(o.ev.flyer_url)}" width="112" height="112" alt="${e(o.ev?.name||"")}" style="display:block;width:112px;height:112px;object-fit:cover;border-radius:14px;border:0"></td>`:"";
  const marca=o.prod?.nombre?`<p style="margin:0;${M}font-size:9px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#2BE07B">${e(o.prod.nombre)}</p>`:"";
  const r0=o.pago.respuesta||{};
  const filas:[string,string][]=[["Código de orden",`<b>${e(o.codigo||"")}</b>`],["Pagado con tarjeta (Webpay)",`<b>${clp(o.pago.total)}</b>`],[`Incluye cargo por servicio (${Number(o.pago.cargo_pct)||0}%)`,clp(o.pago.cargo)],["Orden de compra",e(o.pago.buy_order)]];
  if(r0.authorization_code)filas.push(["Código de autorización",e(r0.authorization_code)]);
  if(r0.card_detail?.card_number)filas.push(["Tarjeta","•••• "+e(r0.card_detail.card_number)]);
  const fila=(a:string,b:string)=>`<tr><td style="${F}font-size:12px;color:#777;padding:3px 0">${a}</td><td align="right" style="${F}font-size:12px;color:#1a1a1a;padding:3px 0">${b}</td></tr>`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><style>table{border-collapse:collapse}@media only screen and (max-width:620px){.gl-c{width:100%!important}.gl-t{width:100%!important}}</style></head>
<body style="margin:0;padding:0;background:#F2F2EF"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F2F2EF"><tr><td align="center" style="padding:36px 12px 40px">
<table role="presentation" class="gl-c" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%">
<tr><td align="center" style="padding:0 0 22px"><img src="${SITE}/brand/logo-email.png" alt="GUESTLY" width="184" height="32" style="display:block;width:184px;height:32px;border:0"></td></tr>
<tr><td align="center" style="padding:0 0 14px"><p style="margin:0 0 6px;${F}font-size:21px;font-weight:800;color:#0B0B0C">${e(o.nombre)}, tu entrada está confirmada</p><p style="margin:0;${F}font-size:14px;line-height:21px;color:#555">${e(o.mensaje||"Esta es tu entrada: muéstrala en la puerta junto a tu carnet.")}</p></td></tr>
<tr><td align="center"><table role="presentation" class="gl-t" width="400" cellpadding="0" cellspacing="0" border="0" style="width:400px;max-width:100%;background:#0B0B0C;border-radius:20px">
<tr><td style="padding:20px 20px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${miniFlyer}<td valign="top" style="padding-left:${o.ev?.flyer_url?"16":"0"}px">${marca}<p style="margin:${marca?"6":"0"}px 0 0;${F}font-size:19px;line-height:24px;font-weight:800;letter-spacing:-0.4px;color:#FFFFFF">${e(o.ev?.name||"Evento")}</p>${lbl("Fecha")}${val(fecha)}${lbl("Hora")}${val(hora)}${lbl("Lugar")}${val(e(lugar))}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="50%" style="padding:14px 0 0">${lbl("Titular").replace("margin:10px","margin:0")}${val(e(o.nombre||""))}</td><td width="50%" align="right" valign="bottom" style="padding:14px 0 0"><p style="margin:0;${M}font-size:11px;letter-spacing:2px;color:#3A3A40">GUESTLY</p></td></tr></table>
<p style="margin:0 0 16px;font-size:0;line-height:0">&nbsp;</p></td></tr>
${(o.toks||[]).map(stub).join("")}
<tr><td style="font-size:0;line-height:0;height:6px">&nbsp;</td></tr>
</table></td></tr>
<tr><td align="center" style="padding:10px 0 0"><table role="presentation" class="gl-t" width="400" cellpadding="0" cellspacing="0" border="0" style="width:400px;max-width:100%;background:#FFFFFF;border-radius:16px"><tr><td style="padding:18px 22px 16px"><p style="margin:0 0 8px;${F}font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:#8A8A90">Resumen</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${filas.map(x=>fila(x[0],x[1])).join("")}</table>${o.pago.ambiente!=="produccion"?`<p style="margin:10px 0 0;${F}font-size:10px;color:#92400E">Pago de prueba (ambiente de integración de Transbank) · no es un cobro real</p>`:""}</td></tr></table></td></tr>
<tr><td align="center" style="padding:18px 24px 0"><p style="margin:0;${F}font-size:11px;line-height:17px;color:#8A8A90">Guarda una captura del QR o abre el link antes de llegar.<br>Si no tienes señal, igual puedes acreditarte por lista con tu carnet de identidad vigente.</p></td></tr>
<tr><td align="center" style="padding:22px 0 0"><span style="${F}font-size:11px;color:#999">Powered by <a href="${SITE}" style="color:#13894A;text-decoration:none;font-weight:600">Guestly.cl</a></span></td></tr>
</table></td></tr></table></body></html>`;
}

// Marca como pagado lo que corresponda (solo si Transbank autorizó y el monto calza) y envía la entrada
async function aplicarPago(p: any) {
  if (p.tipo === "cf") {
    await dbPatch("cf_ordenes", `id=eq.${p.ref_id}&estado=neq.conciliado`, {
      estado: "conciliado", conciliado_at: new Date().toISOString(), transferencia_id: `webpay:${p.id}`,
    });
    await enviarEntradaCF(p);
  }
}
async function enviarEntradaCF(p: any) {
  // "Reserva" el envío: solo una ejecución manda el correo, aunque se repita el retorno
  const r = await fetch(`${SB_URL}/rest/v1/pagos_webpay?id=eq.${p.id}&email_enviado=eq.false`, { method: "PATCH", headers: { ...hdr, Prefer: "return=representation" }, body: JSON.stringify({ email_enviado: true }) });
  if (!r.ok || !(await r.json()).length) return;
  try {
    const o = (await dbGet("cf_ordenes", `id=eq.${p.ref_id}`))[0];
    if (!o) return;
    const n = Math.max(1, Number(o.cantidad) || 1);
    const toks = Array.isArray(o.qr_tokens) ? o.qr_tokens.slice() : [];
    if (toks.length < n) { while (toks.length < n) toks.push({ t: qrToken(), usado_at: null }); await dbPatch("cf_ordenes", `id=eq.${o.id}`, { qr_tokens: toks }); }
    const [post, ev, cfg] = await Promise.all([
      dbGet("cf_postulantes", `id=eq.${o.postulante_id}`).then((a) => a[0]),
      dbGet("eventos", `id=eq.${o.evento_id}`).then((a) => a[0]),
      dbGet("cf_config", `evento_id=eq.${o.evento_id}`).then((a) => a[0] || {}),
    ]);
    if (!post?.email) return;
    const prod = ev?.productora_id ? (await dbGet("productoras", `id=eq.${ev.productora_id}&select=nombre,logo_url`))[0] : null;
    const html = correoConfirmada({ ev, prod, nombre: `${post.nombre || ""} ${post.apellido || ""}`.trim() || "Hola", mensaje: cfg.msg_confirmacion || "Tu pago fue recibido. Esta es tu entrada: muéstrala en la puerta junto a tu carnet.", codigo: o.codigo || "", toks, pago: p });
    const s = await fetch(`${SB_URL}/functions/v1/send-email`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}` }, body: JSON.stringify({ to: post.email, subject: `¡Entrada confirmada — ${ev?.name || "tu evento"}!`, html }) });
    if (!s.ok) throw new Error("send-email " + s.status + " " + (await s.text()).slice(0, 200));
  } catch (e) {
    // Si falló, se libera para reintentar (la página de resultado vuelve a pedirlo)
    await dbPatch("pagos_webpay", `id=eq.${p.id}`, { email_enviado: false });
    throw e;
  }
}

// Datos que la página de resultado puede mostrar (la tabla no es legible desde el navegador)
async function resultado(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Pago no válido");
  const p = (await dbGet("pagos_webpay", `id=eq.${id}`))[0];
  if (!p) return { encontrado: false };
  // Respaldo: si quedó aprobado y el correo no salió, se intenta de nuevo
  if (p.estado === "aprobado" && !p.email_enviado) { try { await aplicarPago(p); } catch { /* se reintenta en la próxima visita */ } }
  const r = p.respuesta || {};
  return {
    encontrado: true, estado: p.estado, tipo: p.tipo, ref_id: p.ref_id, buy_order: p.buy_order, monto_base: p.monto_base, cargo: p.cargo,
    cargo_pct: p.cargo_pct, total: p.total, ambiente: p.ambiente, volver: p.volver, created_at: p.created_at, confirmado_at: p.confirmado_at,
    token: p.tipo === "test" ? p.token : undefined,
    respuesta: { payment_type_code: r.payment_type_code, installments_number: r.installments_number, authorization_code: r.authorization_code, transaction_date: r.transaction_date, card_detail: r.card_detail ? { card_number: r.card_detail.card_number } : undefined },
  };
}

async function retorno(params: URLSearchParams) {
  const tokenWs = params.get("token_ws");
  const tbkToken = params.get("TBK_TOKEN");
  const orden = params.get("TBK_ORDEN_COMPRA");
  const sesion = params.get("TBK_ID_SESION");
  // Compra abortada por el usuario o tiempo agotado → no se confirma nada
  if (!tokenWs || tbkToken) {
    const pid = sesion || "";
    const ps = pid ? await dbGet("pagos_webpay", `id=eq.${encodeURIComponent(pid)}`) : orden ? await dbGet("pagos_webpay", `buy_order=eq.${encodeURIComponent(orden)}`) : [];
    const p = ps[0];
    // token_ws + TBK_TOKEN juntos = error en el formulario de pago ("intentar nuevamente"): no se confirma ni se cobra
    const est = tokenWs && tbkToken ? "error_formulario" : tbkToken ? "anulado" : "expirado";
    if (p && !["aprobado"].includes(p.estado)) await dbPatch("pagos_webpay", `id=eq.${p.id}`, { estado: est, respuesta: Object.fromEntries(params) });
    return p ? volverA(p.id) : new Response(null, { status: 303, headers: { Location: SITE } });
  }
  const p = (await dbGet("pagos_webpay", `token=eq.${encodeURIComponent(tokenWs)}`))[0];
  if (!p) return new Response(null, { status: 303, headers: { Location: SITE } });
  if (p.estado === "aprobado") return volverA(p.id); // recarga del navegador: ya confirmado
  let r: any;
  try { r = await tbk("PUT", `/${encodeURIComponent(tokenWs)}`); }
  catch (e) { await dbPatch("pagos_webpay", `id=eq.${p.id}`, { estado: "error", respuesta: { error: String(e) } }); return volverA(p.id); }
  const ok = r?.response_code === 0 && r?.status === "AUTHORIZED" && Number(r?.amount) === Number(p.total) && r?.buy_order === p.buy_order;
  await dbPatch("pagos_webpay", `id=eq.${p.id}`, { estado: ok ? "aprobado" : "rechazado", respuesta: r, confirmado_at: new Date().toISOString() });
  if (ok) { try { await aplicarPago(p); } catch (e) { await dbPatch("pagos_webpay", `id=eq.${p.id}`, { respuesta: { ...r, error_aplicar: String(e) } }); } }
  return volverA(p.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const accion = url.searchParams.get("accion") || "";
  try {
    if (accion === "estado") return json({ ok: true, ambiente: AMBIENTE });
    if (accion === "resultado") return json(await resultado(url.searchParams.get("id") || ""));
    if (accion === "crear" && req.method === "POST") return json(await crear(await req.json()));
    if (accion === "retorno") {
      const params = new URLSearchParams(url.search);
      if (req.method === "POST") { try { const f = new URLSearchParams(await req.text()); f.forEach((v, k) => params.set(k, v)); } catch { /* sin cuerpo */ } }
      return await retorno(params);
    }
    return json({ error: "acción no válida" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 400);
  }
});
