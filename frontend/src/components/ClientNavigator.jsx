import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { clientsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import './ClientNavigator.css'

const TIPOS = [
  { key: 'gastos', label: 'Gastos', icon: '💸', route: '/' },
  { key: 'retenciones', label: 'Retenciones', icon: '🧾', route: '/retenciones' },
  { key: 'ice', label: 'ICE-XML', icon: '🥃', route: '/ice' },
  { key: 'calculo_ice', label: 'Cálculo ICE', icon: '🧮', route: '/calculo-ice' },
]

export default function ClientNavigator() {
  const navigate = useNavigate()
  const { selectClient, focusIdent, setFocusIdent } = useClients()
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await clientsAPI.contribuyentes()
      setData(res.data || [])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  // Enfocar contribuyente desde el sidebar
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
    return data.filter((c) => [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q)))
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
      <input className="cn-search" placeholder="🔍 Buscar contribuyente (nombre o RUC)…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {filtrados.length === 0 ? (
        <div className="cn-empty">Sin contribuyentes.</div>
      ) : filtrados.map((c) => {
        const isOpen = !!open[c.identificacion]
        return (
          <div key={c.identificacion} className="cn-cont">
            <button className="cn-cont-head" onClick={() => setOpen((o) => ({ ...o, [c.identificacion]: !o[c.identificacion] }))}>
              <span className={`cn-caret ${isOpen ? 'open' : ''}`}>▸</span>
              <span className="cn-cont-name">{c.nombre}</span>
              <span className="cn-cont-ruc">{c.identificacion}</span>
            </button>
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
                              <button key={t.key} className="cn-tipo" onClick={() => abrir(t, p.client_id)} title={`Abrir ${t.label}`}>
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
