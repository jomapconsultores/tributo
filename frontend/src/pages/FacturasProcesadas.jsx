import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { odooAPI } from '../services/api'
import WorkflowGuide from '../components/WorkflowGuide'

const fmtMoney = (v) => `$${Number(v || 0).toFixed(2)}`

const FP_STEPS = [
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
  { icon: '🧾', label: 'Facturar en Odoo', path: '/odoo-facturacion' },
  { icon: '✅', label: 'Facturas procesadas', current: true },
]

export default function FacturasProcesadas() {
  const navigate = useNavigate()
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')          // búsqueda por fecha / RUC / nombre / número
  const [desde, setDesde] = useState('')   // rango de fechas (opcional)
  const [hasta, setHasta] = useState('')

  const cargar = () => {
    setLoading(true); setError('')
    odooAPI.facturas()
      .then((r) => setData(r.data?.data || []))
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => { cargar() }, [])

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase()
    return data.filter((f) => {
      if (desde && (f.fecha || '') < desde) return false
      if (hasta && (f.fecha || '') > hasta) return false
      if (!t) return true
      return [f.fecha, f.ruc, f.nombre, f.numero, f.empresa]
        .some((x) => String(x || '').toLowerCase().includes(t))
    })
  }, [data, q, desde, hasta])

  const total = useMemo(() => filtradas.reduce((s, f) => s + (parseFloat(f.total) || 0), 0), [filtradas])

  return (
    <div className="fp-page" style={{ padding: '16px 20px' }}>
      <WorkflowGuide steps={FP_STEPS} />
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: '0 0 4px' }}>✅ Facturas procesadas</h1>
          <p style={{ margin: 0, color: '#6b7888', fontSize: '.9rem' }}>
            Facturas de honorarios ya emitidas en Odoo. Buscá por fecha, RUC, nombre o número.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('/odoo-facturacion')} style={btn}>📤 Emitir facturas</button>
          <button onClick={cargar} style={btn}>↻ Actualizar</button>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '14px 0' }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 Buscar por fecha, RUC, nombre o número…"
          style={{ flex: 1, minWidth: 260, padding: '8px 12px', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '.9rem' }} />
        <label style={lbl}>Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={dateIn} /></label>
        <label style={lbl}>Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={dateIn} /></label>
        <span style={{ fontSize: '.85rem', color: '#475569', fontWeight: 700 }}>{filtradas.length} factura(s) · {fmtMoney(total)}</span>
      </div>

      {error && <div style={{ color: '#c0392b', marginBottom: 10 }}>⚠ {error}</div>}

      {loading ? (
        <div style={{ color: '#94a3b8', padding: 20 }}>Cargando facturas de Odoo…</div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid #e8edf3', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.84rem' }}>
            <thead>
              <tr style={{ background: '#f6f8fb', textAlign: 'left' }}>
                {['Fecha', 'Número', 'RUC', 'Cliente', 'Empresa', 'Total', 'SRI'].map((h) => (
                  <th key={h} style={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtradas.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 16, color: '#94a3b8' }}>No hay facturas que coincidan.</td></tr>
              ) : filtradas.map((f, i) => (
                <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>{f.fecha || '-'}</td>
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
      )}
    </div>
  )
}

const btn = { border: '1px solid #cbd5e1', background: '#fff', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: '.85rem', fontWeight: 600 }
const lbl = { fontSize: '.8rem', color: '#475569', display: 'flex', alignItems: 'center', gap: 5 }
const dateIn = { padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 7, fontSize: '.84rem' }
const th = { padding: '8px 10px', fontWeight: 700, color: '#6b7888', fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.3px' }
const td = { padding: '7px 10px', color: '#1f2937' }
