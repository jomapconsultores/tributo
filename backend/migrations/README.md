# Esta carpeta NO se despliega

Las migraciones que se aplican son las de **`supabase/migrations/`**. Es lo que
dicen el README y el SETUP, y es lo único que mira `deploy_db.py`.

Los siete `.sql` que hay acá se escribieron en esta carpeta y quedaron fuera de
ese camino: se aplicaron a mano en producción y ninguna instalación nueva las
habría corrido. El módulo de Devolución de IVA, los honorarios por período y el
origen de los ingresos ICE existían solo en la base de producción.

Se portaron a `supabase/migrations/` el 2026-08-16 (053 a 059). **Los archivos
de acá quedan como histórico y no hay que tocarlos**: editarlos no cambia nada
en ninguna base.

## Una migración nueva va en `supabase/migrations/`

Con el número siguiente al último. Si tiene que correr antes de una que ya
existe —porque otra migración posterior toca lo que estás creando—, se puede
intercalar con una letra (`008a`, `019a`); el orden es alfabético.

## Comprobar que el repositorio puede reconstruir la base

Lo que falló acá no fue el SQL sino que nadie lo notaba. Para verlo:

```sql
-- Tablas y columnas que hay de verdad, para comparar contra las migraciones
select table_name || ': ' || string_agg(column_name, ',' order by column_name)
  from information_schema.columns
 where table_schema = 'public'
 group by table_name order by table_name;
```

Si algo sale en esa lista y no en las migraciones, es una tabla o una columna
que se creó a mano y que una instalación limpia no tendría.
