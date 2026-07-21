-- =============================================================================
-- Migración 050: Excepción de clasificación por CONTRIBUYENTE + PERÍODO
-- =============================================================================
-- La clasificación de gastos es un catálogo GLOBAL por RUC (classification_map):
-- al clasificar un proveedor, su categoría se aplica a TODAS sus facturas de todo
-- el equipo. A veces se necesita, de forma EXCEPCIONAL, que un proveedor se
-- clasifique DISTINTO solo para un contribuyente y solo para un período (p. ej.
-- tratar ese gasto como personal para excluirlo del crédito de IVA en ese período,
-- sin afectar cómo se clasifica ese RUC en el resto).
--
-- Como cada `clients` row es un contribuyente EN UN PERÍODO (mes o semestre), y
-- cada `invoices` cuelga de un `client_id`, una excepción por (client_id, ruc)
-- queda acotada exactamente a "esta persona y este período". La categoría se
-- MATERIALIZA en invoices.clasificacion de ese client_id (que es lo que leen la
-- declaración y el reporte), sin tocar el mapa global.
--
-- La excepción se guarda para poder REVERTIRLA y para PROTEGERLA: una edición
-- global del RUC (propagación) NO debe pisar los períodos con excepción.
-- No se aplica a cargas futuras (por diseño): solo reclasifica lo ya cargado.
-- =============================================================================
CREATE TABLE IF NOT EXISTS clasificacion_excepciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ruc text NOT NULL,
  categoria text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (client_id, ruc)
);

CREATE INDEX IF NOT EXISTS idx_clasif_excep_client ON clasificacion_excepciones(client_id);
CREATE INDEX IF NOT EXISTS idx_clasif_excep_ruc ON clasificacion_excepciones(ruc);
