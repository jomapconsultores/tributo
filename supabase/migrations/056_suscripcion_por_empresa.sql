-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- La suscripción pasa a poder ser DE UNA EMPRESA.
--
-- `subscriptions` tenía la clave primaria en user_id: una fila por persona y
-- ninguna sin persona. Con multiempresa quien contrata es la empresa —un
-- contribuyente que se independiza paga lo suyo, y su gente entra y sale sin
-- que la suscripción se mueva—, así que la fila tiene que poder colgar de la
-- empresa y no de nadie más.
--
-- Se conserva lo existente: las filas de usuario siguen siendo únicas por
-- usuario, y las de empresa, únicas por empresa.

alter table subscriptions drop constraint if exists subscriptions_pkey;
alter table subscriptions add column if not exists id uuid default uuid_generate_v4();
update subscriptions set id = uuid_generate_v4() where id is null;
alter table subscriptions alter column id set not null;
alter table subscriptions add primary key (id);
alter table subscriptions alter column user_id drop not null;

create unique index if not exists subscriptions_user_uidx
  on subscriptions (user_id) where user_id is not null and org_id is null;
create unique index if not exists subscriptions_org_uidx
  on subscriptions (org_id) where org_id is not null;

alter table subscriptions drop constraint if exists subscriptions_titular_chk;
alter table subscriptions add constraint subscriptions_titular_chk
  check (user_id is not null or org_id is not null);

-- Los pagos también pueden ser de una empresa.
alter table pagos add column if not exists org_id uuid references organizations(id) on delete set null;
alter table pagos alter column user_id drop not null;
alter table pagos drop constraint if exists pagos_titular_chk;
alter table pagos add constraint pagos_titular_chk
  check (user_id is not null or org_id is not null);
create index if not exists pagos_org_idx on pagos (org_id);
