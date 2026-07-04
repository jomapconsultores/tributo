import { useState } from 'react'

// Selección múltiple sobre una lista de filas (normalmente ya filtrada) con id.
// Encapsula solo el estado de selección y sus toggles; las acciones en bloque
// (mover, eliminar, etc.) quedan a cargo de quien use el hook.
export function useBulkSelection(items, getId = (item) => item.id) {
  const [selected, setSelected] = useState(() => new Set())

  const toggleSel = (id) => setSelected((prev) => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const allSelected = items.length > 0 && items.every((it) => selected.has(getId(it)))

  const toggleAll = () => setSelected((prev) => {
    if (items.every((it) => prev.has(getId(it)))) {
      const n = new Set(prev)
      items.forEach((it) => n.delete(getId(it)))
      return n
    }
    return new Set([...prev, ...items.map(getId)])
  })

  const clearSel = () => setSelected(new Set())

  return { selected, setSelected, toggleSel, allSelected, toggleAll, clearSel }
}
