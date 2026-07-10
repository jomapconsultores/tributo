import { useClients } from '../context/ClientContext'
import { nombreMes } from '../utils/periodo'
import './AvisoAperturaVencido.css'

/**
 * Aviso (descartable) de la apertura automática del período mes vencido:
 * cuando al entrar se crea el período a declarar (el mes anterior) para los
 * contribuyentes trabajados el ciclo pasado, se informa cuántos se abrieron.
 */
export default function AvisoAperturaVencido() {
  const { aperturaVencido, dismissAperturaVencido } = useClients()
  if (!aperturaVencido?.creados) return null
  const { creados, periodo } = aperturaVencido
  const mes = nombreMes(periodo?.mes)
  const anio = periodo?.anio

  return (
    <div className="aviso-apertura">
      <span className="aviso-apertura-ico">📅</span>
      <span className="aviso-apertura-txt">
        Se abrió el período <strong>{mes} {anio}</strong> (mes vencido) para{' '}
        <strong>{creados}</strong> contribuyente{creados > 1 ? 's' : ''}. Ya podés cargar sus datos y declarar;
        los meses anteriores quedan archivados.
      </span>
      <button className="aviso-apertura-x" onClick={dismissAperturaVencido} title="Entendido">✕</button>
    </div>
  )
}
