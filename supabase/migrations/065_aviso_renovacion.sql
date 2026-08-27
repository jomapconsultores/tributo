-- ------------------------------------------------------------
-- Desarrollado por Marco Antonio Posligua San Martín
-- ------------------------------------------------------------
-- Al cliente se le avisa TRES DÍAS ANTES de que su plan se renueve, para que
-- nadie se entere de que hay que pagar el día que se le cierra la puerta.
--
-- El aviso lo manda un cron que corre todos los días, y un cron puede correr
-- dos veces: por reintento, por un despliegue a medias, o porque alguien lo
-- dispara a mano desde Actions. Esta columna guarda PARA QUÉ vencimiento se
-- avisó ya, de modo que el segundo pase del día no vuelva a escribirle al
-- cliente. Cuando el pago corre la fecha de `proximo_pago`, deja de coincidir
-- y el aviso del mes siguiente vuelve a salir solo.

alter table subscriptions add column if not exists aviso_renovacion date;

comment on column subscriptions.aviso_renovacion is
  'Vencimiento (proximo_pago) para el que ya se envió el aviso previo de renovación. Evita avisar dos veces por lo mismo.';
