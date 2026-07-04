// Filtro de búsqueda compartido para listas de clientes/contribuyentes.
// Busca coincidencia (case-insensitive) en nombre e identificación.
export function filtrarClientesPorTexto(clients, search) {
  const q = (search || '').trim().toLowerCase()
  if (!q) return clients
  return clients.filter((c) =>
    [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q))
  )
}
