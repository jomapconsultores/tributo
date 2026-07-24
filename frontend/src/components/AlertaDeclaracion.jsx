import { useState, useEffect } from 'react'
import { useClients } from '../context/ClientContext'
import { declaracionesAPI } from '../services/api'
import { estadoDeclaracionCliente } from '../utils/declaracionSRI'
import { nombreMes, periodoLargo } from '../utils/periodo'
import './AlertaDeclaracion.css'

/**
 * Banner global del plazo de declaración del contribuyente seleccionado:
 * muestra el período que se debe declarar, la fecha máxima y una alerta según el
 * nivel (a tiempo / pronto / hoy / vencido). PERO si las declaraciones de ese
 * período YA fueron marcadas como presentadas al SRI, deja de marcar plazo y
 * muestra en verde "presentada — no pendiente".
 */
export default function AlertaDeclaracion() {
  const { selectedClient } = useClients()
  const [estado, setEstado] = useState(null)   // {todo_presentado, pendientes, presentadas}

  // Estado de presentación del cliente/período (para no marcar plazo si ya declaró).
  useEffect(() => {
    let vivo = true
    if (!selectedClient?.id) { setEstado(null); return }
    declaracionesAPI.estadoCliente(selectedClient.id)
      .then((r) => { if (vivo) setEstado(r.data) })
      .catch(() => { if (vivo) setEstado(null) })
    return () => { vivo = false }
  }, [selectedClient?.id])

  if (!selectedClient?.identificacion) return null

  // Ya presentada: no es pendiente en ningún lado. Mostrar confirmación verde.
  if (estado?.todo_presentado) {
    return (
      <div className="alerta-decl nivel-ok">
        <span className="alerta-decl-ico">✅</span>
        <span>
          Declaración de <strong>{periodoLargo(selectedClient)}</strong>
          {' '}· <strong>presentada al SRI</strong> — no pendiente
          {estado.presentadas?.length ? ` (${estado.presentadas.join(', ')})` : ''}
        </span>
      </div>
    )
  }

  const e = estadoDeclaracionCliente(selectedClient)
  if (!e.valido) return null

  const icono = e.nivel === 'vencido' || e.nivel === 'hoy' ? '🔴'
    : e.nivel === 'pronto' ? '🟠' : '🟢'

  // Semestral: el período es "1er/2do semestre AAAA"; mensual: "MES AÑO".
  const periodoTexto = e.semestral
    ? `${e.nombrePeriodo} (${e.rangoMeses})`
    : `${nombreMes(e.mesADeclarar)} ${e.anioADeclarar}`

  return (
    <div className={`alerta-decl nivel-${e.nivel}`}>
      <span className="alerta-decl-ico">{icono}</span>
      <span>
        Declaración {e.semestral ? 'semestral' : ''} de <strong>{periodoTexto}</strong>
        {' '}· fecha máxima: <strong>{e.limiteTexto}</strong>
        {' '}(día {e.dia} por el 9no dígito) · <strong>{e.mensaje}</strong>
        {estado?.presentadas?.length ? <span> · ya presentada: {estado.presentadas.join(', ')}</span> : null}
      </span>
    </div>
  )
}
