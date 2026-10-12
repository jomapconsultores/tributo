import { useState, useEffect } from 'react'

// Orden elegido para una lista de contribuyentes: 'nombre' | 'vencimiento'.
// Se recuerda por pantalla (storageKey) para no tener que volver a elegirlo.
export default function useOrdenLista(storageKey, inicial = 'nombre') {
  const [orden, setOrden] = useState(() => {
    try { return localStorage.getItem(storageKey) || inicial } catch { return inicial }
  })
  useEffect(() => { try { localStorage.setItem(storageKey, orden) } catch { /* ignore */ } }, [storageKey, orden])
  return [orden, setOrden]
}
