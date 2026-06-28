-- =============================================================================
-- Migración 031: permitir variantes del mismo producto en el catálogo
-- =============================================================================
-- Antes la clave única era (user_id, identificacion, nombre), lo que impedía
-- guardar el MISMO producto con distinta presentación, capacidad o grado.
-- Se amplía la clave para incluir esas columnas: ahora solo se considera duplicado
-- el mismo producto con la MISMA presentación, capacidad y grado.
-- Es seguro: las filas actuales ya eran únicas por nombre (subconjunto), así que
-- cumplen la nueva clave (superconjunto) sin conflicto.
ALTER TABLE client_products DROP CONSTRAINT IF EXISTS client_products_user_unique;
ALTER TABLE client_products DROP CONSTRAINT IF EXISTS client_products_unique;
ALTER TABLE client_products ADD CONSTRAINT client_products_user_variant_unique
  UNIQUE (user_id, identificacion, nombre, presentacion, capacidad, grado);
