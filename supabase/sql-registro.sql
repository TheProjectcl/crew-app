-- Solicitudes de registro de productoras desde el landing (guestly.cl → "Armar mi fiesta").
-- Guestly (superadmin) las aprueba en Productoras → Solicitudes de registro.
CREATE TABLE IF NOT EXISTS registro_productoras (
  id TEXT PRIMARY KEY,
  nombre_productora TEXT NOT NULL,
  responsable TEXT,
  email TEXT,
  whatsapp TEXT,
  instagram TEXT,
  ciudad TEXT,
  mensaje TEXT,
  estado TEXT DEFAULT 'pendiente',   -- pendiente | aprobada | rechazada
  productora_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
