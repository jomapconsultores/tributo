-- =============================================================================
-- Migración 032: ampliar la clave de variantes con unidad y país
-- =============================================================================
-- Se considera duplicado solo el mismo producto con la misma presentación,
-- capacidad, grado, unidad y país. Así se distinguen más variantes.
-- Seguro: amplía la clave anterior (superconjunto), las filas actuales la cumplen.
ALTER TABLE client_products DROP CONSTRAINT IF EXISTS client_products_user_variant_unique;
ALTER TABLE client_products ADD CONSTRAINT client_products_user_variant_unique
  UNIQUE (user_id, identificacion, nombre, presentacion, capacidad, grado, unidad, cod_pais);
