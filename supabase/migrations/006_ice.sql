-- =============================================================================
-- Migración 006: Módulo ICE (ventas de licor con ICE, por cliente)
-- =============================================================================
-- Cada fila es una línea de detalle (producto) de una factura de venta de licor
-- que tiene ICE. Sobre estos datos se calcula la auditoría ICE por año fiscal.

CREATE TABLE IF NOT EXISTS ice_sales (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  unique_id text NOT NULL,
  estado text DEFAULT 'OK',
  fecha text,
  tipo_id_cliente text,
  id_cliente text,
  razon_social_cliente text,
  codigo_producto text,
  nombre_producto text,
  cod_marca text,
  presentacion text,
  capacidad text,
  unidad text,
  grado_alcoholico text,
  cod_impuesto text,
  tipo_producto text,
  es_pack boolean DEFAULT false,
  botellas_por_caja integer DEFAULT 12,
  cantidad_cajas numeric DEFAULT 0,
  unidades_botellas integer DEFAULT 0,
  precio_unitario numeric DEFAULT 0,
  precio_total_sin_impuesto numeric DEFAULT 0,
  precio_por_caja numeric DEFAULT 0,
  precio_por_botella numeric DEFAULT 0,
  base_ice numeric DEFAULT 0,
  valor_ice numeric DEFAULT 0,
  base_iva numeric DEFAULT 0,
  valor_iva numeric DEFAULT 0,
  importe_total numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT ice_client_unique_key UNIQUE (client_id, unique_id)
);

CREATE INDEX IF NOT EXISTS idx_ice_client_id ON ice_sales(client_id);
