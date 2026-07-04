import { useClients } from '../context/ClientContext'
import { estadoDeclaracion } from '../utils/declaracionSRI'
import { nombreMes } from '../utils/periodo'
import './AlertaDeclaracion.css'

/**
 * Banner global del plazo de declaración del contribuyente seleccionado:
 * muestra el mes que se debe declarar (el anterior), la fecha máxima y una
 * alerta según el nivel (a tiempo / pronto / hoy / vencido).
 */
export default function AlertaDeclaracion() {
  const { selectedClient } = useClients()
  if (!selectedClient?.identificacion) return null
  const e = estadoDeclaracion(selectedClient.identificacion)
  if (!e.valido) return null

  const icono = e.nivel === 'vencido' || e.nivel === 'hoy' ? '🔴'
    : e.nivel === 'pronto' ? '🟠' : '🟢'

  return (
    <div className={`alerta-decl nivel-${e.nivel}`}>
      <span className="alerta-decl-ico">{icono}</span>
      <span>
        Declaración de <strong>{nombreMes(e.mesADeclarar)} {e.anioADeclarar}</strong>
        {' '}· fecha máxima: <strong>{e.limiteTexto}</strong>
        {' '}(día {e.dia} por el 9no dígito) · <strong>{e.mensaje}</strong>
      </span>
    </div>
  )
}
