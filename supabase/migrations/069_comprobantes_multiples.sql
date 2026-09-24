-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- Migración 069: un pago puede venir en VARIOS comprobantes, y hay que saber
-- si el aviso al administrador salió o no.
--
-- El primer pago real que entró por este camino lo dejó claro: la clienta pagó
-- la mensualidad en dos transferencias y solo pudo adjuntar una foto, así que
-- escribió la otra a mano en la nota («se pagó en 2 transferencias, la otra es
-- de 7.50») y el cobro se asentó corto hasta corregirlo. Con un solo archivo
-- por envío, partir un pago obliga a mandar dos veces lo mismo o a fiarse de
-- una nota escrita a mano.
--
-- `comprobantes` guarda la lista completa [{path, nombre, subido}]. Las
-- columnas comprobante_path/comprobante_nombre se conservan apuntando al
-- PRIMER archivo: hay código —y filas ya guardadas— que las leen, y romperlas
-- para ganar una lista no vale la pena.
alter table pagos_reportados
  add column if not exists comprobantes jsonb not null default '[]'::jsonb;

-- Si el correo al administrador falla (hoy mismo: SMTP rechazado por Gmail),
-- el comprobante igual queda guardado y la insignia aparece. Pero sin dejar
-- constancia, nadie sabe que el aviso NO salió: el administrador cree que le
-- avisarían y el cliente cree que ya le avisaron. Acá queda registrado, y el
-- panel lo muestra.
alter table pagos_reportados
  add column if not exists aviso_admin_ok boolean;
alter table pagos_reportados
  add column if not exists aviso_admin_error text;

-- Las filas que ya existían pasan a la lista, para que todo el código nuevo
-- pueda leer un solo sitio.
update pagos_reportados
   set comprobantes = jsonb_build_array(
         jsonb_build_object('path', comprobante_path,
                            'nombre', coalesce(comprobante_nombre, 'comprobante'),
                            'subido', coalesce(created_at, now())))
 where comprobante_path is not null
   and comprobantes = '[]'::jsonb;

comment on column pagos_reportados.comprobantes is
  'Archivos del pago: [{path, nombre, subido}]. Un pago partido en varias transferencias lleva uno por cada una.';
comment on column pagos_reportados.aviso_admin_ok is
  'Si el correo de aviso al administrador se pudo enviar. NULL = no se intentó.';
