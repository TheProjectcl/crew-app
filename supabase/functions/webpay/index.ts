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
async function calcular(tipo: string, id: string) {
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
  const c = await calcular(tipo, id);
  if (!c.base || c.base < 50) throw new Error("Monto inválido");
  const prod = (await dbGet("productoras", `id=eq.${c.productora_id}&select=id,webpay_modo,webpay_cargo_pct`))[0] || {};
  if (!prod.webpay_modo || prod.webpay_modo === "off") throw new Error("El pago con tarjeta no está habilitado");
  if (prod.webpay_modo === "activo" && !PROD) throw new Error("Webpay aún no está conectado a producción");
  const pct = Math.max(0, Math.min(30, Number(prod.webpay_cargo_pct ?? 10)));
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

// Marca como pagado lo que corresponda (solo si Transbank autorizó y el monto calza)
async function aplicarPago(p: any) {
  if (p.tipo === "cf") {
    await dbPatch("cf_ordenes", `id=eq.${p.ref_id}&estado=neq.conciliado`, {
      estado: "conciliado", conciliado_at: new Date().toISOString(), transferencia_id: `webpay:${p.id}`,
    });
  }
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
    if (p && !["aprobado"].includes(p.estado)) await dbPatch("pagos_webpay", `id=eq.${p.id}`, { estado: tbkToken ? "anulado" : "expirado", respuesta: Object.fromEntries(params) });
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
