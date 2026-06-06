-- =============================================================================
-- Migración 018: claves únicas por usuario (multi-tenant Fase 1)
-- Permite que distintos usuarios manejen el mismo RUC/producto sin chocar.
-- =============================================================================
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_identificacion_periodo_key;
ALTER TABLE clients ADD CONSTRAINT clients_user_ident_periodo_key UNIQUE (user_id, identificacion, periodo_mes, periodo_anio);

ALTER TABLE client_products DROP CONSTRAINT IF EXISTS client_products_unique;
ALTER TABLE client_products ADD CONSTRAINT client_products_user_unique UNIQUE (user_id, identificacion, nombre);
