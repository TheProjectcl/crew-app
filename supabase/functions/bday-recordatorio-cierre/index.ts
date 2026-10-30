// Edge Function: aviso automático de cierre a cumpleañeros.
// Se ejecuta cada hora (pg_cron). Solo actúa cuando en Chile son las 10:00 y el beneficio cierra HOY.
// Envía a cumpleañeros ACTIVOS (datos_completos) con invitados pendientes o cupos libres,
// que aún no recibieron el aviso (recordatorio_cierre_at IS NULL).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://guestly.cl";
const HORA_ENVIO = Number(Deno.env.get("BDAY_HORA_ENVIO") ?? "10"); // hora local Chile
const TZ = "America/Santiago";

const sb = createClient(SB_URL, SERVICE_KEY);

function ahoraChile() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return { fecha: `${g("year")}-${g("month")}-${g("day")}`, hora: Number(g("hour")) % 24 };
}
function fmtFechaHora(fecha: string, hora: string) {
  const d = new Date(`${fecha}T12:00:00`);
  const f = isNaN(d.getTime()) ? fecha : d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  return hora ? `el ${f} a las ${hora} hrs` : `el ${f}`;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function statBox(ap: number, pend: number, cupos: number) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0"><tr>
  <td width="33%" style="text-align:center;background:#f0edff;border-radius:10px;padding:12px 6px"><div style="font-size:26px;font-weight:800;color:#534AB7">${ap}</div><div style="font-size:11px;color:#666">aprobados</div></td><td width="4"></td>
  <td width="33%" style="text-align:center;background:${pend ? "#fef3c7" : "#f4f4f6"};border-radius:10px;padding:12px 6px"><div style="font-size:26px;font-weight:800;color:${pend ? "#b45309" : "#888"}">${pend}</div><div style="font-size:11px;color:#666">por aprobar</div></td><td width="4"></td>
  <td width="33%" style="text-align:center;background:${cupos ? "#dcfce7" : "#f4f4f6"};border-radius:10px;padding:12px 6px"><div style="font-size:26px;font-weight:800;color:${cupos ? "#15803d" : "#888"}">${cupos}</div><div style="font-size:11px;color:#666">cupos libres</div></td>
</tr></table>`;
}
function emailCierre(o: { nombre: string; evento: string; cierreTxt: string; ap: number; pend: number; cupos: number; linkPanel: string; linkInv: string }) {
  const faltan: string[] = [];
  if (o.pend) faltan.push(`aprueba a tus <strong>${o.pend} invitado${o.pend > 1 ? "s" : ""} pendiente${o.pend > 1 ? "s" : ""}</strong> — si no lo haces, se quedan afuera`);
  if (o.cupos) faltan.push(`te quedan <strong>${o.cupos} cupo${o.cupos > 1 ? "s" : ""} libre${o.cupos > 1 ? "s" : ""}</strong> — mándale el link a tus amigos antes del cierre`);
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;background:#f4f4f6;padding:24px">
    <div style="background:#fff;border-radius:14px;padding:32px;border:1px solid #e8e8e8">
      <div style="text-align:center;margin-bottom:20px"><img src="${APP_URL}/brand/logo-email.png" alt="GUESTLY" width="230" height="40" style="height:40px;width:230px;display:inline-block;border:0"></div>
      <div style="background:linear-gradient(135deg,#7f1d1d,#b91c1c);color:#fff;border-radius:12px;padding:18px 20px;text-align:center">
        <div style="font-size:30px">⏰</div>
        <div style="font-size:19px;font-weight:800;margin-top:4px">¡Quedan las últimas horas, ${esc(o.nombre)}!</div>
        <div style="font-size:14px;margin-top:6px;opacity:.95">Tu lista para <strong>${esc(o.evento)}</strong> se cierra<br><span style="font-size:16px;font-weight:700">${esc(o.cierreTxt)}</span></div>
      </div>
      ${statBox(o.ap, o.pend, o.cupos)}
      ${faltan.length ? `<p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 6px"><strong>Apúrate:</strong></p><ul style="color:#555;font-size:14px;line-height:1.7;margin:0 0 12px;padding-left:20px">${faltan.map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
      <p style="color:#991b1b;font-size:13px;font-weight:600">Después del cierre nadie más podrá inscribirse ni ser aprobado.</p>
      <div style="text-align:center;margin-top:20px"><a href="${o.linkPanel}" style="background:#b91c1c;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">Revisar mi lista ahora →</a></div>
      <p style="font-size:12px;color:#888;text-align:center;margin-top:16px">Link para tus amigos:<br><a href="${o.linkInv}" style="color:#534AB7;word-break:break-all">${o.linkInv}</a></p>
      <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #e8e8e8"><span style="font-size:11px;color:#bbb">Powered by <a href="https://guestly.cl" style="color:#534AB7;text-decoration:none;font-weight:600">Guestly.cl</a></span></div>
    </div></div>`;
}

async function enviar(to: string, subject: string, html: string) {
  const r = await fetch(`${SB_URL}/functions/v1/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ to, subject, html }),
  });
  return r.ok;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1"; // para probar a mano sin esperar las 10:00
  const { fecha: hoy, hora } = ahoraChile();
  if (!force && hora !== HORA_ENVIO) return Response.json({ ok: true, skipped: `hora local ${hora}, se envía a las ${HORA_ENVIO}` });

  const [{ data: bens }, { data: evs }] = await Promise.all([
    sb.from("bday_beneficios").select("*"),
    sb.from("eventos").select("id,name,date,productora_id"),
  ]);
  const evMap = new Map((evs ?? []).map((e: any) => [e.id, e]));
  // Beneficios que cierran hoy (fecha_cierre, o la fecha del evento si no tiene)
  const { data: cumps } = await sb.from("bday_cumpleaneros").select("*").eq("datos_completos", true).is("recordatorio_cierre_at", null);
  const candidatos = (cumps ?? []).filter((c: any) => {
    const ben = (bens ?? []).find((b: any) => b.id === c.beneficio_id);
    const ev = evMap.get(c.evento_id);
    const fCierre = ben?.fecha_cierre || ev?.date;
    return !!c.email && fCierre === hoy;
  });
  if (!candidatos.length) return Response.json({ ok: true, hoy, enviados: 0, motivo: "nadie cierra hoy" });

  const ids = candidatos.map((c: any) => c.id);
  const { data: invs } = await sb.from("bday_invitados").select("cumpleanero_id,estado").in("cumpleanero_id", ids);

  let enviados = 0, omitidos = 0, fallidos = 0;
  for (const c of candidatos) {
    const ben = (bens ?? []).find((b: any) => b.id === c.beneficio_id);
    const ev = evMap.get(c.evento_id);
    const mios = (invs ?? []).filter((i: any) => i.cumpleanero_id === c.id);
    const ap = mios.filter((i: any) => i.estado === "aprobado").length;
    const pend = mios.filter((i: any) => i.estado === "pendiente").length;
    const cupos = Math.max(0, (ben?.max_invitados ?? 20) - ap);
    if (!pend && !cupos) { omitidos++; continue; } // lista llena y sin pendientes: no molestar
    const cierreTxt = fmtFechaHora(ben?.fecha_cierre || ev?.date, ben?.hora_cierre || "16:00");
    const html = emailCierre({ nombre: c.nombre, evento: ev?.name ?? "el evento", cierreTxt, ap, pend, cupos, linkPanel: `${APP_URL}?bday_panel=${c.token_invitacion}`, linkInv: `${APP_URL}?bday_inv=${c.token_invitacion}` });
    const ok = await enviar(c.email, `⏰ Últimas horas: tu lista para ${ev?.name ?? "el evento"} se cierra ${cierreTxt}`, html);
    if (ok) { enviados++; await sb.from("bday_cumpleaneros").update({ recordatorio_cierre_at: new Date().toISOString() }).eq("id", c.id); }
    else fallidos++;
    await new Promise(r => setTimeout(r, 300));
  }
  return Response.json({ ok: true, hoy, enviados, omitidos, fallidos });
});
