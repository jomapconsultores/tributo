-- Habilitar UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Tabla: classification_map (Mapa RUC → Categoría)
CREATE TABLE IF NOT EXISTS classification_map (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES auth.users NOT NULL,
  ruc text NOT NULL,
  nombre_proveedor text,
  categoria text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, ruc)
);

-- Tabla: invoices (Facturas procesadas)
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES auth.users NOT NULL,
  unique_id text NOT NULL,
  estado text DEFAULT 'OK',
  fecha text,
  ruc_proveedor text,
  factura_numero text,
  nombre_proveedor text,
  clasificacion text DEFAULT 'SIN CLASIFICAR',
  concepto text,
  forma_pago text,
  tarjeta_credito text,
  no_objeto_iva numeric DEFAULT 0,
  exento_iva numeric DEFAULT 0,
  base_0 numeric DEFAULT 0,
  base_15 numeric DEFAULT 0,
  iva_15 numeric DEFAULT 0,
  base_5 numeric DEFAULT 0,
  iva_5 numeric DEFAULT 0,
  desc_info numeric DEFAULT 0,
  desc_manual numeric DEFAULT 0,
  total numeric DEFAULT 0,
  destinatario text,
  ruc_comprador text,
  xml_content text,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, unique_id)
);

-- Tabla: card_memory (Memoria de tarjetas)
CREATE TABLE IF NOT EXISTS card_memory (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES auth.users NOT NULL,
  mem_key text NOT NULL,
  tarjeta_credito text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, mem_key)
);

-- Row Level Security (RLS) para classification_map
ALTER TABLE classification_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own classification map"
ON classification_map FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own classification map"
ON classification_map FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own classification map"
ON classification_map FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own classification map"
ON classification_map FOR DELETE
USING (auth.uid() = user_id);

-- Row Level Security (RLS) para invoices
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own invoices"
ON invoices FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own invoices"
ON invoices FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own invoices"
ON invoices FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own invoices"
ON invoices FOR DELETE
USING (auth.uid() = user_id);

-- Row Level Security (RLS) para card_memory
ALTER TABLE card_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own card memory"
ON card_memory FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own card memory"
ON card_memory FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own card memory"
ON card_memory FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own card memory"
ON card_memory FOR DELETE
USING (auth.uid() = user_id);

-- Índices para mejorar performance
CREATE INDEX idx_classification_map_user_id ON classification_map(user_id);
CREATE INDEX idx_invoices_user_id ON invoices(user_id);
CREATE INDEX idx_invoices_fecha ON invoices(fecha);
CREATE INDEX idx_invoices_ruc ON invoices(ruc_proveedor);
CREATE INDEX idx_card_memory_user_id ON card_memory(user_id);
