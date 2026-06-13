import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { clientsAPI } from '../services/api'
import { getRevealedCredentials } from '../services/credentialsCache'
import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import './ClientNavigator.css'

const TIPOS = [
  { key: 'gastos',      label: 'Gastos',    icon: '💸', route: '/' },
  { key: 'retenciones', label: 'Ret.',       icon: '🧾', route: '/retenciones' },
  { key: 'ice',         label: 'ICE',        icon: '🥃', route: '/ice' },
  { key: 'calculo_ice', label: 'Cálc. ICE', icon: '🧮', route: '/calculo-ice' },
]

export default function ClientNavigator() {
  const navigate = useNavigate()
  const { selectClient, focusIdent, setFocusIdent } = useClients()
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState({})

  // Credenciales SRI — solo admin; null = cargando, {} = sin acceso/sin creds
  const [credByRuc, setCredByRuc] = useState(null) // { [ruc]: { username, password } }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await clientsAPI.contribuyentes()
      setData(res.data || [])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Una sola llamada para todas las credenciales; se comparte con ClaveHeader via cache
  useEffect(() => {
    if (!data.length) return
    getRevealedCredentials()
      .then((credMap) => {
        if (!credMap.size) { setCredByRuc({}); return }
        const byRuc = {}
        for (const c of data) {
          for (const p of (c.periodos || [])) {
            const cred = credMap.get(p.client_id)
            if (cred && cred.password) {
              byRuc[c.identificacion] = cred
              break
            }
          }
        }
        setCredByRuc(byRuc)
      })
      .catch(() => setCredByRuc({}))
  }, [data])

  useEffect(() => {
    if (focusIdent) {
      setOpen((o) => ({ ...o, [focusIdent]: true }))
      setSearch('')
      setFocusIdent(null)
    }
  }, [focusIdent, setFocusIdent])

  const filtrados = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter((c) =>
      [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [data, search])

  const abrir = (tipo, clientId) => {
    selectClient(clientId)
    navigate(tipo.route)
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

              {/* Credencial SRI (solo admin) */}
              {credByRuc !== null && (
                <div className="cn-clave">
                  {cred ? (
                    <>
                      {cred.username && <span className="cn-clave-user">🔐 {cred.username}</span>}
                      {!cred.username && <span className="cn-clave-user">🔐</span>}
                      <code className="cn-clave-val">{cred.password}</code>
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
                {calculo_ice > 0 && <span className="cn-tot-chip calc" title="Cálculo ICE">🧮 {calculo_ice}</span>}
                {gastos === 0 && retenciones === 0 && ice === 0 && calculo_ice === 0 && (
                  <span className="cn-tot-vacio">sin datos</span>
                )}
              </div>
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
