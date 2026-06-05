-- =============================================================================
-- Migración 007: Cálculo ICE manual (por cliente / período)
-- =============================================================================
-- Cada fila es un producto ingresado a mano para calcular su ICE. Se guarda
-- ligado a un cliente (que tiene mes+año). Las tarifas e IVA se derivan del
-- período del cliente al calcular.

CREATE TABLE IF NOT EXISTS ice_calc (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid,
  producto text DEFAULT '',
  categoria text DEFAULT 'ALCOHOLICA',   -- ALCOHOLICA | ARTESANAL | INDUSTRIAL
  por_cajas boolean DEFAULT true,
  cajas numeric DEFAULT 0,
  botellas_por_caja integer DEFAULT 12,
  unidades numeric DEFAULT 0,             -- botellas (si no es por cajas)
  grado numeric DEFAULT 0,
  capacidad numeric DEFAULT 750,          -- ml
  precio numeric DEFAULT 0,               -- precio por caja (si por_cajas) o por botella
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ice_calc_client_id ON ice_calc(client_id);
