-- Datos bancarios y de facturación de cada productora. Solo agrega una tabla nueva.
-- La productora los ingresa una vez (solo el dueño) y quedan bloqueados: después solo Guestly (superadmin) los cambia.
-- RLS sin políticas: el navegador no puede leer ni escribir esta tabla; todo pasa por la función "productora-datos".
CREATE TABLE IF NOT EXISTS productora_datos (
  productora_id TEXT PRIMARY KEY,
  -- Cuenta para recibir transferencias (la ven los compradores de mesas)
  banco TEXT, tipo_cuenta TEXT, numero_cuenta TEXT, titular TEXT, rut_titular TEXT, email_pagos TEXT,
  -- Facturación
  razon_social TEXT, rut_empresa TEXT, giro TEXT, direccion TEXT, comuna TEXT, email_facturacion TEXT,
  representante_nombre TEXT, representante_rut TEXT, telefono TEXT,
  creado_por TEXT, created_at TIMESTAMPTZ DEFAULT now(),
  actualizado_por TEXT, updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE productora_datos ENABLE ROW LEVEL SECURITY;
