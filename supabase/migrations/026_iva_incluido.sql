-- Migración 026: campo iva_incluido por cliente en subscriptions
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS iva_incluido boolean DEFAULT false;
