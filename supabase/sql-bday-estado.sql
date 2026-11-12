-- Postulaciones públicas de cumpleaños (?cumple=<eventoId>): columna "estado" en bday_cumpleaneros.
-- Solo agrega la columna. Los cumpleañeros que ya existen quedan con estado vacío = aprobados (como hasta ahora).
ALTER TABLE bday_cumpleaneros ADD COLUMN IF NOT EXISTS estado TEXT;

-- Las postulaciones que entraron por el link público antes de esta columna (sin link de invitación ni clave) pasan a "pendiente"
UPDATE bday_cumpleaneros SET estado = 'pendiente'
WHERE estado IS NULL AND token_invitacion IS NULL AND pass_hash IS NULL;
