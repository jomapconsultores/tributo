import { useState, useMemo } from 'react'
import { useClients } from '../context/ClientContext'
import { periodoLargo } from '../utils/periodo'
import './ClientPickerScreen.css'

const initials = (nombre) => {
  const w = (nombre || '').trim().split(/\s+/).filter(Boolean)
  if (!w.length) return '?'
  return w.length === 1 ? w[0][0].toUpperCase() : (w[0][0] + w[1][0]).toUpperCase()
}

// Color del avatar según primera letra (paleta consistente)
const AVATAR_COLORS = [
  '#3b82f6','#8b5cf6','#ec4899','#10b981',
  '#f59e0b','#06b6d4','#6366f1','#ef4444',
]
const avatarColor = (nombre) => {
  const code = (nombre || 'A').charCodeAt(0)
  return AVATAR_COLORS[code % AVATAR_COLORS.length]
}

export default function ClientPickerScreen({ icon, title, subtitle, idents_svc, onNewClient, svcLabel }) {
  const { clients, selectClient } = useClients()
  const [search, setSearch] = useState('')

  const visible = useMemo(() => {
    const base = idents_svc ? clients.filter((c) => idents_svc.has(c.identificacion)) : []
    if (!search.trim()) return base
    const q = search.toLowerCase()
    return base.filter((c) =>
      [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [clients, idents_svc, search])

  return (
    <div className="cps-page">
      {/* Hero */}
      <div className="cps-hero">
        <span className="cps-hero-icon">{icon}</span>
        <h1 className="cps-hero-title">{title}</h1>
        {subtitle && <p className="cps-hero-sub">{subtitle}</p>}
        <button className="cps-hero-btn" onClick={onNewClient}>＋ Nuevo cliente</button>
      </div>

      {/* Panel de búsqueda + lista */}
      <div className="cps-panel">
        {idents_svc === null ? (
          <div className="cps-state">
            <span className="cps-spinner" />
            <span>Verificando acceso…</span>
          </div>
        ) : idents_svc.size === 0 ? (
          <div className="cps-state cps-state--empty">
            <span className="cps-state-ico">🔒</span>
            <p>Ningún cliente tiene habilitado <strong>{svcLabel || 'este servicio'}</strong>.</p>
            <p className="cps-state-hint">Actívalo en <strong>Credenciales SRI</strong> marcando la casilla correspondiente.</p>
          </div>
        ) : (
          <>
            {/* Barra de búsqueda */}
            <div className="cps-search-wrap">
              <span className="cps-search-ico">🔍</span>
              <input
                className="cps-search-input"
                placeholder="Buscar por nombre o RUC…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              {search && (
                <button className="cps-search-clear" onClick={() => setSearch('')} title="Limpiar">✕</button>
              )}
            </div>

            {/* Contador */}
            <div className="cps-count">
              {search
                ? `${visible.length} de ${idents_svc.size} contribuyente(s)`
                : `${idents_svc.size} contribuyente(s) habilitado(s)`}
            </div>

            {/* Lista */}
            {visible.length === 0 ? (
              <div className="cps-state cps-state--search">
                Sin resultados para «{search}»
              </div>
            ) : (
              <div className="cps-list">
                {visible.map((c) => (
                  <button
                    key={c.id}
                    className="cps-item"
                    onClick={() => selectClient(c.id)}
                  >
                    <span
                      className="cps-avatar"
                      style={{ background: avatarColor(c.nombre) }}
                    >
                      {initials(c.nombre)}
                    </span>
                    <span className="cps-item-body">
                      <span className="cps-item-name">{c.nombre}</span>
                      <span className="cps-item-meta">
                        <span>{c.tipo_identificacion || 'RUC'}: {c.identificacion}</span>
                        <span className="cps-period">{periodoLargo(c)}</span>
                      </span>
                    </span>
                    <span className="cps-item-arrow">›</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
