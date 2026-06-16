import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccess } from '../context/AccessContext'
import { odooAPI } from '../services/api'
import { fmtMoney as money } from '../utils/format'
import './CobrosPendientesModal.css'

const DISMISS_KEY = 'cobrosPendientesVisto'

/**
 * Aviso al iniciar sesión (para Johanna, rol 'socio'): muestra los clientes con
 * pagos pendientes en Odoo y el monto que falta. Clic en un cliente lleva al
 * módulo de Reportes con ese cliente buscado. Se cierra con la ✕ (una vez por sesión).
 */
export default function CobrosPendientesModal() {
  const { role, loading } = useAccess()
  const navigate = useNavigate()
  const [items, setItems] = useState(null)
  const [abierto, setAbierto] = useState(false)

  useEffect(() => {
    if (loading || role !== 'socio') return
    if (sessionStorage.getItem(DISMISS_KEY)) return
    odooAPI.cobrosPendientes()
      .then((r) => {
        const data = r.data?.data || []
        if (data.length) { setItems(data); setAbierto(true) }
      })
      .catch(() => {})
  }, [role, loading])

  const cerrar = () => {
    setAbierto(false)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* noop */ }
  }
  const irAlCliente = (it) => {
    cerrar()
    navigate('/reportes?q=' + encodeURIComponent(it.ruc || it.cliente || ''))
  }

  if (!abierto || !items) return null
  const total = items.reduce((s, it) => s + (it.pendiente || 0), 0)

  return (
    <div className="cp-bg" onClick={cerrar}>
      <div className="cp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="cp-close" onClick={cerrar} title="Cerrar">✕</button>
        <div className="cp-head">
          <span className="cp-ico">💰</span>
          <div>
            <h2>Recordatorio de cobros</h2>
            <p>Clientes con pagos pendientes. Haz clic en un cliente para ver el detalle.</p>
          </div>
        </div>
        <div className="cp-list">
          {items.map((it, i) => (
            <button key={i} className="cp-item" onClick={() => irAlCliente(it)} title="Ver en Reportes">
              <span className="cp-cliente">
                <span className="cp-nombre">{it.cliente || '—'}</span>
                <span className="cp-sub">
                  {it.ruc && <span className="cp-ruc">{it.ruc}</span>}
                  {it.facturas > 1 && <span className="cp-fact">· {it.facturas} facturas</span>}
                </span>
              </span>
              <span className="cp-monto">{money(it.pendiente)}</span>
            </button>
          ))}
        </div>
        <div className="cp-foot">
          <span>Total pendiente de cobro</span>
          <strong>{money(total)}</strong>
        </div>
      </div>
    </div>
  )
}
