import { useState, useEffect, useRef } from 'react'

/**
 * useDraft — igual que useState, pero el valor se guarda al instante en el
 * navegador (localStorage). Sobrevive a cortes de internet, recargas y cierres
 * accidentales: la información que escribes NO se pierde.
 *
 *   const [valor, setValor] = useDraft(`draft:reportes:${ruc}`, 0)
 *
 * - `key`: identificador único del borrador (incluye el cliente/período para no
 *   mezclar datos). Si es null/'' no persiste (se comporta como useState normal).
 * - Cuando cambia la `key` (p.ej. cambias de contribuyente) recarga el borrador
 *   correspondiente.
 * - `clearDraft(key)` borra el borrador (úsalo tras guardar con éxito en el servidor).
 */
function read(key, initial) {
  if (!key) return typeof initial === 'function' ? initial() : initial
  try {
    const raw = localStorage.getItem(key)
    if (raw != null) return JSON.parse(raw)
  } catch { /* localStorage no disponible o JSON inválido */ }
  return typeof initial === 'function' ? initial() : initial
}

export function clearDraft(key) {
  if (!key) return
  try { localStorage.removeItem(key) } catch { /* noop */ }
}

/** Borra todos los borradores que empiecen por un prefijo (p.ej. al guardar todo un módulo). */
export function clearDraftsByPrefix(prefix) {
  if (!prefix) return
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) localStorage.removeItem(k)
    }
  } catch { /* noop */ }
}

export default function useDraft(key, initial) {
  const [value, setValue] = useState(() => read(key, initial))
  const keyRef = useRef(key)

  // Si cambia la key (otro contribuyente/período), recargar su borrador.
  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key
      setValue(read(key, initial))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Persistir cada cambio al instante.
  useEffect(() => {
    if (!key) return
    try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* noop */ }
  }, [key, value])

  return [value, setValue]
}
