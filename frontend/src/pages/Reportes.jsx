import { useState, useEffect, useMemo, useCallback } from 'react'
import { reportesAPI, downloadBlob } from '../services/api'
import './Reportes.css'

const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`

export default function Reportes() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [guardando, setGuardando] = useState('')

  const cargar = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await reportesAPI.cobros()
      setRows(r.data?.data || [])
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const guardarFila = async (fila) => {
    const key = fila.identificacion + '|' + fila.concepto
    setGuardando(key)
    try {
      await reportesAPI.guardarCobro({
        identificacion: fila.identificacion, producto: fila.concepto,
        cobrar: fila.cobrar, valor: parseFloat(fila.valor) || 0,
      })
    } catch (e) {
      alert('No se pudo guardar: ' + (e.response?.data?.detail || e.message))
    } finally { setGuardando('') }
  }

  const setFila = (i, cambios, guardar = false) => {
    setRows((rs) => {
      const next = rs.map((r, idx) => (idx === i ? { ...r, ...cambios } : r))
      if (guardar) guardarFila(next[i])
      return next
    })
  }

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.contribuyente, r.identificacion, r.concepto]
      .some((f) => String(f || '').toLowerCase().includes(q)))
  }, [rows, search])

  const total = useMemo(
    () => filtradas.filter((r) => r.cobrar).reduce((s, r) => s + (parseFloat(r.valor) || 0), 0),
    [filtradas]
  )
  const totalGeneral = useMemo(
    () => rows.filter((r) => r.cobrar).reduce((s, r) => s + (parseFloat(r.valor) || 0), 0),
    [rows]
  )

  // Lista de visualización con subtotal por contribuyente
  const display = useMemo(() => {
    const out = []
    let curr = null, sub = 0
    for (const r of filtradas) {
      if (curr !== null && r.contribuyente !== curr) {
        out.push({ type: 'subtotal', contribuyente: curr, valor: sub }); sub = 0
      }
      curr = r.contribuyente
      out.push({ type: 'row', r })
      if (r.cobrar) sub += parseFloat(r.valor) || 0
    }
    if (curr !== null) out.push({ type: 'subtotal', contribuyente: curr, valor: sub })
    return out
  }, [filtradas])

  const exportar = async (tipo) => {
    try {
      const r = tipo === 'excel' ? await reportesAPI.exportExcel() : await reportesAPI.exportPdf()
      downloadBlob(r.data, `Reporte_Honorarios.${tipo === 'excel' ? 'xlsx' : 'pdf'}`,
        tipo === 'excel' ? undefined : 'application/pdf')
    } catch (e) { alert('Error al exportar: ' + (e.response?.data?.detail || e.message)) }
  }

  let prevContrib = null

  return (
    <div className="rp-page">
      <header className="rp-header">
        <div>
          <h1>📑 Reportes — Honorarios a cobrar</h1>
          <p className="rp-sub">Todos los contribuyentes con los servicios que se les hace (declaraciones y anexos). Marca si se cobra y define el valor; se guarda automáticamente para el futuro. Ya viene marcado lo que tienen contratado o realizado.</p>
        </div>
        <div className="rp-total-box">
          <span className="rp-total-lbl">Total a cobrar{search ? ' (filtrado)' : ''}</span>
          <span className="rp-total-val">{money(search ? total : totalGeneral)}</span>
        </div>
      </header>

      <div className="rp-toolbar">
        <input className="rp-search" placeholder="🔍 Buscar contribuyente o concepto…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="rp-count">{filtradas.length} de {rows.length} fila(s)</span>
        <button className="rp-btn" onClick={cargar}>↻ Actualizar</button>
        <button className="rp-btn" onClick={() => exportar('excel')} disabled={!rows.length}>⬇ Excel</button>
        <button className="rp-btn" onClick={() => exportar('pdf')} disabled={!rows.length}>⬇ PDF</button>
      </div>

      {error && <div className="rp-error">⚠ {error}</div>}

      <div className="rp-table-wrap">
        {loading ? (
          <div className="rp-empty">Cargando…</div>
        ) : filtradas.length === 0 ? (
          <div className="rp-empty">
            {rows.length === 0
              ? 'No hay contribuyentes cargados todavía. Crea clientes y aparecerán aquí con sus servicios.'
              : 'Ninguna fila coincide con la búsqueda.'}
          </div>
        ) : (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Contribuyente</th>
                <th>RUC</th>
                <th>Concepto / Servicio</th>
                <th className="c">¿Cobrar?</th>
                <th className="r">Valor a cobrar</th>
              </tr>
            </thead>
            <tbody>
              {display.map((item, di) => {
                if (item.type === 'subtotal') {
                  return (
                    <tr key={'sub-' + item.contribuyente + di} className="rp-row-subtotal">
                      <td colSpan={4} className="r">Subtotal {item.contribuyente || '—'}</td>
                      <td className="r">{money(item.valor)}</td>
                    </tr>
                  )
                }
                const r = item.r
                const realIdx = rows.indexOf(r)
                const nuevoContrib = r.contribuyente !== prevContrib
                prevContrib = r.contribuyente
                const key = r.identificacion + '|' + r.concepto
                return (
                  <tr key={key} className={`${nuevoContrib ? 'rp-row-newgroup' : ''} ${!r.cobrar ? 'rp-row-off' : ''}`}>
                    <td>{nuevoContrib ? <strong>{r.contribuyente || '—'}</strong> : ''}</td>
                    <td className="rp-ruc">{nuevoContrib ? r.identificacion : ''}</td>
                    <td>{r.concepto}{r.relevante && <span className="rp-tag" title="Contratado o realizado">●</span>}</td>
                    <td className="c">
                      <input type="checkbox" checked={!!r.cobrar}
                        onChange={(e) => setFila(realIdx, { cobrar: e.target.checked }, true)} />
                    </td>
                    <td className="r">
                      <span className="rp-money-prefix">$</span>
                      <input className="rp-valor" type="number" step="0.01" min="0"
                        value={r.valor}
                        onChange={(e) => setFila(realIdx, { valor: e.target.value })}
                        onBlur={() => setFila(realIdx, {}, true)}
                        disabled={!r.cobrar} />
                      {guardando === key && <span className="rp-saving">guardando…</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="r"><strong>TOTAL a cobrar{search ? ' (filtrado)' : ''}</strong></td>
                <td className="r"><strong>{money(search ? total : totalGeneral)}</strong></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}
