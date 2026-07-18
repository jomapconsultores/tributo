import { useState, useRef, useEffect, useMemo } from 'react'
import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import './ClientSwitcher.css'

export default function ClientSwitcher({ onNewClient, idents_svc = null }) {
  const { clients, selectedClientId, selectClient } = useClients()
  const current = clients.find((c) => c.id === selectedClientId)
  const ident = current?.identificacion || ''

  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState({}) // identificacion -> mostrar sus períodos
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
      if (idents_svc && !idents_svc.has(c.identificacion)) continue
      if (!vistos.has(c.identificacion)) { vistos.add(c.identificacion); out.push(c) }
    }
    return out.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  }, [clients, idents_svc])

  const filtered = useMemo(() => filtrarClientesPorTexto(contribs, search), [contribs, search])

  const periodosDe = (identificacion) => clients
    .filter((c) => c.identificacion === identificacion)
    .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))

  const periodos = useMemo(() => periodosDe(ident), [clients, ident]) // eslint-disable-line react-hooks/exhaustive-deps

  // Elegir contribuyente = seleccionar su período más reciente y cerrar.
  const elegir = (identificacion) => {
    const list = periodosDe(identificacion)
    if (list[0]) selectClient(list[0].id)
    setOpen(false)
    setSearch('')
  }

  // Elegir un período concreto (desde la lista desplegada bajo el contribuyente).
  const elegirPeriodo = (clientId) => {
    selectClient(clientId)
    setOpen(false)
    setSearch('')
  }

  const toggleExpand = (identificacion) =>
    setExpanded((o) => ({ ...o, [identificacion]: !o[identificacion] }))

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
          onFocus={() => { setSearch(''); setOpen(true); if (ident) setExpanded((o) => ({ ...o, [ident]: true })) }}
          title={current ? `${current.identificacion} — ${current.nombre}` : ''}
        />
        <span className="cs-combo-caret">▾</span>

        {open && (
          <div className="cs-dropdown">
            {filtered.length === 0 ? (
              <div className="cs-drop-empty">Sin resultados para "{search}"</div>
            ) : filtered.map((c) => {
              const pers = periodosDe(c.identificacion)
              const isExp = !!expanded[c.identificacion]
              const esActivo = c.identificacion === ident
              return (
                <div key={c.identificacion} className="cs-drop-group">
                  <div className={`cs-drop-item ${esActivo ? 'active' : ''}`}>
                    <button
                      className="cs-drop-caret"
                      title={isExp ? 'Contraer períodos' : 'Ver períodos'}
                      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpand(c.identificacion) }}
                    >
                      <span className={`cs-caret ${isExp ? 'open' : ''}`}>▸</span>
                    </button>
                    <button className="cs-drop-main" onMouseDown={() => elegir(c.identificacion)}>
                      <span className="cs-drop-name">{c.nombre}</span>
                      <span className="cs-drop-ruc">{c.identificacion}</span>
                      <span className="cs-drop-count">{pers.length} período{pers.length !== 1 ? 's' : ''}</span>
                    </button>
                  </div>
                  {isExp && (
                    <div className="cs-drop-periods">
                      {pers.map((p) => (
                        <button
                          key={p.id}
                          className={`cs-drop-period ${p.id === selectedClientId ? 'active' : ''}`}
                          onMouseDown={() => elegirPeriodo(p.id)}
                        >
                          <span className="cs-drop-period-dot">•</span>{periodoCorto(p)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            <button className="cs-drop-new" onMouseDown={() => { onNewClient?.(); setOpen(false) }}>
              ＋ Nuevo cliente…
            </button>
          </div>
        )}
      </div>

      {/* RUC / cédula del contribuyente seleccionado (visible junto al nombre) */}
      {current?.identificacion && (
        <span className="cs-ruc-tag" title="RUC / Cédula del contribuyente">
          <span className="cs-ruc-label">RUC</span>
          {current.identificacion}
        </span>
      )}

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
