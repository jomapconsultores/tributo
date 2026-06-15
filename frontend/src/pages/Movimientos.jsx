import { useState, useEffect, useMemo, useCallback } from 'react'
import { actividadAPI } from '../services/api'
import './Movimientos.css'

// Etiquetas e íconos por módulo/acción
const MOD = {
  gastos:        { label: 'Gastos',        ico: '💸', cls: 'mv-gastos' },
  ingresos_iva:  { label: 'Ingresos IVA',  ico: '📈', cls: 'mv-ingresos' },
  ingresos_ice:  { label: 'Ingresos ICE',  ico: '🥃', cls: 'mv-ingresos' },
  retenciones:   { label: 'Retenciones',   ico: '🧾', cls: 'mv-reten' },
  declaraciones: { label: 'Declaraciones', ico: '📋', cls: 'mv-decl' },
  anexos:        { label: 'Anexos',        ico: '📄', cls: 'mv-anexos' },
  clientes:      { label: 'Clientes',      ico: '👤', cls: 'mv-clientes' },
}
const ACCION = { upload: 'subió', create: 'creó', save: 'guardó', delete: 'eliminó' }

function fechaCorta(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('es-EC', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

// Agrupa por día (Hoy / Ayer / fecha)
function etiquetaDia(iso) {
  const d = new Date(iso); d.setHours(0, 0, 0, 0)
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const diff = Math.round((hoy - d) / 86400000)
  if (diff === 0) return 'Hoy'
  if (diff === 1) return 'Ayer'
  return d.toLocaleDateString('es-EC', { weekday: 'long', day: '2-digit', month: 'long' })
}

export default function Movimientos() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filtro, setFiltro] = useState('')
  const [modFiltro, setModFiltro] = useState('')

  const cargar = useCallback(() => {
    setLoading(true)
    actividadAPI.list({ limit: 300 })
      .then((r) => setItems(r.data?.data || []))
      .catch(() => setError('No se pudieron cargar los movimientos.'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    cargar()
    // Al entrar, marcar como vistos (reinicia el contador 🔔 del sidebar)
    actividadAPI.marcarVisto().catch(() => {})
    // Avisar al sidebar para que refresque su insignia
    window.dispatchEvent(new Event('actividad-vista'))
  }, [cargar])

  const filtrados = useMemo(() => {
    const q = filtro.trim().toLowerCase()
    return items.filter((m) => {
      if (modFiltro && m.module !== modFiltro) return false
      if (!q) return true
      return [m.actor_email, m.contribuyente, m.identificacion, m.entity]
        .some((f) => String(f || '').toLowerCase().includes(q))
    })
  }, [items, filtro, modFiltro])

  // Agrupar por día
  const grupos = useMemo(() => {
    const g = []
    let actual = null
    for (const m of filtrados) {
      const dia = etiquetaDia(m.occurred_at)
      if (!actual || actual.dia !== dia) {
        actual = { dia, filas: [] }
        g.push(actual)
      }
      actual.filas.push(m)
    }
    return g
  }, [filtrados])

  const modulosPresentes = useMemo(
    () => [...new Set(items.map((m) => m.module).filter(Boolean))],
    [items],
  )

  return (
    <div className="mv-page">
      <div className="mv-header">
        <div>
          <h1 className="mv-title">📜 Movimientos</h1>
          <p className="mv-subtitle">Actividad de los usuarios: qué se hizo, con qué contribuyente y en qué proceso.</p>
        </div>
        <button className="mv-refresh" onClick={cargar} disabled={loading}>
          {loading ? 'Actualizando…' : '↻ Actualizar'}
        </button>
      </div>

      <div className="mv-filtros">
        <input
          className="mv-search"
          placeholder="🔍 Buscar por usuario, contribuyente o proceso…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
        <div className="mv-chips">
          <button className={`mv-chip ${!modFiltro ? 'active' : ''}`} onClick={() => setModFiltro('')}>Todos</button>
          {modulosPresentes.map((m) => (
            <button
              key={m}
              className={`mv-chip ${modFiltro === m ? 'active' : ''}`}
              onClick={() => setModFiltro(modFiltro === m ? '' : m)}
            >
              {(MOD[m]?.ico || '•')} {MOD[m]?.label || m}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="mv-error">{error}</div>}
      {loading && items.length === 0 && <div className="mv-empty">Cargando movimientos…</div>}
      {!loading && filtrados.length === 0 && !error && (
        <div className="mv-empty">No hay movimientos {filtro || modFiltro ? 'que coincidan con el filtro' : 'registrados aún'}.</div>
      )}

      {grupos.map((g) => (
        <div key={g.dia} className="mv-grupo">
          <div className="mv-dia">{g.dia}</div>
          <div className="mv-lista">
            {g.filas.map((m) => {
              const mod = MOD[m.module] || { ico: '•', label: m.module || '', cls: 'mv-otro' }
              return (
                <div key={m.id} className={`mv-item ${mod.cls}`}>
                  <span className="mv-ico">{mod.ico}</span>
                  <div className="mv-cuerpo">
                    <div className="mv-linea1">
                      <strong className="mv-usuario">{m.actor_email || 'Usuario'}</strong>
                      <span className="mv-accion"> {ACCION[m.action] || m.action} </span>
                      <span className="mv-entity">{m.entity}</span>
                      {m.cantidad ? <span className="mv-cant">{m.cantidad}</span> : null}
                    </div>
                    {(m.contribuyente || m.identificacion) && (
                      <div className="mv-linea2">
                        <span className="mv-contrib">{m.contribuyente || '—'}</span>
                        {m.identificacion && <span className="mv-ruc"> · {m.identificacion}</span>}
                        {m.metadata?.periodo && <span className="mv-meta"> · período {m.metadata.periodo}</span>}
                        {m.metadata?.mes && <span className="mv-meta"> · {String(m.metadata.mes).padStart(2, '0')}/{m.metadata.anio}</span>}
                      </div>
                    )}
                  </div>
                  <span className="mv-fecha">{fechaCorta(m.occurred_at)}</span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
