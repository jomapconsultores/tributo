import { estadoDeclaracion, estadoDeclaracionCliente } from '../utils/declaracionSRI'
import './BadgeVencimiento.css'

const fechaCorta = (f) =>
  `${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()}`

/**
 * Chip con la fecha máxima de declaración del contribuyente (según 9no dígito,
 * ya trasladada a día hábil). "Bombea" (pulsa) para llamar la atención cuando el
 * plazo está por vencer: nivel 'pronto' (≤3 días), 'hoy' o 'vencido'.
 *
 * Si se pasa `client` (con periodicidad/semestre) se usa su calendario —mensual o
 * semestral (julio/enero)—; si solo se pasa `ruc`, se asume mensual.
 *
 * Devuelve null si el RUC/identificación no permite calcular la fecha.
 */
export default function BadgeVencimiento({ ruc, client = null, className = '' }) {
  const e = client ? estadoDeclaracionCliente(client) : estadoDeclaracion(ruc)
  if (!e.valido) return null

  const urgente = e.nivel === 'pronto' || e.nivel === 'hoy' || e.nivel === 'vencido'
  const ico = e.nivel === 'ok' ? '🟢' : e.nivel === 'pronto' ? '🟠' : '🔴'
  const periodoTit = e.semestral
    ? `${e.nombrePeriodo}`
    : `${e.nombreMes} ${e.anioADeclarar}`
  const titulo = `Declaración de ${periodoTit} — fecha máxima ${e.limiteTexto} · ${e.mensaje}`

  return (
    <span
      className={`bvenc bvenc--${e.nivel} ${urgente ? 'bvenc--pulse' : ''} ${className}`.trim()}
      title={titulo}
    >
      <span className="bvenc-ico" aria-hidden="true">{ico}</span>
      <span className="bvenc-txt">día {e.dia} · {fechaCorta(e.limite)}</span>
      {urgente && <span className="bvenc-msg">· {e.mensaje}</span>}
    </span>
  )
}
