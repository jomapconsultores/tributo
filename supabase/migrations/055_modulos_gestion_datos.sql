-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- Módulos 'gestion' (informe general, facturación y honorarios, capacitaciones)
-- y 'datos' (contribuyentes, compradores).
--
-- Esas pantallas no tenían permiso ninguno: las veía cualquiera con sesión.
-- Ahora lo tienen, y para que nadie pierda de un día para otro lo que hoy usa,
-- esta migración se los concede a quien YA tiene módulos asignados. Los que se
-- agreguen después entran sin ellos, y el administrador reparte.
--
-- Compradores pasa de 'ingresos_ice' a 'datos' (ice_compradores → dat_compradores):
-- es una ficha de datos, y atarla a ICE obligaba a contratar ICE para verla.

-- Módulos globales del usuario
insert into user_modules (user_id, modulo, activo)
select distinct um.user_id, m.modulo, true
from user_modules um
cross join (values ('gestion'), ('datos')) as m(modulo)
where not exists (
  select 1 from user_modules x where x.user_id = um.user_id and x.modulo = m.modulo
);

-- Módulos de cada membresía de empresa
insert into organization_member_modules (org_id, user_id, modulo, activo)
select distinct mm.org_id, mm.user_id, m.modulo, true
from organization_member_modules mm
cross join (values ('gestion'), ('datos')) as m(modulo)
where not exists (
  select 1 from organization_member_modules x
  where x.org_id = mm.org_id and x.user_id = mm.user_id and x.modulo = m.modulo
);

-- Quien tuviera restringido el submódulo de compradores conserva la restricción
-- con su nombre nuevo. (Hoy no hay ninguna fila, pero la migración no puede
-- darlo por hecho: aplicarla más tarde, o sobre otra base, sí puede encontrarlas.)
insert into user_submodules (user_id, submodulo)
select us.user_id, 'dat_compradores' from user_submodules us
where us.submodulo = 'ice_compradores'
  and not exists (select 1 from user_submodules x
                  where x.user_id = us.user_id and x.submodulo = 'dat_compradores');
delete from user_submodules where submodulo = 'ice_compradores';

insert into organization_member_submodules (org_id, user_id, submodulo)
select os.org_id, os.user_id, 'dat_compradores' from organization_member_submodules os
where os.submodulo = 'ice_compradores'
  and not exists (select 1 from organization_member_submodules x
                  where x.org_id = os.org_id and x.user_id = os.user_id
                    and x.submodulo = 'dat_compradores');
delete from organization_member_submodules where submodulo = 'ice_compradores';
