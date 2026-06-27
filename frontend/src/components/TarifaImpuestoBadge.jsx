import { IMPUESTO_LABEL, IMPUESTO_CAT, tarifaEspecifica } from '../utils/iceCalc'
import './TarifaImpuestoBadge.css'

// Muestra, junto al RUC y mes-año, el código de impuesto que se está trabajando
// y la tarifa específica ($/litro de alcohol puro) que corresponde al año, de
// forma automática (se recalcula al cambiar el código o el año).
export default function TarifaImpuestoBadge({ codImpuesto, anio }) {
  const cod = String(codImpuesto || '').trim()
  const cat = IMPUESTO_CAT[cod]
  const tarifa = tarifaEspecifica(cod, anio)

  if (!cat || tarifa == null) {
    return (
      <span className="tib tib-na" title="Este código de impuesto no tiene tarifa específica definida en el sistema">
        <span className="tib-cod">Cód. impuesto {cod || '—'}</span>
        <span className="tib-val">sin tarifa específica</span>
      </span>
    )
  }

  return (
    <span className="tib" title={`${IMPUESTO_LABEL[cod]} · tarifa específica vigente en ${anio}`}>
      <span className="tib-cod">{cod} · {IMPUESTO_LABEL[cod]}</span>
      <span className="tib-year">Año {anio}</span>
      <span className="tib-val">${tarifa.toFixed(2)} / litro alcohol puro</span>
    </span>
  )
}
