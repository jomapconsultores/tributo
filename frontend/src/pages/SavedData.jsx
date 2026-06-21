import { useState, useMemo, useEffect, Fragment } from 'react'
import { clientsAPI, anexosAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import { infoDeclaracion } from '../utils/declaracionSRI'
import WorkflowGuide from '../components/WorkflowGuide'
import './SavedData.css'

import { fmtMoney as money } from '../utils/format'
const DIAS_DECL = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28]

const SD_STEPS = [
  { icon: '📊', label: 'Datos guardados', current: true },
  { icon: '📥', label: 'Gastos (subir TXT/XML)', path: '/' },
  { icon: '🗂', label: 'Clasificar comprobantes', path: '/clasificador' },
  { icon: '📄', label: 'Declaraciones IVA / ICE', path: '/declaracion-iva' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]
const fechaCorta = (f) => `${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()}`

export default function SavedData() {
  const { clients, identsForSvc } = useClients()
  const idents_svc = identsForSvc('declaracion_iva,declaracion_ice,declaracion_renta,devolucion_iva')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null) // { identificacion, nombre }
  const [summary, setSummary] = useState(null)
  const [anexos, setAnexos] = useState([])       // anexos PVP+ICE del contribuyente
  const [anexoOpen, setAnexoOpen] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Filtro/orden por fecha máxima de declaración (9no dígito del RUC)
  const [diaFilter, setDiaFilter] = useState(() => localStorage.getItem('sdDiaFilter') || '')
  const [ordenFecha, setOrdenFecha] = useState(() => localStorage.getItem('sdOrdenFecha') === '1')
  useEffect(() => { try { localStorage.setItem('sdDiaFilter', diaFilter) } catch { /* ignore */ } }, [diaFilter])
  useEffect(() => { try { localStorage.setItem('sdOrdenFecha', ordenFecha ? '1' : '0') } catch { /* ignore */ } }, [ordenFecha])

  // Mapa client_id → período (para mostrar el período de cada anexo)
  const clientById = useMemo(() => {
    const m = {}
    for (const c of clients) m[c.id] = c
    return m
  }, [clients])

  // Contribuyentes únicos (un cliente puede tener varios períodos), filtrados por servicio activo
  const contribuyentes = useMemo(() => {
    const map = {}
    for (const c of clients) {
      if (idents_svc && !idents_svc.has(c.identificacion)) continue
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
    let list = contribuyentes
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((c) => [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q)))
    if (diaFilter) list = list.filter((c) => infoDeclaracion(c.identificacion).dia === Number(diaFilter))
    if (ordenFecha) {
      list = [...list].sort((a, b) => {
        const fa = infoDeclaracion(a.identificacion).proximaFecha
        const fb = infoDeclaracion(b.identificacion).proximaFecha
        if (!fa && !fb) return 0
        if (!fa) return 1
        if (!fb) return -1
        return fa - fb
      })
    }
    return list
  }, [contribuyentes, search, diaFilter, ordenFecha])

  const openContribuyente = async (c) => {
    setSelected(c)
    setSummary(null)
    setAnexos([])
    setAnexoOpen(null)
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
    // Anexos PVP+ICE guardados de este contribuyente (todos sus períodos)
    try {
      const idsRuc = new Set(clients.filter((x) => x.identificacion === c.identificacion).map((x) => x.id))
      const r = await anexosAPI.list()
      setAnexos((r.data?.data || []).filter((a) => idsRuc.has(a.client_id)))
    } catch { setAnexos([]) }
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
      <WorkflowGuide steps={SD_STEPS} />
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
          <div className="sd-decl-filter">
            <select value={diaFilter} onChange={(e) => setDiaFilter(e.target.value)} title="Filtrar por día máximo de declaración (9no dígito del RUC)">
              <option value="">📅 Declaración: todas</option>
              {DIAS_DECL.map((d) => <option key={d} value={d}>Declaran el día {d}</option>)}
            </select>
            <label title="Ordenar por la próxima fecha de declaración (la más cercana primero)">
              <input type="checkbox" checked={ordenFecha} onChange={(e) => setOrdenFecha(e.target.checked)} /> ↑ fecha
            </label>
          </div>
          <div className="sd-list-scroll">
            {filtered.length === 0 && <div className="sd-empty">Sin contribuyentes.</div>}
            {filtered.map((c) => {
              const d = infoDeclaracion(c.identificacion)
              return (
                <button
                  key={c.identificacion}
                  className={`sd-list-item ${selected?.identificacion === c.identificacion ? 'active' : ''}`}
                  onClick={() => openContribuyente(c)}
                >
                  <span className="sd-li-name">{c.nombre}</span>
                  <span className="sd-li-meta">
                    {c.identificacion} · {c.periodos} período(s) · {c.num_facturas} fact.
                  </span>
                  {d.valido && (
                    <span className="sd-li-decl" title={`Fecha máxima de declaración · ${d.proximaFechaTexto}`}>
                      📅 día {d.dia} · {fechaCorta(d.proximaFecha)}
                    </span>
                  )}
                </button>
              )
            })}
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
          ) : !grupos.length && !anexos.length ? (
            <div className="sd-placeholder">Sin datos registrados para {selected.nombre}.</div>
          ) : (
            <>
              <div className="sd-detail-head">
                <h2>{summary?.nombre || selected.nombre}</h2>
                <span className="sd-ident">{selected.identificacion}</span>
              </div>

              {anexos.length > 0 && (
                <div className="sd-anio">
                  <div className="sd-anio-head">
                    <span className="sd-anio-label">📄 Anexos PVP+ICE guardados</span>
                    <span className="sd-anio-total">{anexos.length}</span>
                  </div>
                  <table className="sd-table">
                    <thead>
                      <tr><th>Tipo</th><th>Período</th><th className="r">Filas</th><th>Guardado</th><th></th></tr>
                    </thead>
                    <tbody>
                      {anexos.map((a) => {
                        const cli = clientById[a.client_id]
                        const d = a.datos || {}
                        const per = cli ? `${nombreMes(cli.periodo_mes)} ${cli.periodo_anio}`
                          : `${d.header?.Anio || ''}/${d.header?.Mes || ''}`
                        return (
                          <Fragment key={a.id}>
                            <tr>
                              <td><strong>{a.tipo}</strong></td>
                              <td>{per}</td>
                              <td className="r">{(d.rows || []).length}</td>
                              <td>{String(a.created_at || '').slice(0, 10)}</td>
                              <td><button className="sd-li-item" style={{ padding: '2px 8px', cursor: 'pointer' }}
                                onClick={() => setAnexoOpen(anexoOpen === a.id ? null : a.id)}>
                                {anexoOpen === a.id ? '▲ Ocultar' : '▼ Detalle'}</button></td>
                            </tr>
                            {anexoOpen === a.id && (
                              <tr><td colSpan={5}>
                                <div style={{ fontSize: 12, color: '#444', padding: '4px 0' }}>
                                  <div><strong>Informante:</strong> {d.header?.IdInformante || '—'} · {d.header?.razonSocial || '—'}</div>
                                  <div style={{ marginTop: 4, maxHeight: 180, overflow: 'auto' }}>
                                    {(d.rows || []).slice(0, 50).map((r, i) => (
                                      <div key={i} style={{ borderBottom: '1px solid #eee', padding: '2px 0' }}>
                                        {r.nombreProducto || r.codProdICE || r.codProdPVP || '—'}
                                        {' · '}{r.codProdICE || r.codProdPVP || ''}
                                        {r.ventaICE != null ? ` · venta ${r.ventaICE}` : ''}
                                        {r.precioPVP != null ? ` · PVP ${r.precioPVP}` : ''}
                                      </div>
                                    ))}
                                    {(d.rows || []).length > 50 && <div>…y {(d.rows || []).length - 50} más</div>}
                                  </div>
                                </div>
                              </td></tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

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
