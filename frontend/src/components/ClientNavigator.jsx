import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { clientsAPI, credentialsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import { filtrarClientesPorTexto } from '../utils/clientSearch'
import './ClientNavigator.css'

const TIPOS = [
  { key: 'gastos',      label: 'Gastos',    icon: '💸', route: '/' },
  { key: 'retenciones', label: 'Ret.',       icon: '🧾', route: '/retenciones' },
  { key: 'ice',         label: 'ICE',        icon: '🥃', route: '/ice' },
  { key: 'calculo_ice', label: 'Cálc. ICE', icon: '🧮', route: '/calculo-ice' },
]

export default function ClientNavigator({ idents_svc = null }) {
  const navigate = useNavigate()
  const { selectClient, focusIdent, setFocusIdent } = useClients()
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState({})

  // Credenciales SRI — solo admin; null = cargando, {} = sin acceso/sin creds.
  // Solo se guarda id/username (la password se revela bajo demanda por fila).
  const [credByRuc, setCredByRuc] = useState(null) // { [ruc]: { id, username } }
  const [revealed, setRevealed] = useState({}) // { [ruc]: password }
  const [revealing, setRevealing] = useState(null) // ruc en curso

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await clientsAPI.contribuyentes()
      setData(res.data || [])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Una sola llamada a /list (sin passwords) → construye ruc→{id,username}
  useEffect(() => {
    if (!data.length) return
    credentialsAPI.list()
      .then((r) => {
        const items = r.data?.data || r.data || []
        if (!items.length) { setCredByRuc({}); return }
        const byClientId = {}
        for (const item of items) {
          if (item.client_id) byClientId[item.client_id] = item
        }
        const byRuc = {}
        for (const c of data) {
          for (const p of (c.periodos || [])) {
            const cred = byClientId[p.client_id]
            if (cred) { byRuc[c.identificacion] = cred; break }
          }
        }
        setCredByRuc(byRuc)
      })
      .catch(() => setCredByRuc({}))
  }, [data])

  const revelarClave = async (ruc, credId) => {
    if (revealed[ruc] || revealing) return
    setRevealing(ruc)
    try {
      const r = await credentialsAPI.reveal(credId)
      const password = r.data?.password
      if (password) setRevealed((prev) => ({ ...prev, [ruc]: password }))
    } finally {
      setRevealing(null)
    }
  }

  useEffect(() => {
    if (focusIdent) {
      setOpen((o) => ({ ...o, [focusIdent]: true }))
      setSearch('')
      setFocusIdent(null)
    }
  }, [focusIdent, setFocusIdent])

  const filtrados = useMemo(() => {
    let base = data
    if (idents_svc) base = base.filter((c) => idents_svc.has(c.identificacion))
    return filtrarClientesPorTexto(base, search)
  }, [data, search, idents_svc])

  const abrir = (tipo, clientId) => {
    selectClient(clientId)
    navigate(tipo.route)
  }

  // Selecciona el período más reciente del contribuyente y navega a la ruta dada
  const abrirReciente = (periodos, route = '/') => {
    if (!periodos?.length) return
    const ordenados = [...periodos].sort((a, b) =>
      b.anio !== a.anio ? b.anio - a.anio : b.mes - a.mes
    )
    selectClient(ordenados[0].client_id)
    navigate(route)
  }

  const aniosDe = (periodos) => {
    const map = {}
    periodos.forEach((p) => { (map[p.anio] = map[p.anio] || []).push(p) })
    return Object.keys(map).sort((a, b) => b - a).map((a) => ({ anio: a, meses: map[a] }))
  }

  if (loading) return <div className="cn-empty">Cargando base de datos…</div>

  return (
    <div className="cn-wrap">
      <input
        className="cn-search"
        placeholder="🔍 Buscar por nombre o RUC…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {filtrados.length === 0 ? (
        <div className="cn-empty">Sin contribuyentes que coincidan.</div>
      ) : filtrados.map((c) => {
        const isOpen = !!open[c.identificacion]
        const cred = credByRuc?.[c.identificacion] // { username, password } | undefined
        const { gastos = 0, retenciones = 0, ice = 0, calculo_ice = 0 } = c.totales || {}

        return (
          <div key={c.identificacion} className="cn-cont">
            <div className={`cn-cont-head ${isOpen ? 'open' : ''}`}>
              {/* Caret */}
              <button
                className="cn-toggle"
                onClick={() => setOpen((o) => ({ ...o, [c.identificacion]: !o[c.identificacion] }))}
                title={isOpen ? 'Contraer' : 'Expandir períodos'}
              >
                <span className={`cn-caret ${isOpen ? 'open' : ''}`}>▸</span>
              </button>

              {/* Nombre + RUC */}
              <div className="cn-info" onClick={() => setOpen((o) => ({ ...o, [c.identificacion]: !o[c.identificacion] }))}>
                <span className="cn-cont-name">{c.nombre}</span>
                <span className="cn-cont-ruc">{c.identificacion}</span>
              </div>

              {/* Credencial SRI (solo admin) — password oculta hasta pedirla */}
              {credByRuc !== null && (
                <div className="cn-clave">
                  {cred ? (
                    <>
                      {cred.username && <span className="cn-clave-user">🔐 {cred.username}</span>}
                      {!cred.username && <span className="cn-clave-user">🔐</span>}
                      {revealed[c.identificacion] ? (
                        <code className="cn-clave-val">{revealed[c.identificacion]}</code>
                      ) : (
                        <button
                          type="button"
                          className="cn-clave-btn"
                          onClick={(e) => { e.stopPropagation(); revelarClave(c.identificacion, cred.id) }}
                          disabled={revealing === c.identificacion}
                          title="Revelar clave SRI"
                        >
                          {revealing === c.identificacion ? '…' : '👁'}
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="cn-clave-none">sin clave</span>
                  )}
                </div>
              )}

              {/* Totales */}
              <div className="cn-totales">
                {gastos > 0 && <span className="cn-tot-chip gastos" title="Facturas de gastos">💸 {gastos}</span>}
                {retenciones > 0 && <span className="cn-tot-chip ret" title="Retenciones">🧾 {retenciones}</span>}
                {ice > 0 && <span className="cn-tot-chip ice" title="Ventas ICE">🥃 {ice}</span>}
                {calculo_ice > 0 && <span className="cn-tot-chip calc" title="Cálculo previo ICE">🧮 {calculo_ice}</span>}
                {gastos === 0 && retenciones === 0 && ice === 0 && calculo_ice === 0 && (
                  <span className="cn-tot-vacio">sin datos</span>
                )}
              </div>

              {/* Botón de acción directa */}
              <button
                className="cn-trabajar-btn"
                onClick={(e) => { e.stopPropagation(); abrirReciente(c.periodos) }}
                title="Seleccionar este cliente y abrir Gastos"
              >
                Trabajar →
              </button>
            </div>

            {/* Detalle por año/mes cuando está expandido */}
            {isOpen && (
              <div className="cn-anios">
                {aniosDe(c.periodos).map(({ anio, meses }) => (
                  <div key={anio} className="cn-anio">
                    <div className="cn-anio-label">{anio}</div>
                    {meses.map((p) => {
                      const tipos = TIPOS.filter((t) => (p.datos[t.key] || 0) > 0)
                      return (
                        <div key={p.client_id} className="cn-mes">
                          <span className="cn-mes-label">{nombreMes(p.mes)}</span>
                          <div className="cn-tipos">
                            {tipos.length === 0 ? (
                              <span className="cn-sin">sin datos</span>
                            ) : tipos.map((t) => (
                              <button
                                key={t.key}
                                className="cn-tipo"
                                onClick={() => abrir(t, p.client_id)}
                                title={`Abrir ${t.label}`}
                              >
                                {t.icon} {t.label} <span className="cn-badge">{p.datos[t.key]}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
