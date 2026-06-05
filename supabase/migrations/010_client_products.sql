-- =============================================================================
-- Migración 010: Catálogo de productos por contribuyente (RUC)
-- =============================================================================
-- Cada contribuyente (identificación) guarda sus productos con los códigos SRI
-- (codProdICE / codProdPVP). Compartido entre todos sus períodos.

CREATE TABLE IF NOT EXISTS client_products (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,
  nombre text NOT NULL,
  cod_prod_ice text DEFAULT '',
  cod_prod_pvp text DEFAULT '',
  capacidad text DEFAULT '750',
  grado text DEFAULT '15',
  presentacion text DEFAULT '13',
  unidad text DEFAULT '66',
  botellas_por_caja integer DEFAULT 12,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT client_products_unique UNIQUE (identificacion, nombre)
);

CREATE INDEX IF NOT EXISTS idx_client_products_ident ON client_products(identificacion);
