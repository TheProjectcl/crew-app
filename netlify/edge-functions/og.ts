// Edge Function: reemplaza las etiquetas Open Graph según el link público, SOLO para robots de
// vista previa (WhatsApp, Instagram, Facebook, iMessage, Telegram, etc.). Los usuarios reales
// reciben la página normal sin cambios. Si algo falla, se entrega la página original.
import type { Context } from "https://edge.netlify.com";

const BOT = /whatsapp|facebookexternalhit|facebot|instagram|twitterbot|telegrambot|linkedinbot|slackbot|discordbot|applebot|iMessage|pinterest|skypeuripreview|googlebot|bingbot|vkshare|embedly|quora|outbrain|snapchat|redditbot/i;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const tipo = ["emb", "cf", "cf_buy", "bday_inv", "bday_panel"].find(k => q.has(k));
  const ua = request.headers.get("user-agent") || "";
  if (!tipo || !(BOT.test(ua) || q.get("og") === "1")) return context.next();

  const res = await context.next();
  try {
    const html = await res.text();
    const SB_URL = /const SB_URL\s*=\s*"([^"]+)"/.exec(html)?.[1];
    const SB_KEY = /const SB_KEY\s*=\s*"([^"]+)"/.exec(html)?.[1];
    if (!SB_URL || !SB_KEY) return new Response(html, res);
    const get = async (t: string, p: string) => {
      const r = await fetch(`${SB_URL}/rest/v1/${t}?${p}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
      return r.ok ? await r.json() : [];
    };
    const prodDe = async (id?: string) => id ? (await get("productoras", `id=eq.${id}&select=id,nombre,logo_url`))[0] : null;

    let title = "Guestly", desc = "Everything connected. Every guest accounted for.", image = "https://guestly.cl/brand/og-image.png";
    if (tipo === "emb") {
      const prod = await prodDe(q.get("emb")!);
      title = `Inscripción de embajadoras — ${prod?.nombre ?? "Guestly"}`;
      desc = `Postula para ser embajadora de ${prod?.nombre ?? "la productora"}. Powered by Guestly.`;
      if (prod?.logo_url) image = prod.logo_url;
    } else if (tipo === "cf") {
      const ev = (await get("eventos", `id=eq.${q.get("cf")}&select=id,name,date,productora_id`))[0];
      const prod = await prodDe(ev?.productora_id);
      title = `Close Friends — ${ev?.name ?? prod?.nombre ?? "Guestly"}`;
      desc = `Postula a Close Friends de ${prod?.nombre ?? "la productora"}${ev?.name ? ` para ${ev.name}` : ""}. Powered by Guestly.`;
      if (prod?.logo_url) image = prod.logo_url;
    } else if (tipo === "cf_buy") {
      const post = (await get("cf_postulantes", `buy_token=eq.${q.get("cf_buy")}&select=evento_id,productora_id`))[0];
      const prod = await prodDe(post?.productora_id);
      title = `Tu entrada Close Friends — ${prod?.nombre ?? "Guestly"}`;
      desc = "Completa tu compra con tu link personal. Powered by Guestly.";
      if (prod?.logo_url) image = prod.logo_url;
    } else if (tipo === "bday_inv" || tipo === "bday_panel") {
      const c = (await get("bday_cumpleaneros", `token_invitacion=eq.${q.get(tipo)}&select=nombre,apellido,evento_id,productora_id`))[0];
      const ev = c ? (await get("eventos", `id=eq.${c.evento_id}&select=name,productora_id`))[0] : null;
      const prod = await prodDe(c?.productora_id || ev?.productora_id);
      if (tipo === "bday_inv") {
        title = `Cumpleaños de ${c ? `${c.nombre} ${c.apellido ?? ""}`.trim() : ""} — ${ev?.name ?? ""}`.trim();
        desc = `Inscríbete en la lista de cumpleaños${ev?.name ? ` para ${ev.name}` : ""}. Powered by Guestly.`;
      } else {
        title = `Tu panel de cumpleaños — ${ev?.name ?? "Guestly"}`;
        desc = "Aprueba a tus invitados y comparte tu link. Powered by Guestly.";
      }
      if (prod?.logo_url) image = prod.logo_url;
    }

    let out = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`)
      .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`)
      .replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${esc(image)}">`)
      .replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(url.toString())}"><meta property="og:site_name" content="Guestly">`)
      .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`);
    if (image === "https://guestly.cl/brand/og-image.png") out = out.replace('<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:card" content="summary_large_image">');
    else out = out.replace('<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:card" content="summary">'); // logo cuadrado → tarjeta compacta
    const h = new Headers(res.headers); h.set("content-type", "text/html; charset=utf-8"); h.delete("content-length"); h.set("cache-control", "public, max-age=300");
    return new Response(out, { status: res.status, headers: h });
  } catch (_e) {
    return context.next();
  }
};
