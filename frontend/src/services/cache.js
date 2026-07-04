// Caché en memoria con TTL para requests de API.
// Evita re-fetches en navegación y deduplica llamadas concurrentes.
// Las promesas se cachean (no solo el resultado), así dos llamadas
// simultáneas al mismo key comparten el mismo fetch en vuelo.

const _store = new Map() // key → { promise, exp }

/**
 * Ejecuta `fn` y cachea la promesa resultante por `ttlMs` ms.
 * Si ya hay una promesa vigente para ese key, la devuelve directamente.
 * Los errores no se cachean: el siguiente llamado vuelve a intentar.
 *
 * @param {string} key    Clave única del recurso
 * @param {number} ttlMs  Tiempo de vida en milisegundos
 * @param {()=>Promise} fn  Función que devuelve la promesa de fetch
 */
export function withCache(key, ttlMs, fn) {
  const hit = _store.get(key)
  if (hit && Date.now() < hit.exp) return hit.promise
  const promise = fn().catch((e) => {
    _store.delete(key) // errores nunca se cachean
    throw e
  })
  _store.set(key, { promise, exp: Date.now() + ttlMs })
  return promise
}

/** Invalida una entrada específica del caché. */
export function bust(key) {
  _store.delete(key)
}

/** Invalida todas las entradas que empiecen con un prefijo. */
export function bustPrefix(prefix) {
  for (const k of _store.keys()) {
    if (k.startsWith(prefix)) _store.delete(k)
  }
}

/** Invalida todo el caché. Debe llamarse en login/logout: las claves no
 * incluyen user_id, así que sin esto un usuario nuevo podría heredar por
 * unos minutos los datos cacheados del usuario anterior en el mismo navegador. */
export function clearAll() {
  _store.clear()
}
