-- Lista de Amigos: seguir el Instagram de la productora es obligatorio para inscribirse.
-- Solo agrega dos columnas. No modifica datos existentes.
ALTER TABLE amigos_config ADD COLUMN IF NOT EXISTS instagram TEXT;              -- cuenta que hay que seguir (sin @)
ALTER TABLE amigos_inscritos ADD COLUMN IF NOT EXISTS sigue_instagram BOOLEAN;  -- la persona declaró que la sigue
