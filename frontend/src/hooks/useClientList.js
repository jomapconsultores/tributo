import { useState, useEffect, useCallback } from 'react'

// Carga una lista filtrada por el cliente seleccionado, con el loading/error
// estándar que se repetía en varias páginas (ICE, Retenciones, Ingresos IVA,
// Cálculo ICE): useState(rows) + useState(loading) + useState(error) +
// useCallback(load) + useEffect(load). Si no hay `selectedClientId`, vacía los
// datos sin llamar a la API.
//
//   const { data: rows, loading, error, reload: load } =
//     useClientList(iceAPI.list, selectedClientId, { errorMessage: 'Error al cargar ICE' })
//
// - `fetchFn`: función que recibe el id del cliente y retorna la promesa axios
//   de la lista (ej. `retentionsAPI.list`). Debe ser una referencia estable
//   (el método del servicio tal cual, no un arrow inline que capture variables
//   del render) para no recargar de más.
// - `opts.errorMessage`: prefijo del mensaje de error mostrado al usuario.
// - `opts.deps`: dependencias extra para recargar (además de selectedClientId).
export function useClientList(fetchFn, selectedClientId, opts = {}) {
  const { errorMessage = 'Error al cargar', deps = [] } = opts
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (!selectedClientId) { setData([]); return }
    setLoading(true); setError('')
    try {
      const res = await fetchFn(selectedClientId)
      setData(res.data?.data || [])
    } catch (err) {
      setError(`${errorMessage}: ${err.response?.data?.detail || err.message}`)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, fetchFn, errorMessage, ...deps])

  useEffect(() => { reload() }, [reload])

  return { data, setData, loading, error, reload }
}

export default useClientList
