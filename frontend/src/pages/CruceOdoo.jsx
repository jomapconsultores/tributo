import { useState, useEffect, useMemo } from 'react'
import { odooAPI } from '../services/api'
import WorkflowGuide from '../components/WorkflowGuide'
import './CruceOdoo.css'

const CO_STEPS = [
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
  { icon: '🧾', label: 'Facturar en Odoo', path: '/facturacion' },
  { icon: '🔍', label: 'Cruce con Odoo', current: true },
]

const fmt = (v) => `$${Number(v || 0).toFixed(2)}`

// Cómo se lee cada estado del cruce
const ESTADOS = {
  cuadra:    { ico: '✓', txt: 'Cuadra',              hint: 'Lo registrado y lo facturado en Odoo coinciden' },
  difiere:   { ico: '⚠', txt: 'Diferencia',          hint: 'El monto facturado en Odoo no coincide con el honorario registrado' },
  pendiente: { ico: '○', txt: 'Sin facturar',        hint: 'Hay honorario registrado en ese mes y no hay factura en Odoo' },
  solo_odoo: { ico: '↯', txt: 'Solo en Odoo',        hint: 'Hay factura en Odoo sin honorario registrado en el sistema' },
}

export default function CruceOdoo({ embebido = false }) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [meses, setMeses] = useState(12)
  const [filtro, setFiltro] = useState('')          // texto: nombre o RUC
  const [soloProblemas, setSoloProblemas] = useState(true)
  const [abierto, setAbierto] = useState({})        // { "ruc|clave": true }

  const cargar = (n) => {
    setCargando(true)
    setError(null)
    odooAPI.cruceMensual(n)
      .then((r) => setDatos(r.data))
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setCargando(false))
  }

  useEffect(() => { cargar(meses) }, [meses])

  // Filas visibles: por texto y, si se pide, solo lo que no cuadra
  const filas = useMemo(() => {
    if (!datos?.data) return []
    const q = filtro.trim().toLowerCase()
    return datos.data
      .map((c) => ({
        ...c,
        meses: soloProblemas ? c.meses.filter((m) => m.estado !== 'cuadra') : c.meses,
      }))
      .filter((c) => c.meses.length)
      .filter((c) => !q || (c.nombre || '').toLowerCase().includes(q) || (c.ruc || '').includes(q))
  }, [datos, filtro, soloProblemas])

  const res = datos?.resumen || {}

  return (
    <div className="co-wrap">
      {!embebido && <WorkflowGuide steps={CO_STEPS} />}

      <div className="co-header">
        <div>
          {!embebido && <h1 className="co-title">Cruce mensual con Odoo</h1>}
          <p className="co-sub">
            Mes a mes: lo que el sistema registró como honorario frente a lo que realmente
            se facturó en Odoo. Cada factura queda atribuida al mes que le corresponde.
          </p>
        </div>
        <label className="co-meses">
          Ventana:
          <select value={meses} onChange={(e) => setMeses(Number(e.target.value))}>
            <option value={6}>últimos 6 meses</option>
            <option value={12}>últimos 12 meses</option>
            <option value={24}>últimos 24 meses</option>
          </select>
        </label>
      </div>

      {datos && !datos.odoo_ok && (
        <div className="co-aviso">
          ⚠ No se pudo leer la facturación de Odoo. Lo que se muestra abajo es solo lo
          registrado en el sistema; el cruce no es concluyente hasta que Odoo responda.
        </div>
      )}

      {/* Marcador del cruce */}
      {datos && (
        <div className="co-resumen">
          <div className="co-card ok">
            <span className="co-card-num">{res.cuadran || 0}</span>
            <span className="co-card-lbl">meses cuadrados</span>
          </div>
          <div className="co-card warn">
            <span className="co-card-num">{res.difieren || 0}</span>
            <span className="co-card-lbl">con diferencia</span>
            <span className="co-card-mon">{fmt(res.monto_diferencia)}</span>
          </div>
          <div className="co-card pend">
            <span className="co-card-num">{res.pendientes || 0}</span>
            <span className="co-card-lbl">sin facturar</span>
            <span className="co-card-mon">{fmt(res.monto_pendiente)}</span>
          </div>
          <div className="co-card info">
            <span className="co-card-num">{res.solo_odoo || 0}</span>
            <span className="co-card-lbl">solo en Odoo</span>
          </div>
        </div>
      )}

      <div className="co-toolbar">
        <input
          className="co-buscar"
          placeholder="Buscar contribuyente o RUC…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
        />
        <label className="co-solo">
          <input type="checkbox" checked={soloProblemas} onChange={(e) => setSoloProblemas(e.target.checked)} />
          Ver solo lo que no cuadra
        </label>
        <button className="co-recargar" onClick={() => cargar(meses)} disabled={cargando}>
          {cargando ? 'consultando…' : '🔄 Volver a cruzar'}
        </button>
      </div>

      {cargando && <div className="co-loading">Cruzando con Odoo…</div>}
      {error && <div className="co-error">Error: {error}</div>}

      {!cargando && !error && filas.length === 0 && (
        <div className="co-empty">
          {soloProblemas
            ? '✅ Todos los meses con honorarios registrados están facturados y cuadran con Odoo.'
            : 'No hay honorarios ni facturas en la ventana seleccionada.'}
        </div>
      )}

      {!cargando && filas.map((c) => (
        <div key={c.ruc} className="co-cli">
          <div className="co-cli-head">
            <span className="co-cli-nom">{c.nombre || '(sin nombre)'}</span>
            <span className="co-cli-ruc">RUC {c.ruc}</span>
          </div>
          <div className="co-meses-list">
            {c.meses.map((m) => {
              const k = `${c.ruc}|${m.clave}`
              const est = ESTADOS[m.estado] || ESTADOS.cuadra
              return (
                <div key={m.clave} className={`co-mes ${m.estado}`}>
                  <button className="co-mes-head" onClick={() => setAbierto((p) => ({ ...p, [k]: !p[k] }))}>
                    <span className="co-mes-et">{m.etiqueta}</span>
                    <span className="co-mes-est" title={est.hint}>{est.ico} {est.txt}</span>
                    <span className="co-mes-cifras">
                      <span title="Honorario registrado en el sistema (IVA incl.)">sistema {fmt(m.registrado)}</span>
                      <span className="co-vs">vs</span>
                      <span title="Facturado en Odoo en ese mes">Odoo {fmt(m.facturado)}</span>
                      {Math.abs(m.diferencia) > 0.02 && (
                        <span className="co-dif">{m.diferencia > 0 ? '+' : ''}{fmt(m.diferencia).replace('$-', '-$')}</span>
                      )}
                    </span>
                    <span className="co-mes-chev">{abierto[k] ? '▾' : '▸'}</span>
                  </button>
                  {abierto[k] && (
                    <div className="co-mes-det">
                      <div className="co-col">
                        <div className="co-col-tit">En el sistema</div>
                        {m.conceptos.length === 0 && <div className="co-dim">— sin honorario registrado —</div>}
                        {m.conceptos.map((x, i) => (
                          <div key={i} className="co-det-row">
                            <span>{x.concepto}</span><span>{fmt(x.bruto)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="co-col">
                        <div className="co-col-tit">En Odoo</div>
                        {m.facturas.length === 0 && <div className="co-dim">— sin factura emitida —</div>}
                        {m.facturas.map((f, i) => (
                          <div key={i} className="co-det-row">
                            <span>
                              {f.numero} <span className="co-fecha">({f.fecha})</span>
                              {f.autorizada
                                ? <span className="co-sri ok" title={f.autorizacion}>SRI ✓</span>
                                : <span className="co-sri pend">SRI pend.</span>}
                              {f.pagada
                                ? <span className="co-pago paid">cobrada</span>
                                : <span className="co-pago pend">por cobrar {fmt(f.por_cobrar)}</span>}
                            </span>
                            <span>{fmt(f.total)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
