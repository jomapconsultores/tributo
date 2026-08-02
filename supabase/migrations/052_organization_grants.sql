-- =============================================================================
-- Migración 052: AUTORIZACIONES ENTRE EMPRESAS
-- =============================================================================
-- La migración 051 hizo de la empresa una frontera dura: ningún rol ve
-- contribuyentes de otra. Eso es lo correcto por defecto, pero deja sin resolver
-- un caso real: un contribuyente que se "exporta" a su propia empresa —para que
-- su gente entre a ver lo suyo— sale de la cartera del despacho que se lo lleva
-- trabajando, y ese despacho deja de verlo de golpe.
--
-- Esta tabla es la excepción EXPLÍCITA: la empresa DUEÑA de un contribuyente
-- autoriza a otra empresa a verlo. Sin una fila aquí no se cruza nada; con ella,
-- se cruza exactamente lo autorizado y nada más.
--
--   organization_grants
--     owner_org_id    empresa que POSEE los datos (la que autoriza)
--     grantee_org_id  empresa que RECIBE el acceso
--     identificacion  RUC concreto, o NULL = toda la cartera del dueño
--
-- Dentro de la empresa que recibe el acceso siguen aplicando sus reglas de rol:
-- esto abre la puerta de la empresa, no la del rol. Un 'cliente' de la empresa
-- receptora sigue viendo solo lo suyo y lo que le compartan por client_access.

CREATE TABLE IF NOT EXISTS organization_grants (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grantee_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  identificacion text,          -- NULL = toda la cartera del dueño
  nota text,                    -- para dejar dicho por qué se autorizó
  granted_by uuid,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT organization_grants_distintas CHECK (owner_org_id <> grantee_org_id)
);

-- Unicidad tratando NULL como "toda la cartera": sin el coalesce, dos filas con
-- identificacion NULL no chocarían y se podría autorizar la cartera entera
-- dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS organization_grants_unico
  ON organization_grants (owner_org_id, grantee_org_id, coalesce(identificacion, '*'));

CREATE INDEX IF NOT EXISTS idx_org_grants_grantee ON organization_grants(grantee_org_id);
CREATE INDEX IF NOT EXISTS idx_org_grants_owner   ON organization_grants(owner_org_id);

-- Mismo criterio que el resto del esquema: RLS activado y sin políticas. El
-- backend entra con la service key (que omite RLS) y nadie más llega.
ALTER TABLE organization_grants ENABLE ROW LEVEL SECURITY;
