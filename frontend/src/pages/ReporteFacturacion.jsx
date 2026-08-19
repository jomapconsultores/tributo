import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { odooAPI } from '../services/api'
import WorkflowGuide from '../components/WorkflowGuide'
import { MESES, clavePeriodo } from '../utils/periodo'
import './ReporteFacturacion.css'

const RF_STEPS = [
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
  { icon: '🧾', label: 'Facturar en Odoo', path: '/facturacion' },
  { icon: '📊', label: 'Reporte y comparativo', current: true },
  { icon: '🔍', label: 'Cruce mensual', path: '/facturacion/cruce' },
]

const fmt = (v) => `$${Number(v || 0).toFixed(2)}`

// Cómo se lee cada estado, en palabras y no en jerga
const DECL = {
  total: { txt: 'Declarado todo', cls: 'ok' },
  parcial: { txt: 'Parcial', cls: 'warn' },
  ninguna: { txt: 'Sin declarar', cls: 'bad' },
  sin_obligaciones: { txt: 'Sin obligaciones mensuales', cls: 'dim' },
}
const FACT = {
  facturado: { txt: 'Facturado', cls: 'ok' },
  difiere: { txt: 'Monto distinto', cls: 'warn' },
  pendiente: { txt: 'Falta facturar', cls: 'bad' },
  solo_odoo: { txt: 'Solo en Odoo', cls: 'warn' },
  sin_movimiento: { txt: '—', cls: 'dim' },
}

// `periodo` (mes/año) lo manda el módulo de Facturación: uno solo para las
// cuatro pestañas. Suelta —abriendo esta pantalla por su cuenta— elige su mes.
export default function ReporteFacturacion({ embebido = false, periodo = null, onFacturarMes = null }) {
  const navigate = useNavigate()
  const hoy = new Date()
  const [mesLocal, setMes] = useState(hoy.getMonth() + 1)
  const [anioLocal, setAnio] = useState(hoy.getFullYear())
  const mes = periodo ? periodo.mes : mesLocal
  const anio = periodo ? periodo.anio : anioLocal
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [filtro, setFiltro] = useState('')   // '' | 'pendiente' | 'parcial' | 'sin_declarar'

  useEffect(() => {
    setCargando(true)
    setError(null)
    odooAPI.reporteFacturacion(mes, anio)
      .then((r) => setDatos(r.data))
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setCargando(false))
  }, [mes, anio])

  const etiquetas = datos?.etiquetas || {}
  const nombreServicio = (k) => etiquetas[k] || k

  const filas = useMemo(() => {
    const d = datos?.data || []
    if (filtro === 'pendiente') return d.filter((x) => x.estado_facturacion === 'pendiente')
    if (filtro === 'parcial') return d.filter((x) => x.declaracion.estado === 'parcial')
    if (filtro === 'sin_declarar') return d.filter((x) => x.declaracion.estado === 'ninguna')
    return d
  }, [datos, filtro])

  // El reporte tiene que poder salir de la pantalla: CSV con lo mismo que se ve.
  const descargarCsv = () => {
    const enc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lineas = [
      ['RUC', 'Contribuyente', 'Declaración', 'Hechas', 'Faltan',
       'Honorario registrado', 'Facturado en Odoo', 'Diferencia', 'Estado', 'Facturas'].map(enc).join(';'),
      ...filas.map((f) => [
        f.ruc, f.nombre,
        DECL[f.declaracion.estado]?.txt || f.declaracion.estado,
        f.declaracion.hechas.map(nombreServicio).join(' / '),
        f.declaracion.faltan.map(nombreServicio).join(' / '),
        f.registrado.toFixed(2), f.facturado.toFixed(2), f.diferencia.toFixed(2),
        FACT[f.estado_facturacion]?.txt || f.estado_facturacion,
        f.facturas.map((x) => x.numero).join(' / '),
      ].map(enc).join(';')),
    ]
    const blob = new Blob(['﻿' + lineas.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `Facturacion_${anio}${String(mes).padStart(2, '0')}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  }

  const r = datos?.resumen || {}
  const anios = [hoy.getFullYear(), hoy.getFullYear() - 1, hoy.getFullYear() - 2]

  // Del reporte a la emisión SIN cambiar de mes: leer que faltan 12 facturas y
  // tener que ir a buscar el período a mano era el paso que se saltaba.
  const irAFacturar = () => {
    if (onFacturarMes) return onFacturarMes()
    navigate(`/facturacion?p=${clavePeriodo(mes, anio)}`)
  }

  return (
    <div className="rf-wrap">
      {!embebido && <WorkflowGuide steps={RF_STEPS} />}

      <header className="rf-header">
        {!embebido && (
          <div>
            <h1 className="rf-title">📊 Reporte y comparativo de facturación</h1>
            <p className="rf-sub">
              Quién declaró (todo o en parte), a quién falta facturarle y qué tiene Odoo realmente emitido en el mes.
            </p>
          </div>
        )}
        {/* Con período del módulo no se repite el selector: mandaría dos meses
            distintos en la misma pantalla. */}
        {!periodo && (
          <div className="rf-periodo">
            <select value={mes} onChange={(e) => setMes(Number(e.target.value))}>
              {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
              {anios.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        )}
      </header>

      {cargando && <div className="rf-cargando">Cargando el mes…</div>}
      {error && <div className="rf-error">⚠ {error}</div>}

      {!cargando && !error && datos && (
        <>
          {!datos.odoo_ok && (
            <div className="rf-aviso">
              ℹ Odoo no respondió: la columna de facturación puede estar incompleta y el comparativo no es concluyente.
            </div>
          )}

          {/* Tres lecturas del mes: el trabajo, el cobro y lo que dice Odoo */}
          <section className="rf-kpis">
            <div className="rf-kpi">
              <span className="rf-kpi-tit">Declaración del mes</span>
              <div className="rf-kpi-linea"><b className="ok">{r.decl_total || 0}</b> completas</div>
              <div className="rf-kpi-linea"><b className="warn">{r.decl_parcial || 0}</b> parciales</div>
              <div className="rf-kpi-linea"><b className="bad">{r.decl_ninguna || 0}</b> sin declarar</div>
              {r.sin_obligaciones > 0 && (
                <div className="rf-kpi-nota">{r.sin_obligaciones} sin obligaciones mensuales</div>
              )}
            </div>
            <div className="rf-kpi">
              <span className="rf-kpi-tit">Facturación</span>
              <div className="rf-kpi-linea"><b className="ok">{r.facturados || 0}</b> facturados</div>
              <div className="rf-kpi-linea"><b className="bad">{r.pendientes || 0}</b> faltan facturar · {fmt(r.monto_pendiente)}</div>
              {r.difieren > 0 && <div className="rf-kpi-linea"><b className="warn">{r.difieren}</b> con monto distinto</div>}
              {r.solo_odoo > 0 && <div className="rf-kpi-linea"><b className="warn">{r.solo_odoo}</b> solo en Odoo</div>}
            </div>
            <div className="rf-kpi">
              <span className="rf-kpi-tit">Comparativo</span>
              <div className="rf-kpi-linea">Registrado <b>{fmt(r.monto_registrado)}</b></div>
              <div className="rf-kpi-linea">Facturado <b>{fmt(r.monto_facturado)}</b></div>
              <div className={`rf-kpi-linea ${Math.abs((r.monto_facturado || 0) - (r.monto_registrado || 0)) > 0.02 ? 'warn' : ''}`}>
                Diferencia <b>{fmt((r.monto_facturado || 0) - (r.monto_registrado || 0))}</b>
              </div>
            </div>
            <div className="rf-kpi">
              <span className="rf-kpi-tit">Reporte de Odoo</span>
              <div className="rf-kpi-linea"><b>{r.facturas || 0}</b> factura(s) emitida(s)</div>
              <div className="rf-kpi-linea"><b className="ok">{r.autorizadas || 0}</b> autorizadas por el SRI</div>
              <div className="rf-kpi-linea"><b>{r.pagadas || 0}</b> cobradas · por cobrar {fmt(r.por_cobrar)}</div>
            </div>
          </section>

          <div className="rf-barra">
            <div className="rf-filtros">
              <button className={filtro === '' ? 'act' : ''} onClick={() => setFiltro('')}>Todos ({datos.data.length})</button>
              <button className={filtro === 'pendiente' ? 'act' : ''} onClick={() => setFiltro('pendiente')}>
                Faltan facturar ({r.pendientes || 0})
              </button>
              <button className={filtro === 'parcial' ? 'act' : ''} onClick={() => setFiltro('parcial')}>
                Declaración parcial ({r.decl_parcial || 0})
              </button>
              <button className={filtro === 'sin_declarar' ? 'act' : ''} onClick={() => setFiltro('sin_declarar')}>
                Sin declarar ({r.decl_ninguna || 0})
              </button>
            </div>
            <div className="rf-acciones">
              {r.pendientes > 0 && (
                <button className="rf-facturar" onClick={irAFacturar}
                  title={`Ir a emitir las facturas de ${datos.periodo.etiqueta}`}>
                  📤 Facturar {r.pendientes} pendiente(s) de {datos.periodo.etiqueta} · {fmt(r.monto_pendiente)}
                </button>
              )}
              <button className="rf-csv" onClick={descargarCsv} disabled={!filas.length}>⬇ Descargar CSV</button>
            </div>
          </div>

          <div className="rf-tabla-wrap">
            <table className="rf-tabla">
              <thead>
                <tr>
                  <th>Contribuyente</th>
                  <th>Declaración del mes</th>
                  <th className="num">Honorario</th>
                  <th className="num">Facturado</th>
                  <th className="num">Dif.</th>
                  <th>Factura en Odoo</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.ruc}>
                    <td>
                      <div className="rf-nombre">{f.nombre}</div>
                      <div className="rf-ruc">{f.ruc}</div>
                    </td>
                    <td>
                      <span className={`rf-chip ${DECL[f.declaracion.estado]?.cls}`}>
                        {DECL[f.declaracion.estado]?.txt}
                      </span>
                      {f.declaracion.hechas.length > 0 && (
                        <div className="rf-detalle">✔ {f.declaracion.hechas.map(nombreServicio).join(' · ')}</div>
                      )}
                      {f.declaracion.faltan.length > 0 && (
                        <div className="rf-detalle falta">✖ falta {f.declaracion.faltan.map(nombreServicio).join(' · ')}</div>
                      )}
                      {f.declaracion.renta && <div className="rf-detalle">＋ Renta declarada este mes</div>}
                    </td>
                    <td className="num" title={f.conceptos.map((c) => `${c.concepto}: ${fmt(c.bruto)}`).join('\n')}>
                      {f.registrado ? fmt(f.registrado) : '—'}
                    </td>
                    <td className="num">{f.facturado ? fmt(f.facturado) : '—'}</td>
                    <td className={`num ${Math.abs(f.diferencia) > 0.02 ? 'warn' : ''}`}>
                      {f.diferencia ? fmt(f.diferencia) : '—'}
                    </td>
                    <td>
                      <span className={`rf-chip ${FACT[f.estado_facturacion]?.cls}`}>
                        {FACT[f.estado_facturacion]?.txt}
                      </span>
                      {f.estado_facturacion === 'pendiente' && (
                        <button className="rf-fact-ir" onClick={irAFacturar}
                          title={`Emitir la factura de ${datos.periodo.etiqueta}`}>emitir ›</button>
                      )}
                      {f.facturas.map((x) => (
                        <div key={x.numero} className="rf-fact">
                          {x.numero}
                          {x.autorizada ? <span className="rf-ok"> · autorizada</span> : <span className="rf-pend"> · sin autorización</span>}
                          {x.pagada ? <span className="rf-ok"> · cobrada</span> : <span className="rf-pend"> · por cobrar {fmt(x.por_cobrar)}</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
                {filas.length === 0 && (
                  <tr><td colSpan={6} className="rf-vacio">Nada que mostrar con este filtro.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* El reporte tal cual lo tiene Odoo, sin cruzarlo con nada */}
          {datos.facturas_odoo.length > 0 && (
            <section className="rf-odoo">
              <h2 className="rf-odoo-tit">🧾 Facturas emitidas en Odoo · {datos.periodo.etiqueta}</h2>
              <table className="rf-tabla">
                <thead>
                  <tr>
                    <th>Número</th><th>Fecha</th><th>Cliente</th><th>Empresa</th>
                    <th className="num">Total</th><th>SRI</th><th>Cobro</th>
                  </tr>
                </thead>
                <tbody>
                  {datos.facturas_odoo.map((x, i) => (
                    <tr key={`${x.numero}-${i}`}>
                      <td>{x.numero}</td>
                      <td>{x.fecha}</td>
                      <td>{x.nombre}</td>
                      <td className="rf-dim">{x.empresa}</td>
                      <td className="num">{fmt(x.total)}</td>
                      <td>{x.autorizada
                        ? <span className="rf-ok" title={x.autorizacion || ''}>autorizada</span>
                        : <span className="rf-pend">pendiente</span>}</td>
                      <td>{x.pagada ? <span className="rf-ok">cobrada</span> : `por cobrar ${fmt(x.por_cobrar)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="rf-nota">
                La factura se atribuye al mes de honorarios que declara en su referencia (HON-AAAA-MM);
                las emitidas antes de esa marca se ubican por su fecha de emisión.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
