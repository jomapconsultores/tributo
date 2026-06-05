import { useState } from 'react'
import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import NewClientModal from './NewClientModal'
import './BulkBar.css'

/**
 * Barra de acciones masivas para filas seleccionadas: mover a otro cliente,
 * eliminar en masa o deseleccionar.
 */
export default function BulkBar({ count, onMove, onDelete, onClear }) {
  const { clients, selectedClientId } = useClients()
  const [moveTo, setMoveTo] = useState('')
  const [showNew, setShowNew] = useState(false)

  if (count === 0) return null
  const targets = clients.filter((c) => c.id !== selectedClientId)

  const handleSelect = (e) => {
    const v = e.target.value
    if (v === '__new__') {
      setShowNew(true)        // abre el formulario de cliente; no cambia moveTo
    } else {
      setMoveTo(v)
    }
  }

  return (
    <div className="bulk-bar">
      <span className="bulk-count">✓ {count} seleccionada(s)</span>
      <div className="bulk-actions">
        <select className="bulk-select" value={moveTo} onChange={handleSelect}>
          <option value="">Mover a cliente…</option>
          {targets.map((c) => (
            <option key={c.id} value={c.id}>{c.nombre} · {periodoCorto(c)}</option>
          ))}
          <option value="__new__">➕ Crear nuevo cliente…</option>
        </select>
        <button className="bulk-btn move" disabled={!moveTo} onClick={() => { onMove(moveTo); setMoveTo('') }}>
          ↪ Mover
        </button>
        <button className="bulk-btn del" onClick={onDelete}>🗑 Eliminar</button>
        <button className="bulk-btn ghost" onClick={onClear}>Deseleccionar</button>
      </div>

      {/* Crear cliente sin cambiar el que se está viendo; queda elegido como destino */}
      <NewClientModal
        open={showNew}
        selectAfter={false}
        onClose={() => setShowNew(false)}
        onCreated={(c) => { if (c?.id) setMoveTo(c.id) }}
      />
    </div>
  )
}
