# Aviso automático de cierre (cumpleaños)

Envía a las **10:00 (hora Chile)** del día en que cierra la lista un correo a cada cumpleañero
activo que tenga invitados por aprobar o cupos libres. No repite envíos (marca `recordatorio_cierre_at`).

## 1) Columna en la tabla
```sql
ALTER TABLE bday_cumpleaneros ADD COLUMN IF NOT EXISTS recordatorio_cierre_at TIMESTAMPTZ;
```

## 2) Desplegar la función
```bash
supabase functions deploy bday-recordatorio-cierre --no-verify-jwt
supabase secrets set APP_URL=https://guestly.cl BDAY_HORA_ENVIO=10
```
(`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya vienen inyectadas.)

## 3) Programarla cada hora con pg_cron (SQL Editor)
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'bday-recordatorio-cierre',
  '0 * * * *',   -- cada hora; la función solo envía cuando en Chile son las 10:00
  $$ select net.http_post(
       url := 'https://TU-PROYECTO.supabase.co/functions/v1/bday-recordatorio-cierre',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
```
Reemplaza `TU-PROYECTO` por el subdominio de tu proyecto.

## 4) Probar a mano (sin esperar las 10:00)
```bash
curl -X POST "https://TU-PROYECTO.supabase.co/functions/v1/bday-recordatorio-cierre?force=1"
```
Responde `{enviados, omitidos, fallidos}`. Solo envía a quienes cierran HOY.
