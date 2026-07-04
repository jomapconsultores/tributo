import { useState, useEffect, useCallback, useRef } from 'react'
import { withCache, bust } from '../services/cache'

/**
 * useCachedResource — igual patrón que AccessContext/ClientContext repetían
 * cada uno por su cuenta: pedir algo con withCache, y en error no confundir
 * "falló la carga" con "vino vacío".
 *
 * `key`/`ttlMs`/`fetchFn` van directo a withCache. `transform(res)` convierte
 * la respuesta cruda al shape que necesita el consumidor (o null para usar la
 * respuesta tal cual). Devuelve { data, setData, loading, error, reload }.
 * `reload(true)` invalida el caché (bust) y vuelve a pedir.
 */
export default function useCachedResource(key, ttlMs, fetchFn, transform) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const transformRef = useRef(transform)
  transformRef.current = transform

  const load = useCallback(async (force = false) => {
    if (force) bust(key)
    setLoading(true)
    setError('')
    try {
      const res = await withCache(key, ttlMs, fetchFn)
      const out = transformRef.current ? transformRef.current(res) : res
      setData(out)
      return out
    } catch (e) {
      // No relanza: igual que el código que reemplaza (AccessContext/ClientContext
      // ya atrapaban el error internamente), para que un fallo al refrescar no
      // rompa una mutación que ya tuvo éxito (create/update/delete) y solo
      // llama reload() para refrescar la lista después.
      setError(e.response?.data?.detail || e.message)
      return null
    } finally {
      setLoading(false)
    }
  }, [key, ttlMs, fetchFn])

  useEffect(() => { load() }, [load])

  return { data, setData, loading, error, reload: load }
}
