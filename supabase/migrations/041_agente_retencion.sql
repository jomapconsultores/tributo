-- =============================================================================
-- Migración 041: Módulo "Retenciones efectuadas" (cliente como AGENTE de
-- retención hacia sus propios proveedores) + flag es_agente_retencion.
-- =============================================================================
-- Espejo de retentions (migración 005), con los roles invertidos: aquí el
-- cliente es quien retiene (emite el comprobante), no quien recibe la
-- retención. ruc_proveedor/nombre_proveedor es la contraparte retenida.
-- Alimenta: la sección de IVA retenido como agente dentro de la declaración de
-- IVA (Formulario 104) y una declaración nueva de Renta retenida (Formulario 103).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS es_agente_retencion boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS retenciones_efectuadas (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  unique_id text NOT NULL,                 -- claveAcceso del comprobante emitido
  estado text DEFAULT 'OK',
  fecha text,
  ruc_proveedor text,                      -- identificacionSujetoRetenido: el proveedor retenido
  nombre_proveedor text,
  nro_comprobante text,
  periodo_fiscal text,
  base_renta numeric DEFAULT 0,
  porc_renta numeric DEFAULT 0,
  ret_renta numeric DEFAULT 0,
  concepto_renta text,                     -- concepto/bucket del catálogo (ej. "Honorarios profesionales 10%")
  base_iva numeric DEFAULT 0,
  porc_iva numeric DEFAULT 0,              -- 30 / 70 / 100
  ret_iva numeric DEFAULT 0,
  ret_isd numeric DEFAULT 0,
  total_retenido numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT retenciones_efectuadas_client_unique_key UNIQUE (client_id, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_retenciones_efectuadas_client_id ON retenciones_efectuadas(client_id);
