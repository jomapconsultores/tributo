import { useClients } from '../context/ClientContext'
import { estadoDeclaracionCliente } from '../utils/declaracionSRI'
import { nombreMes } from '../utils/periodo'
import './AlertaDeclaracion.css'

/**
 * Banner global del plazo de declaración del contribuyente seleccionado:
 * muestra el período que se debe declarar (mes anterior, o el semestre para
 * contribuyentes semestrales), la fecha máxima y una alerta según el nivel
 * (a tiempo / pronto / hoy / vencido).
 */
export default function AlertaDeclaracion() {
  const { selectedClient } = useClients()
  if (!selectedClient?.identificacion) return null
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
      </span>
    </div>
  )
}
