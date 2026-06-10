-- =============================================================================
-- Migración 023: Clientes importados (compradores de las facturas de ventas).
-- Se guardan APARTE de la tabla clients (que almacena contribuyentes/períodos):
-- cada fila relaciona RUC del contribuyente ↔ cliente comprador.
-- =============================================================================
CREATE TABLE IF NOT EXISTS compradores (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,      -- RUC del contribuyente dueño de las ventas
  ruc text NOT NULL,                 -- identificación del cliente comprador
  tipo_id text DEFAULT '04',         -- tipoIdentificacionComprador de la factura
  nombre text DEFAULT '',            -- razón social del cliente comprador
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, identificacion, ruc)
);
CREATE INDEX IF NOT EXISTS idx_compradores_user ON compradores(user_id);
CREATE INDEX IF NOT EXISTS idx_compradores_ident ON compradores(identificacion);
ALTER TABLE compradores ENABLE ROW LEVEL SECURITY;
