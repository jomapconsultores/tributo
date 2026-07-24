import { useCallback, useEffect } from 'react'
import useCachedResource from './useCachedResource'
import { declaracionesAPI } from '../services/api'
import { bust } from '../services/cache'

const CACHE_KEY = 'decl-estado-todos'
const TTL = 60 * 1000  // 1 min: se refresca solo tras marcar una declaración (ver refrescarPresentadas)
export const EVENTO_PRESENTADA = 'decl-presentada-cambiada'

/**
 * useDeclPresentadas — estado de presentación de TODOS los contribuyentes
 * visibles, keyed por identificación (RUC/cédula). Sirve para que los badges de
 * vencimiento en las listas (selector de cliente, datos guardados, credenciales)
 * dejen de marcar plazo/pendiente cuando ese contribuyente ya presentó todo al SRI.
 *
 * Se cachea en memoria y se comparte entre módulos (una sola request). Tras
 * marcar una declaración como presentada, llamar refrescarPresentadas() para
 * invalidar el caché.
 *
 * Devuelve { estaPresentada(identificacion) -> bool, estadoDe(id) -> obj|null, ... }.
 */
export default function useDeclPresentadas() {
  const { data, loading, error, reload } = useCachedResource(
    CACHE_KEY, TTL, declaracionesAPI.estadoTodos, (res) => res.data?.data || {},
  )
  // Refrescar en vivo cuando otra pantalla marca una declaración como presentada.
  useEffect(() => {
    const onCambio = () => reload(true)
    window.addEventListener(EVENTO_PRESENTADA, onCambio)
    return () => window.removeEventListener(EVENTO_PRESENTADA, onCambio)
  }, [reload])
  const mapa = data || {}
  const estadoDe = useCallback(
    (identificacion) => mapa[(identificacion || '').trim()] || null,
    [mapa],
  )
  const estaPresentada = useCallback(
    (identificacion) => !!estadoDe(identificacion)?.todo_presentado,
    [estadoDe],
  )
  return { mapa, estadoDe, estaPresentada, loading, error, reload }
}

/** Invalida el caché del estado de presentación y avisa a las pantallas montadas.
 *  Llamar tras marcar/desmarcar una declaración como presentada al SRI. */
export function refrescarPresentadas() {
  bust(CACHE_KEY)
  window.dispatchEvent(new Event(EVENTO_PRESENTADA))
}
