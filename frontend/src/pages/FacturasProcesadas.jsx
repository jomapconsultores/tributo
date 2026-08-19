import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { odooAPI } from '../services/api'
import WorkflowGuide from '../components/WorkflowGuide'
import { filterBySearch } from '../utils/search'

const fmtMoney = (v) => `$${Number(v || 0).toFixed(2)}`

const FP_STEPS = [
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
  { icon: '🧾', label: 'Facturar en Odoo', path: '/facturacion' },
  { icon: '✅', label: 'Facturas procesadas', current: true },
]

// `periodo` (mes/año) lo manda el módulo de Facturación. Las facturas se
// muestran por el MES DE HONORARIOS que cubren, no por su fecha de emisión: la
// de julio emitida en agosto pertenece a julio.
export default function FacturasProcesadas({ embebido = false, periodo = null }) {
  const navigate = useNavigate()
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')          // búsqueda por fecha / RUC / nombre / número
  const [desde, setDesde] = useState('')   // rango de fechas (opcional)
  const [hasta, setHasta] = useState('')
  // Con período: solo ese mes. Se puede abrir a todos los meses sin salir de acá.
  const [soloPeriodo, setSoloPeriodo] = useState(true)
  const acotado = !!periodo && soloPeriodo

  const cargar = () => {
    setLoading(true); setError('')
    odooAPI.facturas(acotado ? periodo.mes : undefined, acotado ? periodo.anio : undefined)
      .then((r) => setData(r.data?.data || []))
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { cargar() }, [periodo?.clave, soloPeriodo])

  const filtradas = useMemo(() => {
    const byFecha = data.filter((f) => {
      if (desde && (f.fecha || '') < desde) return false
      if (hasta && (f.fecha || '') > hasta) return false
      return true
    })
    return filterBySearch(byFecha, q, (f) => [f.fecha, f.ruc, f.nombre, f.numero, f.empresa])
  }, [data, q, desde, hasta])

  const total = useMemo(() => filtradas.reduce((s, f) => s + (parseFloat(f.total) || 0), 0), [filtradas])

  // Agrupadas POR MES de honorarios, del más reciente al más antiguo. Antes era
  // una lista corrida de 800 facturas y no había forma de leer un mes completo.
  const meses = useMemo(() => {
    const m = {}
    for (const f of filtradas) {
      const clave = f.periodo || (f.fecha || '').slice(0, 7) || 'sin-fecha'
      if (!m[clave]) {
        m[clave] = { clave, etiqueta: f.periodo_etiqueta || clave, filas: [], total: 0, autorizadas: 0 }
      }
      m[clave].filas.push(f)
      m[clave].total = +(m[clave].total + (parseFloat(f.total) || 0)).toFixed(2)
      if (f.autorizada) m[clave].autorizadas += 1
    }
    return Object.values(m).sort((a, b) => (a.clave < b.clave ? 1 : -1))
  }, [filtradas])

  return (
    <div className="fp-page" style={{ padding: '16px 20px' }}>
      {!embebido && <WorkflowGuide steps={FP_STEPS} />}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          {!embebido && <h1 style={{ margin: '0 0 4px' }}>✅ Facturas procesadas</h1>}
          <p style={{ margin: 0, color: '#6b7888', fontSize: '.9rem' }}>
            Facturas de honorarios emitidas en Odoo, agrupadas por el mes que cubren.
            Buscá por fecha, RUC, nombre o número.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {periodo && (
            <button onClick={() => setSoloPeriodo((v) => !v)} style={btn}
              title={acotado ? 'Ver todos los meses' : `Ver solo ${periodo.etiqueta}`}>
              {acotado ? '📆 Ver todos los meses' : `🗓️ Ver solo ${periodo.etiqueta}`}
            </button>
          )}
          {!embebido && (
            <button onClick={() => navigate('/facturacion')} style={btn}>📤 Emitir facturas</button>
          )}
          <button onClick={cargar} style={btn}>↻ Actualizar</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 Buscar por fecha, RUC, nombre o número…"
          style={{ flex: 1, minWidth: 260, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '.9rem' }} />
        {/* Con un mes acotado el rango de fechas solo estorba. */}
        {!acotado && <>
          <label style={lbl}>Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={dateIn} /></label>
          <label style={lbl}>Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={dateIn} /></label>
        </>}
        <span style={{ fontSize: '.85rem', color: '#475569', fontWeight: 700 }}>
          {filtradas.length} factura(s) · {fmtMoney(total)}
          {acotado ? ` · ${periodo.etiqueta}` : ` · ${meses.length} mes(es)`}
        </span>
      </div>

      {error && <div style={{ color: '#c0392b', marginBottom: 10 }}>⚠ {error}</div>}

      {loading ? (
        <div style={{ color: '#94a3b8', padding: 20 }}>Cargando facturas de Odoo…</div>
      ) : meses.length === 0 ? (
        <div style={{ padding: 16, color: '#94a3b8', border: '1px solid #e8edf3', borderRadius: 10 }}>
          No hay facturas que coincidan{acotado ? ` en ${periodo.etiqueta}` : ''}.
        </div>
      ) : meses.map((m) => (
        <section key={m.clave} style={{ marginBottom: 18 }}>
          <div style={mesHead}>
            <span style={{ fontWeight: 700, color: '#1e3a6e' }}>🗓️ {m.etiqueta}</span>
            <span style={{ color: '#475569' }}>
              {m.filas.length} factura(s) · {fmtMoney(m.total)} · {m.autorizadas} autorizada(s) por el SRI
            </span>
          </div>
          <div style={{ overflowX: 'auto', border: '1px solid #e8edf3', borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
              <thead>
                <tr style={{ background: '#f6f8fb', textAlign: 'left' }}>
                  {['Fecha emisión', 'Número', 'RUC', 'Cliente', 'Empresa', 'Total', 'SRI'].map((h) => (
                    <th key={h} style={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {m.filas.map((f, i) => (
                  <tr key={`${f.numero}-${i}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      {f.fecha || '-'}
                      {f.por_referencia && (f.fecha || '').slice(0, 7) !== m.clave && (
                        <span style={{ color: '#b9770e', fontSize: '.72rem' }} title={`Emitida después: cubre ${m.etiqueta}`}> ↩ atrasada</span>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{f.numero}</td>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{f.ruc}</td>
                    <td style={td}>{f.nombre}</td>
                    <td style={td}>{f.empresa}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#1e8449' }}>{fmtMoney(f.total)}</td>
                    <td style={td} title={f.autorizacion || ''}>
                      {f.autorizada
                        ? <span style={{ color: '#1e8449', fontWeight: 700 }}>🧾 autorizada</span>
                        : f.edi_state === 'to_cancel'
                          ? <span style={{ color: '#c0392b', fontWeight: 700 }}>↩ en anulación</span>
                          : <span style={{ color: '#b9770e', fontWeight: 700 }}>⏳ pendiente</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}

const btn = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: '.85rem', fontWeight: 600 }
const lbl = { fontSize: '.8rem', color: '#475569', display: 'flex', alignItems: 'center', gap: 5 }
const dateIn = { padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 7, fontSize: '.84rem' }
const th = { padding: '8px 10px', fontWeight: 700, color: '#6b7888', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.3px' }
const td = { padding: '7px 10px', color: '#1f2937' }
const mesHead = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
  padding: '8px 12px', background: '#eef2f7', border: '1px solid #e8edf3',
  borderRadius: '10px 10px 0 0', fontSize: '.82rem',
}
