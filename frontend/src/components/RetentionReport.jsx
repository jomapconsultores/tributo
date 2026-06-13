import { useMemo } from 'react'
import './RetentionReport.css'

import { fmtMoney as money, fmtPct as pct } from '../utils/format'

/**
 * Reporte de retenciones agrupado por contribuyente (agente de retención).
 * Para cada agente suma: base imponible (renta), IVA (base de retención de IVA),
 * total B.I.+IVA, retención de renta e IVA y sus porcentajes efectivos.
 * Cierra con una fila TOTAL y el número de retenciones aplicadas.
 * Se deriva de las filas cargadas → se actualiza en tiempo real.
 */
export default function RetentionReport({ rows }) {
  const { filas, total } = useMemo(() => {
    const ok = rows.filter((r) => r.estado !== 'DUPLICADO')
    const agg = {}
    for (const r of ok) {
      const key = r.ruc_emisor || r.agente_retencion || '—'
      const a = agg[key] || (agg[key] = {
        agente: r.agente_retencion || '—',
        ruc: r.ruc_emisor || '',
        num: 0, base_imponible: 0, iva: 0, ret_renta: 0, ret_iva: 0, total_retenido: 0,
      })
      a.num += 1
      a.base_imponible += parseFloat(r.base_renta) || 0
      a.iva += parseFloat(r.base_iva) || 0
      a.ret_renta += parseFloat(r.ret_renta) || 0
      a.ret_iva += parseFloat(r.ret_iva) || 0
      a.total_retenido += parseFloat(r.total_retenido) || 0
    }
    const filas = Object.values(agg)
      .map((a) => ({
        ...a,
        total_bi_iva: a.base_imponible + a.iva,
        pct_renta: a.base_imponible > 0 ? (a.ret_renta / a.base_imponible) * 100 : 0,
        pct_iva: a.iva > 0 ? (a.ret_iva / a.iva) * 100 : 0,
      }))
      .sort((x, y) => y.total_retenido - x.total_retenido)

    const total = filas.reduce((t, f) => ({
      num: t.num + f.num,
      base_imponible: t.base_imponible + f.base_imponible,
      iva: t.iva + f.iva,
      total_bi_iva: t.total_bi_iva + f.total_bi_iva,
      ret_renta: t.ret_renta + f.ret_renta,
      ret_iva: t.ret_iva + f.ret_iva,
      total_retenido: t.total_retenido + f.total_retenido,
    }), { num: 0, base_imponible: 0, iva: 0, total_bi_iva: 0, ret_renta: 0, ret_iva: 0, total_retenido: 0 })
    total.pct_renta = total.base_imponible > 0 ? (total.ret_renta / total.base_imponible) * 100 : 0
    total.pct_iva = total.iva > 0 ? (total.ret_iva / total.iva) * 100 : 0

    return { filas, total }
  }, [rows])

  if (!filas.length) return null

  return (
    <div className="rr-wrap">
      <h2 className="rr-title">📊 Reporte de retenciones por contribuyente</h2>
      <div className="rr-scroll">
        <table className="rr-table">
          <thead>
            <tr>
              <th>Contribuyente (Agente)</th>
              <th className="r"># Ret.</th>
              <th className="r">Base Imponible</th>
              <th className="r">IVA</th>
              <th className="r">Total (B.I.+IVA)</th>
              <th className="r">% Renta</th>
              <th className="r">Ret. Renta</th>
              <th className="r">% IVA</th>
              <th className="r">Ret. IVA</th>
              <th className="r">Total Retenido</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.ruc || f.agente}>
                <td className="rr-agente" title={`${f.ruc} — ${f.agente}`}>{f.agente}</td>
                <td className="r">{f.num}</td>
                <td className="r">{money(f.base_imponible)}</td>
                <td className="r">{money(f.iva)}</td>
                <td className="r">{money(f.total_bi_iva)}</td>
                <td className="r">{pct(f.pct_renta)}</td>
                <td className="r">{money(f.ret_renta)}</td>
                <td className="r">{pct(f.pct_iva)}</td>
                <td className="r">{money(f.ret_iva)}</td>
                <td className="r strong">{money(f.total_retenido)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="rr-total">
              <td>TOTAL · {total.num} retención(es)</td>
              <td className="r">{total.num}</td>
              <td className="r">{money(total.base_imponible)}</td>
              <td className="r">{money(total.iva)}</td>
              <td className="r">{money(total.total_bi_iva)}</td>
              <td className="r">{pct(total.pct_renta)}</td>
              <td className="r">{money(total.ret_renta)}</td>
              <td className="r">{pct(total.pct_iva)}</td>
              <td className="r">{money(total.ret_iva)}</td>
              <td className="r">{money(total.total_retenido)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
