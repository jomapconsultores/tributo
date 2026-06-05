-- =============================================================================
-- Migración 005: Módulo RETENCIONES (comprobantes de retención por cliente)
-- =============================================================================
-- Paralelo a invoices: cada retención pertenece a un cliente/período. Se parsea
-- del XML del comprobante de retención (Renta, IVA, ISD).

CREATE TABLE IF NOT EXISTS retentions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  unique_id text NOT NULL,                 -- claveAcceso
  estado text DEFAULT 'OK',
  fecha text,
  ruc_emisor text,
  agente_retencion text,
  nro_comprobante text,
  periodo_fiscal text,
  base_renta numeric DEFAULT 0,
  porc_renta numeric DEFAULT 0,
  ret_renta numeric DEFAULT 0,
  base_iva numeric DEFAULT 0,
  porc_iva numeric DEFAULT 0,
  ret_iva numeric DEFAULT 0,
  ret_isd numeric DEFAULT 0,
  total_retenido numeric DEFAULT 0,
  ruc_sujeto text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT retentions_client_unique_key UNIQUE (client_id, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_retentions_client_id ON retentions(client_id);
