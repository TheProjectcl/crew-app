-- Conciliación de pagos: transferencias recibidas (avisos del banco por correo, cartola o manual)
CREATE TABLE IF NOT EXISTS transferencias (
  id TEXT PRIMARY KEY,
  productora_id TEXT,
  email_id TEXT UNIQUE,
  asunto TEXT, remitente TEXT,
  fecha TIMESTAMPTZ,
  monto INTEGER,
  nombre TEXT, rut TEXT, banco TEXT, email TEXT, comentario TEXT, cuenta_destino TEXT,
  origen TEXT DEFAULT 'email',          -- email | manual | cartola
  estado TEXT DEFAULT 'pendiente',      -- pendiente | conciliada | ignorada | sistema
  match_tipo TEXT, match_id TEXT, match_label TEXT,
  conciliado_por TEXT, conciliado_at TIMESTAMPTZ,
  raw TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE transferencias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transferencias_anon ON transferencias;
CREATE POLICY transferencias_anon ON transferencias FOR ALL TO anon USING (true) WITH CHECK (true);
ALTER PUBLICATION supabase_realtime ADD TABLE transferencias;
ALTER TABLE productoras ADD COLUMN IF NOT EXISTS pagos_alias TEXT;
ALTER TABLE cf_ordenes ADD COLUMN IF NOT EXISTS transferencia_id TEXT;
-- Filtro de destino: solo se guardan avisos dirigidos a la cuenta de la productora (nombre, RUT o nº de cuenta, separados por coma)
ALTER TABLE productoras ADD COLUMN IF NOT EXISTS pagos_destino TEXT;
-- ejemplo: UPDATE productoras SET pagos_destino='sociedad de profesionales, 77820659, 92686299' WHERE pagos_alias='theproject';
