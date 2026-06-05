-- =============================================================================
-- Migración 012: Rebajas y exenciones ICE — ingredientes por producto
-- =============================================================================
-- Por contribuyente y producto, se listan los ingredientes (por botella/envase)
-- indicando origen (nacional/externo) y si es calificado, para calcular el
-- porcentaje de materia prima nacional. El agua no se considera en el cálculo.

CREATE TABLE IF NOT EXISTS rebajas_ingredientes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,
  producto text NOT NULL,
  ingrediente text NOT NULL,
  cantidad numeric DEFAULT 0,
  unidad text DEFAULT 'ml',
  origen text DEFAULT 'NACIONAL',   -- NACIONAL | EXTERNO
  calificado boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rebajas_ident ON rebajas_ingredientes(identificacion);
