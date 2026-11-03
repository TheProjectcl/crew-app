-- QR de acreditación: cada persona/entrada tiene su token. Ejecutar una vez en Supabase (SQL Editor).
ALTER TABLE acc_entries       ADD COLUMN IF NOT EXISTS qr_tokens JSONB;
ALTER TABLE cf_ordenes        ADD COLUMN IF NOT EXISTS qr_tokens JSONB;
ALTER TABLE bday_cumpleaneros ADD COLUMN IF NOT EXISTS qr_tokens JSONB;
ALTER TABLE bday_invitados    ADD COLUMN IF NOT EXISTS qr_tokens JSONB;
-- (las mesas VIP guardan el token dentro del JSON de perfiles / solicitudes_pulseras: no necesitan columna)
-- Índices para que la entrada digital (?q=TOKEN) busque rápido
CREATE INDEX IF NOT EXISTS acc_entries_qr_idx       ON acc_entries       USING GIN (qr_tokens);
CREATE INDEX IF NOT EXISTS cf_ordenes_qr_idx        ON cf_ordenes        USING GIN (qr_tokens);
CREATE INDEX IF NOT EXISTS bday_cumpleaneros_qr_idx ON bday_cumpleaneros USING GIN (qr_tokens);
CREATE INDEX IF NOT EXISTS bday_invitados_qr_idx    ON bday_invitados    USING GIN (qr_tokens);
