import { useState, useMemo } from 'react'
import { clientsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import './SavedData.css'

const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`

export default function SavedData() {
  const { clients } = useClients()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null) // { identificacion, nombre }
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Contribuyentes únicos (un cliente puede tener varios períodos)
  const contribuyentes = useMemo(() => {
    const map = {}
    for (const c of clients) {
      const k = c.identificacion
      const e = map[k] || (map[k] = {
        identificacion: c.identificacion,
        nombre: c.nombre,
        tipo_identificacion: c.tipo_identificacion,
        periodos: 0,
        num_facturas: 0,
      })
      e.periodos += 1
      e.num_facturas += c.num_facturas || 0
    }
    return Object.values(map).sort((a, b) => a.nombre.localeCompare(b.nombre))
  }, [clients])

  const filtered = useMemo(() => {
    if (!search.trim()) return contribuyentes
    const q = search.toLowerCase()
    return contribuyentes.filter((c) =>
      [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [contribuyentes, search])

  const openContribuyente = async (c) => {
    setSelected(c)
    setSummary(null)
    setError('')
    setLoading(true)
    try {
      const res = await clientsAPI.summary(c.identificacion)
      setSummary(res.data)
    } catch (err) {
      setError(err.response?.data?.detail || err.message)
    } finally {
      setLoading(false)
    }
  }

  // Agrupar filas del resumen por año → mes
  const grupos = useMemo(() => {
    if (!summary?.filas) return []
    const byAnio = {}
    for (const f of summary.filas) {
      const a = byAnio[f.anio] || (byAnio[f.anio] = { anio: f.anio, meses: {}, total: 0 })
      const m = a.meses[f.mes] || (a.meses[f.mes] = { mes: f.mes, filas: [], total: 0 })
      m.filas.push(f)
      m.total += f.total
      a.total += f.total
    }
    return Object.values(byAnio)
      .sort((x, y) => y.anio - x.anio)
      .map((a) => ({
        ...a,
        meses: Object.values(a.meses).sort((x, y) => y.mes - x.mes),
      }))
  }, [summary])

  return (
    <div className="sd-page">
      <header className="sd-header">
        <h1>📊 Datos guardados</h1>
        <p className="sd-sub">Consulta consolidada de todo lo trabajado por contribuyente, desglosado por año, mes y producto.</p>
      </header>

      <div className="sd-layout">
        {/* Columna izquierda: buscador + lista */}
        <aside className="sd-list">
          <input
            className="sd-search"
            placeholder="🔍 Buscar contribuyente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="sd-list-scroll">
            {filtered.length === 0 && <div className="sd-empty">Sin contribuyentes.</div>}
            {filtered.map((c) => (
              <button
                key={c.identificacion}
                className={`sd-list-item ${selected?.identificacion === c.identificacion ? 'active' : ''}`}
                onClick={() => openContribuyente(c)}
              >
                <span className="sd-li-name">{c.nombre}</span>
                <span className="sd-li-meta">
                  {c.identificacion} · {c.periodos} período(s) · {c.num_facturas} fact.
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* Columna derecha: desglose */}
        <section className="sd-detail">
          {!selected ? (
            <div className="sd-placeholder">Selecciona un contribuyente para ver su desglose.</div>
          ) : loading ? (
            <div className="sd-placeholder">Cargando desglose…</div>
          ) : error ? (
            <div className="sd-error">⚠ {error}</div>
          ) : !grupos.length ? (
            <div className="sd-placeholder">Sin datos registrados para {selected.nombre}.</div>
          ) : (
            <>
              <div className="sd-detail-head">
                <h2>{summary.nombre}</h2>
                <span className="sd-ident">{selected.identificacion}</span>
              </div>
              {grupos.map((anio) => (
                <div key={anio.anio} className="sd-anio">
                  <div className="sd-anio-head">
                    <span className="sd-anio-label">{anio.anio}</span>
                    <span className="sd-anio-total">{money(anio.total)}</span>
                  </div>
                  {anio.meses.map((mes) => (
                    <div key={mes.mes} className="sd-mes">
                      <div className="sd-mes-head">
                        <span>{nombreMes(mes.mes)}</span>
                        <span className="sd-mes-total">{money(mes.total)}</span>
                      </div>
                      <table className="sd-table">
                        <thead>
                          <tr>
                            <th>Producto / Clasificación</th>
                            <th className="r">Facturas</th>
                            <th className="r">Base 15%</th>
                            <th className="r">IVA 15%</th>
                            <th className="r">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mes.filas.map((f) => (
                            <tr key={f.clasificacion} className={f.clasificacion === 'SIN CLASIFICAR' ? 'sd-unclass' : ''}>
                              <td>{f.clasificacion}</td>
                              <td className="r">{f.num_facturas}</td>
                              <td className="r">{money(f.base_15)}</td>
                              <td className="r">{money(f.iva_15)}</td>
                              <td className="r">{money(f.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
