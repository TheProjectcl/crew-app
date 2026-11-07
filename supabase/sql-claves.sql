-- Contraseñas encriptadas (bcrypt). Nadie puede volver a ver una contraseña: ni el navegador, ni el superadmin.
-- Nadie pierde el acceso: cada clave actual se encripta tal cual, así que todos entran con la misma de siempre.
-- No borra usuarios ni cambia roles. Se puede correr más de una vez sin problema.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1) Tabla aparte con las claves encriptadas. RLS sin políticas: el navegador no la puede leer ni escribir.
CREATE TABLE IF NOT EXISTS users_claves (
  user_id TEXT PRIMARY KEY,
  pass_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE users_claves ENABLE ROW LEVEL SECURITY;

-- Intentos fallidos de contraseña (freno contra quien prueba claves)
CREATE TABLE IF NOT EXISTS login_intentos (
  id TEXT PRIMARY KEY,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_intentos_idx ON login_intentos (email, created_at);
ALTER TABLE login_intentos ENABLE ROW LEVEL SECURITY;

-- 2) Cada vez que la app guarda una clave (usuario nuevo, cambio de clave, clave temporal),
--    la base la encripta en users_claves y deja vacía la columna users.pass.
ALTER TABLE users ALTER COLUMN pass DROP NOT NULL;

CREATE OR REPLACE FUNCTION guestly_encriptar_clave() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF NEW.pass IS NOT NULL AND NEW.pass <> '' THEN
    INSERT INTO users_claves (user_id, pass_hash, updated_at)
    VALUES (NEW.id::text, crypt(NEW.pass, gen_salt('bf', 10)), now())
    ON CONFLICT (user_id) DO UPDATE SET pass_hash = EXCLUDED.pass_hash, updated_at = now();
  END IF;
  NEW.pass := NULL;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guestly_encriptar_clave() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guestly_encriptar_clave ON users;
CREATE TRIGGER guestly_encriptar_clave BEFORE INSERT OR UPDATE OF pass ON users
FOR EACH ROW EXECUTE FUNCTION guestly_encriptar_clave();

-- 3) Verificación: devuelve las cuentas de ese correo cuya clave coincide. Solo la puede usar el servidor.
CREATE OR REPLACE FUNCTION guestly_verificar_clave(p_email TEXT, p_pass TEXT) RETURNS TABLE (id TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions AS $$
  SELECT u.id::text FROM users u
  LEFT JOIN users_claves c ON c.user_id = u.id::text
  WHERE lower(u.email) = lower(trim(p_email)) AND coalesce(p_pass, '') <> ''
    AND ((c.pass_hash IS NOT NULL AND crypt(p_pass, c.pass_hash) = c.pass_hash)
      OR (c.pass_hash IS NULL AND u.pass IS NOT NULL AND u.pass = p_pass));
$$;
REVOKE ALL ON FUNCTION guestly_verificar_clave(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION guestly_verificar_clave(TEXT, TEXT) TO service_role;

-- 4) Encriptar las claves que ya existen y borrar la versión legible.
INSERT INTO users_claves (user_id, pass_hash)
SELECT id::text, extensions.crypt(pass, extensions.gen_salt('bf', 8)) FROM users WHERE pass IS NOT NULL AND pass <> ''
ON CONFLICT (user_id) DO UPDATE SET pass_hash = EXCLUDED.pass_hash, updated_at = now();

UPDATE users SET pass = NULL WHERE pass IS NOT NULL;

-- Comprobación: ambas cifras deberían coincidir con la cantidad de usuarios con clave, y "legibles" debe ser 0.
SELECT (SELECT count(*) FROM users_claves) AS claves_encriptadas,
       (SELECT count(*) FROM users WHERE pass IS NOT NULL) AS legibles;
