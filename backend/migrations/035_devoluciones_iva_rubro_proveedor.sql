-- 035: Devolución de IVA — memoria del tipo de gasto por proveedor
--
-- El listado que entrega el portal del SRI trae la razón social y nada más: no
-- hay RUC, así que `clasificacion_excepciones` (que mapea por RUC) no sirve
-- acá. Y sin memoria, cada mes hay que volver a decir que Coral es
-- alimentación y que ETAPA es vivienda, para los mismos proveedores de siempre.
--
-- Esta tabla guarda lo que el usuario DECIDIÓ al guardar una solicitud, por
-- nombre normalizado. La próxima vez que ese proveedor aparezca en la grilla,
-- el tipo de gasto ya viene puesto. Las pistas por palabra clave quedan como
-- respaldo para el proveedor que todavía no se vio nunca.
--
-- Alcance: la empresa activa cuando hay una (el trabajo de clasificar es del
-- estudio, no de cada persona), y el usuario cuando no.

CREATE TABLE IF NOT EXISTS devoluciones_iva_rubro_proveedor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid,
  user_id uuid NOT NULL,
  -- Nombre del proveedor normalizado (mayúsculas, sin tildes, sin la
  -- repetición razón social + nombre comercial que duplica el portal).
  nombre_clave text NOT NULL,
  -- El nombre tal cual se vio la última vez, para poder mostrarlo/depurarlo.
  nombre_visto text,
  rubro text NOT NULL,
  -- Cuántas veces se confirmó: sirve para saber qué tan asentado está.
  veces integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Una fila por proveedor y por dueño del aprendizaje.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_iva_rubro_prov_org
  ON devoluciones_iva_rubro_proveedor (org_id, nombre_clave)
  WHERE org_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dev_iva_rubro_prov_user
  ON devoluciones_iva_rubro_proveedor (user_id, nombre_clave)
  WHERE org_id IS NULL;

ALTER TABLE devoluciones_iva_rubro_proveedor ENABLE ROW LEVEL SECURITY;
