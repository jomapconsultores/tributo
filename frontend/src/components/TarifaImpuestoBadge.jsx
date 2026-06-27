import { IMPUESTO_LABEL, IMPUESTO_CAT, tarifaEspecifica, umbralAdValorem, esIndustrial2021, RANGOS_IND_2021 } from '../utils/iceCalc'
import './TarifaImpuestoBadge.css'

// Muestra, junto al RUC y mes-año, el código de impuesto que se está trabajando
// y —de forma automática según el año elegido— la tarifa específica y la tarifa
// ad-valorem (umbral) que corresponden a ese año. En cerveza industrial 2021 usa
// la tarifa del rango de producción seleccionado (rangoInd).
export default function TarifaImpuestoBadge({ codImpuesto, anio, rangoInd }) {
  const cod = String(codImpuesto || '').trim()
  const cat = IMPUESTO_CAT[cod]
  const tarifa = tarifaEspecifica(cod, anio, rangoInd)
  const umbral = umbralAdValorem(anio)
  const esBebida = cat === 'ALCOHOLICA'
  const rango2021 = esIndustrial2021(cod, anio)
  const rangoLbl = rango2021 ? (RANGOS_IND_2021.find((x) => x.key === (rangoInd || 'R1'))?.label || '') : ''

  if (!cat || tarifa == null) {
    return (
      <span className="tib tib-na" title="Este código de impuesto no tiene tarifa específica definida en el sistema">
        <span className="tib-cod">Cód. impuesto {cod || '—'}</span>
        <span className="tib-val">sin tarifa</span>
      </span>
    )
  }

  return (
    <span
      className="tib"
      title={
        `${IMPUESTO_LABEL[cod]} — tarifas vigentes en ${anio}` +
        (rango2021 ? '. En 2021 la cerveza industrial tuvo tarifas por rango de volumen de producción; se usa el Rango 1 (8.41).' : '')
      }
    >
      <span className="tib-cod">{cod} · {IMPUESTO_LABEL[cod]}</span>
      <span className="tib-year">Año {anio}</span>
      <span className="tib-val">
        Específica ${tarifa.toFixed(2)}/L{rango2021 && rangoLbl ? ` · ${rangoLbl}` : ''}
      </span>
      {esBebida && umbral != null ? (
        <span className="tib-val tib-adv">Ad-valorem: umbral ${umbral.toFixed(2)}/L · 75%</span>
      ) : (
        <span className="tib-na2">sin ad-valorem</span>
      )}
    </span>
  )
}
