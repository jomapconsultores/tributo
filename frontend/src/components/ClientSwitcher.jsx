import { useState, useRef, useEffect, useMemo } from 'react'
import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import './ClientSwitcher.css'

export default function ClientSwitcher({ onNewClient }) {
  const { clients, selectedClientId, selectClient } = useClients()
  const current = clients.find((c) => c.id === selectedClientId)
  const ident = current?.identificacion || ''

  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  // Cerrar al hacer click fuera
  useEffect(() => {
    const fn = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])

  const contribs = useMemo(() => {
    const vistos = new Set()
    const out = []
    for (const c of clients) {
      if (!vistos.has(c.identificacion)) { vistos.add(c.identificacion); out.push(c) }
    }
    return out.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  }, [clients])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return contribs
    return contribs.filter((c) =>
      [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [contribs, search])

  const periodos = useMemo(() =>
    clients
      .filter((c) => c.identificacion === ident)
      .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes)),
    [clients, ident]
  )

  const elegir = (identificacion) => {
    const list = clients
      .filter((c) => c.identificacion === identificacion)
      .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))
    if (list[0]) selectClient(list[0].id)
    setOpen(false)
    setSearch('')
  }

  const cambiarPeriodo = (e) => {
    const v = e.target.value
    if (v === '__new__') onNewClient?.()
    else selectClient(v)
  }

  const displayValue = open ? search : (current?.nombre || '')

  return (
    <div className="cs">
      <button className="cs-back" onClick={() => selectClient(null)} title="Volver al listado">
        ← Volver
      </button>

      {/* Buscador de contribuyente */}
      <div className="cs-combo" ref={wrapRef}>
        <input
          className="cs-combo-input"
          value={displayValue}
          placeholder="Buscar contribuyente…"
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => { setSearch(''); setOpen(true) }}
          title={current ? `${current.identificacion} — ${current.nombre}` : ''}
        />
        <span className="cs-combo-caret">▾</span>

        {open && (
          <div className="cs-dropdown">
            {filtered.length === 0 ? (
              <div className="cs-drop-empty">Sin resultados para "{search}"</div>
            ) : filtered.map((c) => (
              <button
                key={c.identificacion}
                className={`cs-drop-item ${c.identificacion === ident ? 'active' : ''}`}
                onMouseDown={() => elegir(c.identificacion)}
              >
                <span className="cs-drop-name">{c.nombre}</span>
                <span className="cs-drop-ruc">{c.identificacion}</span>
              </button>
            ))}
            <button className="cs-drop-new" onMouseDown={() => { onNewClient?.(); setOpen(false) }}>
              ＋ Nuevo cliente…
            </button>
          </div>
        )}
      </div>

      {/* Selector de período (se mantiene como select) */}
      <select className="cs-sel cs-per" value={selectedClientId || ''} onChange={cambiarPeriodo}>
        {periodos.map((c) => (
          <option key={c.id} value={c.id}>{periodoCorto(c)}</option>
        ))}
        <option value="__new__">＋ Otro período…</option>
      </select>
    </div>
  )
}
