-- =============================================================================
-- Migración 002: Modelo por CLIENTES (contribuyentes / personas que se trabajan)
-- =============================================================================
-- El sistema deja de ser un único "bucket" de facturas y pasa a organizar todo
-- por cliente. Cada cliente (RUC/Cédula + Nombre) tiene sus propias facturas
-- debidamente clasificadas.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabla: clients (contribuyentes)
CREATE TABLE IF NOT EXISTS clients (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid,                              -- contador/usuario que lo creó (informativo)
  identificacion text NOT NULL,             -- RUC / Cédula / Pasaporte
  nombre text NOT NULL,
  tipo_identificacion text DEFAULT 'RUC',   -- RUC | CEDULA | PASAPORTE
  periodo text,                             -- período fiscal opcional (ej. "2025")
  notas text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT clients_identificacion_key UNIQUE (identificacion)
);

CREATE INDEX IF NOT EXISTS idx_clients_nombre ON clients(nombre);

-- Relacionar facturas con su cliente
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices(client_id);

-- En el modelo centrado en cliente, user_id deja de ser obligatorio
ALTER TABLE invoices ALTER COLUMN user_id DROP NOT NULL;

-- Empezar limpio: borrar facturas previas y reemplazar la unicidad
DELETE FROM invoices;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_user_id_unique_id_key;
ALTER TABLE invoices ADD CONSTRAINT invoices_client_unique_key UNIQUE (client_id, unique_id);
