import './OrdenLista.css'

// Qué declaraciones mostrar según si alguna vez se presentaron al SRI:
//   'declaran' → las que ya se presentaron en algún período (el trabajo real del mes)
//   'nunca'    → las que nunca se presentaron: solo hay cálculos (gastos, ICE…)
//   'todas'
const OPCIONES = [
  { v: 'declaran', txt: '✅ Ya declaran', corto: '✅ Declaran', ayuda: 'Ya presentaron alguna declaración al SRI' },
  { v: 'nunca', txt: '🧮 Nunca declaradas', corto: '🧮 Nunca', ayuda: 'Nunca se presentó una declaración: solo hay cálculos' },
  { v: 'todas', txt: 'Todas', corto: 'Todas', ayuda: 'Mostrar todas' },
]

export default function FiltroDeclarados({ valor, onChange, cuentas = {}, compacto = false }) {
  return (
    <span className={`ordl ${compacto ? 'ordl--compacto' : ''}`.trim()} role="group" aria-label="Filtrar por declaraciones presentadas">
      {!compacto && <span className="ordl-lbl">Mostrar:</span>}
      {OPCIONES.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`ordl-btn ${valor === o.v ? 'activo' : ''}`}
          aria-pressed={valor === o.v}
          onClick={() => onChange(o.v)}
          title={o.ayuda}
        >
          {compacto ? o.corto : o.txt}{cuentas[o.v] != null ? ` (${cuentas[o.v]})` : ''}
        </button>
      ))}
    </span>
  )
}
