import { Fragment, useCallback, useEffect, useState } from 'react'
import { reportesAPI } from '../services/api'
import { fmtMoney } from '../utils/format'
import { nombreMes } from '../utils/periodo'
import './InformeGeneral.css'

// Informe consolidado del período: junta en un cuadro lo que hoy hay que ir a
// buscar a tres módulos distintos — qué se hizo (bitácora), qué se declaró, y
// qué se cobra / falta facturar. El alcance sale del rol: cada usuario ve los
// contribuyentes que puede ver, y los valores solo los ve administrador o socio.

const HOY = new Date()

function fechaCorta(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ')
  return d.toLocaleString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric',
                                     hour: '2-digit', minute: '2-digit' })
}

export default function InformeGeneral() {
  const [mes, setMes] = useState(HOY.getMonth() + 1)
  const [anio, setAnio] = useState(HOY.getFullYear())
  const [data, setData] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState(null)
  const [abierta, setAbierta] = useState(null) // identificación con el detalle desplegado

  const cargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const r = await reportesAPI.general(mes, anio)
      setData(r.data)
    } catch (e) {
      setError(e.response?.data?.detail || 'No se pudo cargar el informe.')
      setData(null)
    } finally {
      setCargando(false)
    }
  }, [mes, anio])

  useEffect(() => { cargar() }, [cargar])

  const t = data?.totales || {}
  const verValores = !!data?.ve_valores
  const anios = Array.from({ length: 6 }, (_, i) => HOY.getFullYear() - i)

  return (
    <div className="ig-page">
      <header className="ig-header">
        <div>
          <h1>📊 Informe general</h1>
          <p className="ig-sub">
            Todo lo realizado en la plataforma durante el período, con lo declarado y el
            estado de cobro. Muestra únicamente los contribuyentes a los que tenés acceso.
          </p>
        </div>
        <div className="ig-filtros">
          <label>
            Mes
            <select value={mes} onChange={(e) => setMes(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{nombreMes(m)}</option>
              ))}
            </select>
          </label>
          <label>
            Año
            <select value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <button className="ig-btn" onClick={cargar} disabled={cargando}>
            {cargando ? 'Cargando…' : '↻ Actualizar'}
          </button>
        </div>
      </header>

      {error && <div className="ig-msg err">{error}</div>}

      {data && (
        <>
          <div className="ig-kpis">
            <div className="ig-kpi"><span>Contribuyentes</span><strong>{t.contribuyentes ?? 0}</strong></div>
            <div className="ig-kpi"><span>Procesos realizados</span><strong>{t.procesos ?? 0}</strong></div>
            <div className="ig-kpi"><span>Declaraciones y anexos</span><strong>{t.declaraciones ?? 0}</strong></div>
            <div className="ig-kpi">
              <span>Devoluciones presentadas</span>
              <strong>{t.devoluciones ?? 0}</strong>
              {t.devolucion_monto > 0 && <em>{fmtMoney(t.devolucion_monto)} solicitados</em>}
            </div>
            {verValores && (
              <>
                <div className="ig-kpi dinero"><span>A cobrar</span><strong>{fmtMoney(t.a_cobrar || 0)}</strong></div>
                <div className="ig-kpi dinero"><span>Facturado</span><strong>{fmtMoney(t.facturado || 0)}</strong></div>
                <div className="ig-kpi dinero"><span>Cobrado</span><strong>{fmtMoney(t.cobrado || 0)}</strong></div>
                <div className={`ig-kpi ${t.falta_cobrar > 0 ? 'alerta' : 'dinero'}`}>
                  <span>Falta cobrar</span><strong>{fmtMoney(t.falta_cobrar || 0)}</strong>
                </div>
                <div className={`ig-kpi ${t.falta_facturar > 0 ? 'alerta' : 'dinero'}`}>
                  <span>Falta facturar</span><strong>{fmtMoney(t.falta_facturar || 0)}</strong>
                </div>
              </>
            )}
          </div>

          {!verValores && (
            <p className="ig-nota">
              Tu rol ({data.rol}) ve el trabajo realizado, no los valores de honorarios.
            </p>
          )}

          {data.filas.length === 0 ? (
            <div className="ig-vacio">
              <h2>Sin movimientos en {data.periodo.etiqueta}</h2>
              <p>No se registró trabajo para tus contribuyentes en ese período.</p>
            </div>
          ) : (
            <div className="ig-tabla-wrap">
              <table className="ig-tabla">
                <thead>
                  <tr>
                    <th>Contribuyente</th>
                    <th className="num">Procesos</th>
                    <th>Declarado</th>
                    <th>Devolución IVA</th>
                    {verValores && <th className="num">A cobrar</th>}
                    {verValores && <th>Facturado</th>}
                    {verValores && <th className="num">Falta facturar</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.filas.map((f) => (
                    <Fragment key={f.identificacion}>
                      <tr className="ig-fila"
                          onClick={() => setAbierta(abierta === f.identificacion ? null : f.identificacion)}>
                        <td>
                          <strong>{f.contribuyente || '—'}</strong>
                          <span className="ig-ruc">{f.identificacion}</span>
                        </td>
                        <td className="num">{f.procesos.length}</td>
                        <td>
                          {f.declarado.length === 0 ? '—' : (
                            <span className="ig-chips">
                              {f.declarado.map((d, i) => (
                                <em key={i} className="ig-chip">{d.tipo}</em>
                              ))}
                            </span>
                          )}
                        </td>
                        <td>
                          {f.devoluciones.length === 0 ? '—' : f.devoluciones.map((d, i) => (
                            <span key={i} className={`ig-dev ${d.estado}`}>
                              {d.comprobantes != null ? `${d.comprobantes} comprob. · ` : ''}
                              {fmtMoney(d.monto_procesado ?? d.monto_solicitado)}
                              <em> ({d.estado})</em>
                            </span>
                          ))}
                        </td>
                        {verValores && <td className="num">{fmtMoney(f.a_cobrar)}</td>}
                        {verValores && (
                          <td>
                            {f.facturado
                              ? <span className={f.facturado.pagada ? 'ig-fact ok' : 'ig-fact pend'}>
                                  {f.facturado.numero} · {fmtMoney(f.facturado.total)}
                                  <em>
                                    {f.facturado.pagada ? ' · cobrada'
                                      : ` · por cobrar ${fmtMoney(f.facturado.por_cobrar ?? f.facturado.total)}`}
                                    {!f.facturado.autorizada && ' · sin autorizar'}
                                  </em>
                                </span>
                              : <span className="ig-fact no">sin factura</span>}
                          </td>
                        )}
                        {verValores && (
                          <td className={`num ${f.falta_facturar > 0 ? 'ig-alerta' : ''}`}>
                            {f.falta_facturar > 0 ? fmtMoney(f.falta_facturar) : '—'}
                          </td>
                        )}
                      </tr>
                      {abierta === f.identificacion && (
                        <tr className="ig-detalle">
                          <td colSpan={verValores ? 7 : 4}>
                            {f.procesos.length === 0 ? (
                              <p>Sin procesos registrados en el período.</p>
                            ) : (
                              <table className="ig-subtabla">
                                <thead>
                                  <tr><th>Fecha</th><th>Módulo</th><th>Proceso</th>
                                    <th className="num">Cantidad</th><th>Quién</th></tr>
                                </thead>
                                <tbody>
                                  {[...f.procesos]
                                    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
                                    .map((p, i) => (
                                      <tr key={i}>
                                        <td>{fechaCorta(p.fecha)}</td>
                                        <td>{p.modulo}</td>
                                        <td>{p.proceso}</td>
                                        <td className="num">{p.cantidad ?? '—'}</td>
                                        <td>{p.por || '—'}</td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.sin_contribuyente?.length > 0 && (
            <section className="ig-plataforma">
              <h2>🛠️ Movimientos de plataforma</h2>
              <p className="ig-sub">Acciones sin contribuyente asociado (usuarios, permisos, configuración).</p>
              <table className="ig-subtabla">
                <thead>
                  <tr><th>Fecha</th><th>Módulo</th><th>Proceso</th><th>Quién</th></tr>
                </thead>
                <tbody>
                  {data.sin_contribuyente
                    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
                    .map((p, i) => (
                      <tr key={i}>
                        <td>{fechaCorta(p.fecha)}</td>
                        <td>{p.modulo}</td>
                        <td>{p.proceso}</td>
                        <td>{p.por || '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  )
}
