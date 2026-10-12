import { useState, useMemo } from 'react'
import { useClients } from '../context/ClientContext'
import { periodoLargo, periodoCorto } from '../utils/periodo'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import useDeclPresentadas from '../hooks/useDeclPresentadas'
import BadgeVencimiento from './BadgeVencimiento'
import OrdenLista from './OrdenLista'
import FiltroDeclarados from './FiltroDeclarados'
import useOrdenLista from '../hooks/useOrdenLista'
import { ordenarPorVencimiento } from '../utils/declaracionSRI'
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

export default function ClientPickerScreen({ icon, title, subtitle, idents_svc, onNewClient, svcLabel, hint }) {
  const { clients, selectClient } = useClients()
  const { estaPresentada, nuncaDeclaro } = useDeclPresentadas()
  const [search, setSearch] = useState('')
  const [orden, setOrden] = useOrdenLista('cpsOrden')
  // Acá se trabaja también con quien solo tiene cálculos: por defecto se ven todos.
  const [declarados, setDeclarados] = useOrdenLista('cpsDeclarados', 'todas')
  const [expanded, setExpanded] = useState({}) // identificacion -> mostrar sus períodos

  // Períodos de un contribuyente (más reciente primero) para desplegarlos y poder
  // entrar directo a un período concreto (no solo al más reciente).
  const periodosDe = (identificacion) => clients
    .filter((c) => c.identificacion === identificacion)
    .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))

  // Un contribuyente puede tener varias filas (una por período). Aquí mostramos
  // UNA tarjeta por identificación: el representante es el período más reciente y
  // es el que se selecciona al hacer clic. 'periodos' cuenta cuántos tiene.
  const { items: visible, cuentas: cuentasDeclarados } = useMemo(() => {
    const base = idents_svc ? clients.filter((c) => idents_svc.has(c.identificacion)) : []
    const filtered = filtrarClientesPorTexto(base, search)
    const rank = (c) => (c.periodo_anio || 0) * 100 + (c.periodo_mes || 0)
    const grupos = new Map()
    for (const c of filtered) {
      const g = grupos.get(c.identificacion)
      if (!g) grupos.set(c.identificacion, { rep: c, periodos: 1 })
      else {
        g.periodos += 1
        if (rank(c) > rank(g.rep)) g.rep = c
      }
    }
    const lista = [...grupos.values()]
      .sort((a, b) => (a.rep.nombre || '').localeCompare(b.rep.nombre || ''))
    const cuentas = {
      declaran: lista.filter((g) => !nuncaDeclaro(g.rep.identificacion)).length,
      nunca: lista.filter((g) => nuncaDeclaro(g.rep.identificacion)).length,
      todas: lista.length,
    }
    const filtrada = declarados === 'todas' ? lista
      : lista.filter((g) => (declarados === 'nunca') === nuncaDeclaro(g.rep.identificacion))
    const items = orden === 'vencimiento'
      ? ordenarPorVencimiento(filtrada, {
        cliente: (g) => g.rep,
        presentada: (g) => estaPresentada(g.rep.identificacion),
        nunca: (g) => nuncaDeclaro(g.rep.identificacion),
      })
      : filtrada
    return { items, cuentas }
  }, [clients, idents_svc, search, orden, declarados, estaPresentada, nuncaDeclaro])

  return (
    <div className="cps-page">
      {/* Hero */}
      <div className="cps-hero">
        <span className="cps-hero-icon">{icon}</span>
        <h1 className="cps-hero-title">{title}</h1>
        {subtitle && <p className="cps-hero-sub">{subtitle}</p>}
        {onNewClient && (
          <button className="cps-hero-btn" onClick={onNewClient}>＋ Nuevo cliente</button>
        )}
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
            <p className="cps-state-hint">{hint || <>Actívalo en <strong>Credenciales SRI</strong> marcando la casilla correspondiente.</>}</p>
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

            {/* Contador + orden */}
            <div className="cps-count">
              <span>
                {search
                  ? `${visible.length} de ${idents_svc.size} contribuyente(s)`
                  : `${idents_svc.size} contribuyente(s) habilitado(s)`}
              </span>
              <span className="cps-count-ctrl">
                <FiltroDeclarados valor={declarados} onChange={setDeclarados} cuentas={cuentasDeclarados} />
                <OrdenLista orden={orden} onChange={setOrden} />
              </span>
            </div>

            {/* Lista */}
            {visible.length === 0 ? (
              <div className="cps-state cps-state--search">
                Sin resultados para «{search}»
              </div>
            ) : (
              <div className="cps-list">
                {visible.map(({ rep: c, periodos }) => {
                  const isExp = !!expanded[c.identificacion]
                  return (
                    <div key={c.identificacion} className="cps-item-wrap">
                      <div className="cps-item-row">
                        <button className="cps-item" onClick={() => selectClient(c.id)}>
                          <span className="cps-avatar" style={{ background: avatarColor(c.nombre) }}>
                            {initials(c.nombre)}
                          </span>
                          <span className="cps-item-body">
                            <span className="cps-item-name">{c.nombre}</span>
                            <span className="cps-item-meta">
                              <span>{c.tipo_identificacion || 'RUC'}: {c.identificacion}</span>
                              <span className="cps-period">{periodoLargo(c)}</span>
                              {periodos > 1 && <span className="cps-period">· {periodos} períodos</span>}
                              <BadgeVencimiento ruc={c.identificacion} client={c} presentada={estaPresentada(c.identificacion)} nunca={nuncaDeclaro(c.identificacion)} />
                            </span>
                          </span>
                          <span className="cps-item-arrow">›</span>
                        </button>
                        {periodos > 1 && (
                          <button
                            className="cps-item-exp"
                            title={isExp ? 'Ocultar períodos' : 'Ver períodos'}
                            onClick={() => setExpanded((o) => ({ ...o, [c.identificacion]: !o[c.identificacion] }))}
                          >
                            <span className={`cps-exp-caret ${isExp ? 'open' : ''}`}>▾</span>
                          </button>
                        )}
                      </div>
                      {isExp && periodos > 1 && (
                        <div className="cps-periods">
                          {periodosDe(c.identificacion).map((p) => (
                            <button key={p.id} className="cps-period-chip" onClick={() => selectClient(p.id)}>
                              {periodoCorto(p)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
