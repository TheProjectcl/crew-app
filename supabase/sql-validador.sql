-- Validador QR de puerta (guestly.cl/validar). Solo agrega cosas nuevas; no modifica datos existentes.
-- Código fijo y único por evento (6 dígitos). Lo genera la función "validador" la primera vez que se pide.
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS codigo_validador TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS eventos_codigo_validador_idx ON eventos (codigo_validador) WHERE codigo_validador IS NOT NULL;

-- Sesiones de los validadores (solo hash del token). RLS sin políticas: el navegador no las puede leer.
CREATE TABLE IF NOT EXISTS validador_sesiones (
  token_hash TEXT PRIMARY KEY,
  evento_id TEXT NOT NULL,
  nombre TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expira_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE validador_sesiones ENABLE ROW LEVEL SECURITY;

-- Intentos fallidos (para frenar a quien intente adivinar el PIN)
CREATE TABLE IF NOT EXISTS validador_intentos (
  id TEXT PRIMARY KEY,
  codigo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS validador_intentos_idx ON validador_intentos (codigo, created_at);
ALTER TABLE validador_intentos ENABLE ROW LEVEL SECURITY;
