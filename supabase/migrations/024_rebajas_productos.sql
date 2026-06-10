-- =============================================================================
-- Migración 024: Rebajas y exenciones ICE — condiciones normativas por producto
-- =============================================================================
-- Condiciones de la LRTI y su Reglamento para aplicar beneficios ICE:
--  - es_cerveza + nueva_marca: Art. 82 LRTI / Art. 199.5 RLRTI — para cervezas
--    la rebaja del 50% de la tarifa específica solo aplica a NUEVAS MARCAS
--    (sin marca primigenia registrada + nueva notificación sanitaria).
--  - cupo_anual_sri: Art. 77.1 LRTI / Art. 199.4 RLRTI — la EXENCIÓN requiere
--    haber obtenido el cupo anual del SRI (además de las condiciones de la
--    rebaja: ≥70% de ingredientes nacionales de artesanos/MIPYME/EPS).

CREATE TABLE IF NOT EXISTS rebajas_productos (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,
  identificacion text NOT NULL,
  producto text NOT NULL,
  es_cerveza boolean DEFAULT false,
  nueva_marca boolean DEFAULT false,
  cupo_anual_sri boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (user_id, identificacion, producto)
);

CREATE INDEX IF NOT EXISTS idx_rebajas_prod_ident ON rebajas_productos(identificacion);
