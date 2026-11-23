-- Lista de Amigos: la gente se inscribe por fiesta (guestly.cl/?amigos=<eventoId>) y entra con el beneficio de ese evento.
-- Solo agrega dos tablas nuevas. No modifica nada existente.

-- Beneficio de la Lista de Amigos en cada evento (lo define la productora)
CREATE TABLE IF NOT EXISTS amigos_config (
  evento_id TEXT PRIMARY KEY,
  productora_id TEXT,
  activo BOOLEAN DEFAULT true,            -- inscripciones abiertas
  precio_hombre INTEGER,                  -- 0 = entra gratis
  hora_hombre TEXT,                       -- "01:00" = beneficio válido hasta esa hora
  cover_hombre BOOLEAN DEFAULT false,     -- el beneficio incluye cover
  precio_mujer INTEGER,
  hora_mujer TEXT,
  cover_mujer BOOLEAN DEFAULT false,
  cupo INTEGER,                           -- máximo de inscritos (vacío = sin límite)
  nota TEXT,                              -- texto extra opcional que ve la gente
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Inscritos en la Lista de Amigos de cada evento (una persona por evento: no se repite el RUT)
CREATE TABLE IF NOT EXISTS amigos_inscritos (
  id TEXT PRIMARY KEY,
  evento_id TEXT NOT NULL,
  productora_id TEXT,
  nombre TEXT, apellido TEXT, rut TEXT, email TEXT, whatsapp TEXT, instagram TEXT,
  fecha_nacimiento DATE,
  genero TEXT,                            -- "m" (hombre) | "f" (mujer), igual que el resto de la app
  llego BOOLEAN DEFAULT false,
  llego_at TIMESTAMPTZ,
  cobro TEXT,                             -- lo que se le cobró al entrar (ej. "Gratis", "$8.000 con cover", "Fuera de horario")
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS amigos_inscritos_evento_rut ON amigos_inscritos (evento_id, rut);
CREATE INDEX IF NOT EXISTS amigos_inscritos_productora ON amigos_inscritos (productora_id);

-- Acceso igual que el resto de las tablas de la app (la app y el formulario público usan la llave pública)
ALTER TABLE amigos_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS amigos_config_anon ON amigos_config;
CREATE POLICY amigos_config_anon ON amigos_config FOR ALL TO anon USING (true) WITH CHECK (true);
ALTER TABLE amigos_inscritos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS amigos_inscritos_anon ON amigos_inscritos;
CREATE POLICY amigos_inscritos_anon ON amigos_inscritos FOR ALL TO anon USING (true) WITH CHECK (true);
