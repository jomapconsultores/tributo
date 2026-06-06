-- =============================================================================
-- Migración 020: suscripciones y pagos (Fase 4 — cobro manual)
-- =============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id uuid PRIMARY KEY,
  plan text,
  precio_mensual numeric DEFAULT 0,
  estado text DEFAULT 'prueba',   -- prueba | activo | suspendido
  inicio date DEFAULT current_date,
  proximo_pago date,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pagos (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  monto numeric DEFAULT 0,
  fecha date DEFAULT current_date,
  periodo text,
  metodo text,
  nota text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagos_user ON pagos(user_id);
