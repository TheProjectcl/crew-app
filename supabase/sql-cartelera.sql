-- Cartelera pública de guestly.cl. Solo agrega columnas y una tabla nueva; no modifica datos existentes.
-- Ningún evento sale en la cartelera hasta que la productora lo publique (publicado = false por defecto).

ALTER TABLE eventos ADD COLUMN IF NOT EXISTS publicado BOOLEAN DEFAULT false;        -- aparece en la cartelera
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS destacado BOOLEAN DEFAULT false;        -- carrusel de la portada (lo decide Guestly)
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS pub_cf BOOLEAN DEFAULT false;           -- botón "Postular a Close Friends"
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS pub_embajadores BOOLEAN DEFAULT false;  -- botón "Quiero ser embajador"
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS flyer_url TEXT;
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS descripcion TEXT;

-- Mensajes del formulario "Contáctanos". RLS sin políticas: solo la función del servidor los guarda y lee.
CREATE TABLE IF NOT EXISTS contactos (
  id TEXT PRIMARY KEY,
  nombre TEXT,
  productora TEXT,
  correo TEXT,
  whatsapp TEXT,
  mensaje TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contactos_correo_idx ON contactos (correo, created_at);
ALTER TABLE contactos ENABLE ROW LEVEL SECURITY;
