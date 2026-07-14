-- 031: Devolución de IVA (adultos mayores / personas con discapacidad)
-- Una solicitud por contribuyente+período con el snapshot de los comprobantes
-- marcados. El snapshot (items) se copia de invoices al guardar, para que la
-- solicitud presentada al SRI no cambie si después se edita/borra la factura.

CREATE TABLE IF NOT EXISTS devoluciones_iva_solicitudes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mes integer NOT NULL,
  anio integer NOT NULL,
  tipo_beneficiario text NOT NULL DEFAULT 'tercera_edad',  -- tercera_edad | discapacidad
  porcentaje_discapacidad numeric,
  total_base numeric NOT NULL DEFAULT 0,
  total_iva numeric NOT NULL DEFAULT 0,
  tope_mensual numeric NOT NULL DEFAULT 0,
  monto_solicitado numeric NOT NULL DEFAULT 0,   -- min(total_iva, tope_mensual)
  estado text NOT NULL DEFAULT 'borrador',       -- borrador | presentada | aprobada | rechazada
  observaciones text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, mes, anio)
);

CREATE TABLE IF NOT EXISTS devoluciones_iva_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id uuid NOT NULL REFERENCES devoluciones_iva_solicitudes(id) ON DELETE CASCADE,
  invoice_id uuid,                 -- referencia informativa; el snapshot manda
  unique_id text,
  fecha text,
  ruc_proveedor text,
  nombre_proveedor text,
  clasificacion text,
  base numeric NOT NULL DEFAULT 0,
  iva numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0
);

-- Igual que el resto de tablas: RLS activo (el backend entra con service key;
-- el rol anon no debe poder leer nada directo).
ALTER TABLE devoluciones_iva_solicitudes ENABLE ROW LEVEL SECURITY;
ALTER TABLE devoluciones_iva_items ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_dev_iva_solicitudes_cliente
  ON devoluciones_iva_solicitudes (client_id, anio, mes);
CREATE INDEX IF NOT EXISTS idx_dev_iva_items_solicitud
  ON devoluciones_iva_items (solicitud_id);
