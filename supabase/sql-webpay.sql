-- Pagos con Webpay Plus (Transbank). Solo crea cosas nuevas; no modifica datos existentes.
CREATE TABLE IF NOT EXISTS pagos_webpay (
  id TEXT PRIMARY KEY,
  productora_id TEXT,
  evento_id TEXT,
  tipo TEXT,                 -- cf (Close Friends) | mesa | lote (pulseras extra)
  ref_id TEXT,               -- id de la orden / mesa / lote pagado
  buy_order TEXT UNIQUE,
  token TEXT,
  monto_base INTEGER,        -- valor de lo comprado
  cargo INTEGER,             -- cargo por servicio cobrado
  cargo_pct NUMERIC,
  total INTEGER,             -- lo que pagó la persona (base + cargo)
  estado TEXT DEFAULT 'creado', -- creado | en_webpay | aprobado | rechazado | anulado | expirado | error
  ambiente TEXT,             -- pruebas | produccion
  respuesta JSONB,           -- respuesta de Transbank (autorización, tarjeta, cuotas)
  volver TEXT,               -- link para reintentar
  email_enviado BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  confirmado_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pagos_webpay_token_idx ON pagos_webpay (token);
CREATE INDEX IF NOT EXISTS pagos_webpay_evento_idx ON pagos_webpay (evento_id);
-- Configuración por productora: off | prueba | activo  y  % de cargo por servicio al pagar con tarjeta
ALTER TABLE productoras ADD COLUMN IF NOT EXISTS webpay_modo TEXT DEFAULT 'off';
ALTER TABLE productoras ADD COLUMN IF NOT EXISTS webpay_cargo_pct NUMERIC DEFAULT 10;
