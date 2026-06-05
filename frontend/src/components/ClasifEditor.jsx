import { useState, useMemo } from 'react'

/**
 * Editor de clasificación con búsqueda por prefijo.
 * - Si la factura está SIN CLASIFICAR, arranca vacío y listo para buscar.
 * - Al escribir "ma" lista todas las categorías que EMPIEZAN con "ma".
 * - Permite elegir de la lista o crear una nueva (siempre en MAYÚSCULAS).
 */
export default function ClasifEditor({ initial, options, onCommit, onCancel }) {
  const startVal = !initial || initial === 'SIN CLASIFICAR' ? '' : initial
  const [text, setText] = useState(startVal)
  const [hi, setHi] = useState(-1)

  const q = text.trim().toUpperCase()
  const filtered = useMemo(() => {
    const list = q ? options.filter((o) => o.toUpperCase().startsWith(q)) : options
    return list.slice(0, 50)
  }, [options, q])

  const commit = (val) => {
    const v = (val ?? text).trim().toUpperCase()
    if (!v) { onCancel(); return }
    onCommit(v)
  }

  return (
    <div className="clasif-combo">
      <input
        autoFocus
        className="cell-edit"
        value={text}
        placeholder="Buscar o crear…"
        onChange={(e) => { setText(e.target.value.toUpperCase()); setHi(-1) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(hi >= 0 ? filtered[hi] : text) }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
        }}
        onBlur={() => setTimeout(() => commit(), 150)}
      />
      {filtered.length > 0 && (
        <ul className="clasif-list">
          {filtered.map((o, i) => (
            <li
              key={o}
              className={i === hi ? 'active' : ''}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(o) }}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
