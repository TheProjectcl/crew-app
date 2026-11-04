# Conciliación de pagos — recepción automática de avisos de transferencia

Flujo: Santander manda el aviso a tu Gmail → un filtro de Gmail lo reenvía a la casilla de Guestly →
Resend lo recibe → esta función lo lee y lo guarda en `transferencias` → aparece en Guestly › Conciliación de pagos.

## 1. Base de datos (SQL Editor de Supabase)
Ejecuta `supabase/sql-conciliacion.sql`.

## 2. Resend: activar recepción
1. Resend › Domains › Add domain → `pagos.guestly.cl` (subdominio solo para recibir; no toca el correo normal de guestly.cl).
2. Marca **Receiving** y agrega en tu DNS el registro MX que te muestra (`pagos.guestly.cl  MX 10 inbound.resend.com` o similar). Espera a que verifique.
3. Resend › Webhooks › Add → URL: `https://<TU-PROYECTO>.supabase.co/functions/v1/inbound-transferencias?key=<INBOUND_KEY>` · Evento: `email.received`.

## 3. Supabase: desplegar la función
```bash
supabase secrets set RESEND_API_KEY=re_xxx INBOUND_KEY=una-clave-larga-inventada
supabase functions deploy inbound-transferencias --no-verify-jwt
```

## 4. Guestly: alias de la productora
En Conciliación de pagos › "Casilla de recepción" escribe el alias (ej. `theproject`). La casilla queda:
`theproject@pagos.guestly.cl`

## 5. Gmail (felipe@circlegroup.cl): reenviar solo los avisos del banco
1. Ajustes › Reenvío y correo POP/IMAP › **Agregar dirección de reenvío** → `theproject@pagos.guestly.cl`.
   Gmail manda un correo de verificación a esa casilla: el código aparece en Guestly › Conciliación de pagos (fila gris "Gmail — verificación de reenvío"). Pégalo en Gmail.
2. Crear filtro: `from:(santander.cl) subject:(transferencia OR abono OR depósito)` → acción **Reenviar a** `theproject@pagos.guestly.cl`.
   Nada más de tu correo se reenvía.

## Prueba sin esperar un aviso real
```bash
curl -X POST "https://<TU-PROYECTO>.supabase.co/functions/v1/inbound-transferencias?key=<INBOUND_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"from":"notificaciones@santander.cl","to":["theproject@pagos.guestly.cl"],"subject":"Transferencia recibida","text":"Te informamos que has recibido una transferencia de $25.000 de MARIA JOSE SOTO RUT 19.111.222-3 Banco BancoEstado el 03-11-2026 22:14. Comentario: Close Friends GTA"}'
```
Si el formato real del correo de Santander no se lee bien, el aviso igual se guarda (con el texto completo) y los campos se corrigen a mano en Guestly; mándale un ejemplo a Claude para afinar el lector.
