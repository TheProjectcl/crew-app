-- Banner de portada (800x286) para el carrusel de guestly.cl. Solo agrega una columna.
ALTER TABLE eventos ADD COLUMN IF NOT EXISTS banner_url TEXT;
