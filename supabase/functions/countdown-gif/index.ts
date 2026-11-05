// @ts-nocheck
// Supabase Edge Function: GIF animado de cuenta regresiva para correos (Close Friends: plazo para comprar).
// GET /functions/v1/countdown-gif?to=<epoch en segundos>
// Cada vez que se abre el correo genera el GIF desde el tiempo que queda en ese momento (60 s animados).
// Deploy: supabase functions deploy countdown-gif --no-verify-jwt   (las imágenes de correo no mandan token)
import gifenc from "npm:gifenc@1.0.3";
const { GIFEncoder } = gifenc;

// Dibuja un GIF animado de cuenta regresiva (60 cuadros = 60 segundos) sin fuentes ni dependencias de canvas.
// Uso: renderCountdown(GIFEncoder, toEpochSeg, nowEpochSeg) → Uint8Array (bytes del GIF)
const W = 600, H = 190;
// Paleta fija (índices): fondo, blanco, ámbar, gris, rojo, segmento apagado
const PAL = [[11, 11, 12], [255, 255, 255], [245, 158, 11], [138, 138, 144], [239, 68, 68], [30, 30, 34]];
const BG = 0, WHITE = 1, AMBER = 2, GRAY = 3, RED = 4, OFF = 5;
// Fuente 5x7 (solo las letras que usamos)
const F = {
  A: ["01110","10001","10001","11111","10001","10001","10001"], C: ["01111","10000","10000","10000","10000","10000","01111"],
  D: ["11110","10001","10001","10001","10001","10001","11110"], E: ["11111","10000","10000","11110","10000","10000","11111"],
  G: ["01111","10000","10000","10011","10001","10001","01111"], H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["11111","00100","00100","00100","00100","00100","11111"], M: ["10001","11011","10101","10101","10001","10001","10001"],
  N: ["10001","11001","10101","10011","10001","10001","10001"], O: ["01110","10001","10001","10001","10001","10001","01110"],
  R: ["11110","10001","10001","11110","10100","10010","10001"], S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"], U: ["10001","10001","10001","10001","10001","10001","01110"],
  V: ["10001","10001","10001","10001","10001","01010","00100"], "Í": ["00010","11111","00100","00100","00100","00100","11111"],
  "Ó": ["00010","01110","10001","10001","10001","10001","01110"], " ": ["00000","00000","00000","00000","00000","00000","00000"],
  P: ["11110","10001","10001","11110","10000","10000","10000"],
};
function rect(px, x, y, w, h, c) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  for (let j = Math.max(0, y); j < Math.min(H, y + h); j++) px.fill(c, j * W + Math.max(0, x), j * W + Math.min(W, x + w));
}
function textW(s, sc) { return [...s].length * 6 * sc - sc; }
function text(px, s, cx, y, sc, c) {
  let x = Math.round(cx - textW(s, sc) / 2);
  for (const ch of s) { const g = F[ch] || F[" "]; for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === "1") rect(px, x + k * sc, y + r * sc, sc, sc, c); x += 6 * sc; }
}
// Dígito de 7 segmentos
const SEG = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
function digit(px, d, x, y, w, h, t, c) {
  const on = SEG[d], hh = (h - t) / 2;
  const s = { a: [x, y, w, t], g: [x, y + hh, w, t], d: [x, y + h - t, w, t],
    f: [x, y, t, hh + t], b: [x + w - t, y, t, hh + t], e: [x, y + hh, t, hh + t], c: [x + w - t, y + hh, t, hh + t] };
  for (const k of "abcdefg") if (!on.includes(k)) { const [rx, ry, rw, rh] = s[k]; rect(px, rx, ry, rw, rh, OFF); }
  for (const k of "abcdefg") if (on.includes(k)) { const [rx, ry, rw, rh] = s[k]; rect(px, rx, ry, rw, rh, c); }
}
function frame(rem, dias) {
  const px = new Uint8Array(W * H).fill(BG);
  const vencido = rem <= 0; rem = Math.max(0, rem);
  const d = Math.floor(rem / 86400), h = Math.floor(rem / 3600) - (dias ? d * 24 : 0), m = Math.floor(rem / 60) % 60, s = rem % 60;
  const grupos = dias ? [[d, "DIAS"], [h, "HORAS"], [m, "MIN"], [s, "SEG"]] : [[h, "HORAS"], [m, "MIN"], [s, "SEG"]];
  text(px, vencido ? "TIEMPO AGOTADO" : "TU ACCESO VENCE EN", W / 2, 20, 3, vencido ? RED : AMBER);
  const dw = 50, dh = 86, t = 12, gapD = 12, gapG = 38, top = 56;
  const gw = 2 * dw + gapD, total = grupos.length * gw + (grupos.length - 1) * gapG;
  let x = (W - total) / 2; const col = vencido ? RED : WHITE;
  grupos.forEach(([v, lab], i) => {
    const str = String(v).padStart(2, "0").slice(-2);
    digit(px, +str[0], x, top, dw, dh, t, col); digit(px, +str[1], x + dw + gapD, top, dw, dh, t, col);
    text(px, lab, x + gw / 2, top + dh + 16, 2, GRAY);
    if (i < grupos.length - 1) { const cx = x + gw + gapG / 2 - 5; rect(px, cx, top + 22, 10, 10, col); rect(px, cx, top + dh - 32, 10, 10, col); }
    x += gw + gapG;
  });
  return px;
}
function renderCountdown(GIFEncoder, toSeg, nowSeg) {
  const rem0 = Math.floor(toSeg - nowSeg);
  const dias = rem0 >= 100 * 3600;
  const gif = GIFEncoder();
  const n = rem0 <= 0 ? 1 : Math.min(60, rem0 + 1);
  for (let i = 0; i < n; i++) gif.writeFrame(frame(rem0 - i, dias), W, H, { palette: PAL, delay: 1000, repeat: i === 0 ? -1 : undefined });
  gif.finish();
  return gif.bytes();
}

Deno.serve((req) => {
  const url = new URL(req.url);
  const to = Number(url.searchParams.get("to"));
  const now = Date.now() / 1000;
  const fin = Number.isFinite(to) && to > 0 ? to : now; // sin fecha válida → muestra 00:00:00
  const bytes = renderCountdown(GIFEncoder, fin, now);
  return new Response(bytes, { headers: {
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache", "Expires": "0",
    "Access-Control-Allow-Origin": "*",
  } });
});
