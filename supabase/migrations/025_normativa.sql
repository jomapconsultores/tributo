-- =============================================================================
-- Migración 025: Biblioteca de normativa (LRTI, Reglamento, normativa vigente)
-- =============================================================================
-- Cuerpos legales presentados como libro consultable: texto extraído por página
-- (para búsqueda) + PDF original en el bucket 'normativa'. Los documentos son
-- reemplazables: subir una nueva versión regenera las páginas.

CREATE TABLE IF NOT EXISTS normativa_docs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug text UNIQUE NOT NULL,
  titulo text NOT NULL,
  descripcion text DEFAULT '',
  archivo_nombre text DEFAULT '',
  num_paginas int DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS normativa_paginas (
  doc_id uuid REFERENCES normativa_docs(id) ON DELETE CASCADE,
  pagina int NOT NULL,
  texto text DEFAULT '',
  PRIMARY KEY (doc_id, pagina)
);

-- Bucket público para los PDF originales (el backend sube con service key)
INSERT INTO storage.buckets (id, name, public)
VALUES ('normativa', 'normativa', true)
ON CONFLICT (id) DO NOTHING;
