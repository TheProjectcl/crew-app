-- Ingreso con código al correo. Solo crea tablas nuevas; no toca usuarios ni datos existentes.
-- RLS activado SIN políticas: el navegador (anon) no puede leerlas; solo la función login-codigo (service role).
CREATE TABLE IF NOT EXISTS login_codigos (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  codigo_hash TEXT NOT NULL,
  intentos INTEGER DEFAULT 0,
  usado BOOLEAN DEFAULT false,
  expira_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codigos_email_idx ON login_codigos (email, created_at DESC);
ALTER TABLE login_codigos ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS login_sesiones (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  ultimo_uso_at TIMESTAMPTZ,
  expira_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE login_sesiones ENABLE ROW LEVEL SECURITY;
