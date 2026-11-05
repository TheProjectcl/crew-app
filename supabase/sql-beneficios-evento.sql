-- Beneficios de cumpleaños por evento (cada evento tiene los suyos; se copian del evento anterior al crear/replicar).
-- Los beneficios existentes quedan con evento_id vacío = "Beneficios anteriores" y sirven de base para copiar.
ALTER TABLE bday_beneficios ADD COLUMN IF NOT EXISTS evento_id TEXT;
CREATE INDEX IF NOT EXISTS bday_beneficios_evento_idx ON bday_beneficios (evento_id);
