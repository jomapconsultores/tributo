// Filtro de búsqueda de texto genérico para listas de filas/objetos.
// Conserva los items en los que el término buscado aparece (sin distinguir
// mayúsculas/minúsculas) en alguno de los campos que devuelva `fieldsFn` para ese item.
// `fieldsFn` recibe el item y debe devolver un array de valores a comparar.
export function filterBySearch(items, search, fieldsFn) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return items
  return items.filter((item) =>
    fieldsFn(item).some((f) => String(f || '').toLowerCase().includes(q))
  )
}
