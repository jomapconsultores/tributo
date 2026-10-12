import './OrdenLista.css'

/**
 * Selector de dos opciones para ordenar contribuyentes: por nombre (A–Z) o por
 * la fecha máxima de declaración (9no dígito del RUC), la más urgente primero.
 */
export default function OrdenLista({ orden, onChange, compacto = false, className = '' }) {
  return (
    <span className={`ordl ${compacto ? 'ordl--compacto' : ''} ${className}`.trim()} role="group" aria-label="Ordenar lista">
      {!compacto && <span className="ordl-lbl">Ordenar:</span>}
      <button
        type="button"
        className={`ordl-btn ${orden === 'nombre' ? 'activo' : ''}`}
        aria-pressed={orden === 'nombre'}
        onClick={() => onChange('nombre')}
        title="Ordenar alfabéticamente por nombre"
      >
        🔤 Nombre
      </button>
      <button
        type="button"
        className={`ordl-btn ${orden === 'vencimiento' ? 'activo' : ''}`}
        aria-pressed={orden === 'vencimiento'}
        onClick={() => onChange('vencimiento')}
        title="Ordenar por fecha máxima de declaración: primero lo vencido y lo que vence antes; lo ya declarado va al final"
      >
        📅 Vencimiento
      </button>
    </span>
  )
}
