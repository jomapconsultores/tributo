-- =============================================================================
-- Migración 046: Módulo INGRESOS IVA (facturas de venta SIN ICE) — tabla sales_iva
-- =============================================================================
-- La tabla sales_iva ya EXISTE en producción (creada manualmente), pero ninguna
-- migración la definía: reconstruir la BD desde /migrations dejaba a "Ingresos
-- IVA" sin tabla y, por lo tanto, SIN la constraint UNIQUE(client_id, unique_id)
-- de la que depende toda la deduplicación de ingresos (routers/sales_iva.py se
-- apoya en el error 23505 del INSERT para descartar duplicados).
--
-- Esta migración es un NO-OP en producción (IF NOT EXISTS / DROP IF EXISTS) y
-- solo sirve para que un rebuild reproduzca el esquema real y no reintroduzca
-- doble conteo de ingresos. Refleja el esquema vigente del proyecto (columnas de
-- COLUMNS en routers/sales_iva.py y el parser services/xml_parser_ventas.py).

CREATE TABLE IF NOT EXISTS sales_iva (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  unique_id text NOT NULL,                 -- claveAcceso (o fallback ruc_emisor-factura)
  estado text NOT NULL DEFAULT 'OK',
  fecha text,
  tipo_id_cliente text,
  id_cliente text,
  razon_social_cliente text,
  factura_numero text,
  no_objeto_iva numeric NOT NULL DEFAULT 0,
  exento_iva numeric NOT NULL DEFAULT 0,
  base_0 numeric NOT NULL DEFAULT 0,
  base_15 numeric NOT NULL DEFAULT 0,
  iva_15 numeric NOT NULL DEFAULT 0,
  base_5 numeric NOT NULL DEFAULT 0,
  iva_5 numeric NOT NULL DEFAULT 0,
  importe_total numeric NOT NULL DEFAULT 0,
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_iva_client_id_unique_id_key UNIQUE (client_id, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_iva_client_id ON sales_iva(client_id);
