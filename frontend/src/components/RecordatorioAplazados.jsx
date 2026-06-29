import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { declaracionesAPI } from '../services/api'
import { fmtMoney as money } from '../utils/format'
import './AlertaDeclaracion.css'

const NOMBRE_MES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

/**
 * Recordatorio global de pagos APLAZADOS que ya vencen (o vencieron), estilo SRI.
 * Aparece en todas las pantallas mientras haya un aplazamiento pendiente cuyo
 * vencimiento sea este mes o anterior.
 */
export default function RecordatorioAplazados() {
  const { clients, selectClient } = useClients()
  const navigate = useNavigate()
  const [aplazados, setAplazados] = useState([])

  useEffect(() => {
    declaracionesAPI.listAplazados(undefined, 'pendiente')
      .then((r) => setAplazados(r.data?.data || []))
      .catch(() => {})
  }, [])

  const hoy = new Date()
  const mesActual = hoy.getMonth() + 1
  const anioActual = hoy.getFullYear()
  const vencidoOHoy = (a) => (a.vence_anio < anioActual) ||
    (a.vence_anio === anioActual && a.vence_mes <= mesActual)
  const due = aplazados.filter(vencidoOHoy)
  if (!due.length) return null

  const nombre = (cid) => clients.find((c) => c.id === cid)?.nombre || 'contribuyente'
  const irA = (a) => {
    selectClient(a.client_id)
    navigate(a.tipo === 'IVA' ? '/declaracion-iva' : '/declaracion-ice')
  }

  return (
    <>
      {due.map((a) => {
        const yaVencio = (a.vence_anio < anioActual) ||
          (a.vence_anio === anioActual && a.vence_mes < mesActual)
        return (
          <div key={a.id} className={`alerta-decl nivel-${yaVencio ? 'vencido' : 'hoy'} recordatorio-aplazado`}>
            <span className="alerta-decl-ico">📅</span>
            <span>
              Recordatorio de pago aplazado: <strong>{nombre(a.client_id)}</strong> tiene un pago de{' '}
              <strong>{a.tipo}</strong> de <strong>{money(a.monto)}</strong>{' '}
              que {yaVencio ? <strong>VENCIÓ</strong> : 'vence'} en{' '}
              <strong>{NOMBRE_MES[a.vence_mes]} {a.vence_anio}</strong>. Debe declararse y pagarse.
            </span>
            <button className="recordatorio-btn" onClick={() => irA(a)}>Ir a declarar →</button>
          </div>
        )
      })}
    </>
  )
}
