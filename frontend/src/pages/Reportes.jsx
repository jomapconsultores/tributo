import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { reportesAPI, downloadBlob } from '../services/api'
import './Reportes.css'

import { fmtMoney as money } from '../utils/format'

// Borrador local de los valores a cobrar: si se va el internet o recargas, lo
// que escribiste no se pierde. Se borra cuando el servidor confirma el guardado.
const RP_DRAFT = 'draft:reportes:cobros'
const readRpDrafts = () => { try { return JSON.parse(localStorage.getItem(RP_DRAFT) || '{}') } catch { return {} } }
const writeRpDraft = (k, v) => { try { const d = readRpDrafts(); d[k] = v; localStorage.setItem(RP_DRAFT, JSON.stringify(d)) } catch { /* noop */ } }
const clearRpDraft = (k) => { try { const d = readRpDrafts(); delete d[k]; localStorage.setItem(RP_DRAFT, JSON.stringify(d)) } catch { /* noop */ } }

export default function Reportes() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState(() => searchParams.get('q') || '')

  // Si llegan con ?q= (ej. desde el aviso de cobros), enfocar ese cliente
  useEffect(() => {
    const q = searchParams.get('q')
    if (q) setSearch(q)
  }, [searchParams])
  const [guardando, setGuardando] = useState('')
  const [colapsados, setColapsados] = useState(() => new Set())
  const [ivaIncluido, setIvaIncluido] = useState(() => localStorage.getItem('rpIvaIncluido') === '1')
  const [ivaClientes, setIvaClientes] = useState({}) // { client_id: bool }
  const savingIva = useRef({})
  useEffect(() => { try { localStorage.setItem('rpIvaIncluido', ivaIncluido ? '1' : '0') } catch { /* ignore */ } }, [ivaIncluido])
  const desglosa = (t) => { const base = Math.round((t / 1.15) * 100) / 100; return { base, iva: Math.round((t - base) * 100) / 100 } }
  // Total a cobrar por ítem (con IVA incluido): si es "+IVA" se suma el 15%; si ya está incluido, queda igual.
  const bruto = (r) => (parseFloat(r.valor) || 0) * (r.iva_incluido ? 1 : 1.15)

  const cargar = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const r = await reportesAPI.cobros()
      const data = r.data?.data || []
      // Sobreponer los borradores locales pendientes (valores aún no confirmados
      // por el servidor, p.ej. si se cayó el internet) para no perderlos.
      const drafts = readRpDrafts()
      setRows(data.map((row) => {
        const k = row.identificacion + '|' + row.concepto
        return drafts[k] ? { ...row, ...drafts[k] } : row
      }))
      // Inicializar iva por client_id desde los datos
      const ivaMap = {}
      for (const row of data) {
        if (row.client_id) ivaMap[row.client_id] = row.iva_incluido || false
      }
      setIvaClientes(ivaMap)
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
        iva_incluido: !!fila.iva_incluido,
      })
      clearRpDraft(key)  // guardado confirmado: ya no hace falta el borrador local
    } catch (e) {
      alert('No se pudo guardar: ' + (e.response?.data?.detail || e.message))
    } finally { setGuardando('') }
  }

  const setFila = (i, cambios, guardar = false) => {
    setRows((rs) => {
      const next = rs.map((r, idx) => (idx === i ? { ...r, ...cambios } : r))
      const f = next[i]
      // Guardar al instante en el navegador cada cambio (sobrevive a cortes de internet)
      writeRpDraft(f.identificacion + '|' + f.concepto, { valor: f.valor, cobrar: f.cobrar, iva_incluido: f.iva_incluido })
      if (guardar) guardarFila(f)
      return next
    })
  }

  const toggleIvaCliente = async (clientId, actual) => {
    if (savingIva.current[clientId]) return
    savingIva.current[clientId] = true
    const nuevo = !actual
    setIvaClientes((prev) => ({ ...prev, [clientId]: nuevo }))
    try {
      await reportesAPI.setClienteIva(clientId, nuevo)
    } catch (e) {
      setIvaClientes((prev) => ({ ...prev, [clientId]: actual })) // revertir si falla
      alert('No se pudo guardar: ' + (e.response?.data?.detail || e.message))
    } finally { savingIva.current[clientId] = false }
  }

  const agregarRubro = async (ident, contribuyente) => {
    const nombre = (prompt(`Nuevo rubro / servicio para ${contribuyente}:`) || '').trim()
    if (!nombre) return
    try {
      await reportesAPI.guardarCobro({ identificacion: ident, producto: nombre, cobrar: true, valor: 0 })
      await cargar()
    } catch (e) { alert('No se pudo agregar: ' + (e.response?.data?.detail || e.message)) }
  }

  const borrarRubro = async (fila) => {
    if (!window.confirm(`Quitar el rubro "${fila.concepto}" de ${fila.contribuyente}?`)) return
    try {
      await reportesAPI.borrarCobro(fila.identificacion, fila.concepto)
      await cargar()
    } catch (e) { alert('No se pudo quitar: ' + (e.response?.data?.detail || e.message)) }
  }

  const toggleGrupo = (ident) => setColapsados((s) => {
    const n = new Set(s); n.has(ident) ? n.delete(ident) : n.add(ident); return n
  })

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.contribuyente, r.identificacion, r.concepto]
      .some((f) => String(f || '').toLowerCase().includes(q)))
  }, [rows, search])

  // Agrupado por contribuyente, con subtotal
  const grupos = useMemo(() => {
    const m = new Map()
    for (const r of filtradas) {
      if (!m.has(r.identificacion)) m.set(r.identificacion, {
        identificacion: r.identificacion,
        contribuyente: r.contribuyente,
        client_id: r.client_id,
        rows: [],
      })
      m.get(r.identificacion).rows.push(r)
    }
    const out = [...m.values()]
    out.forEach((g) => { g.subtotal = g.rows.filter((r) => r.cobrar).reduce((s, r) => s + bruto(r), 0) })
    return out
  }, [filtradas])

  const total = useMemo(
    () => filtradas.filter((r) => r.cobrar).reduce((s, r) => s + bruto(r), 0),
    [filtradas]
  )
  const totalGeneral = useMemo(
    () => rows.filter((r) => r.cobrar).reduce((s, r) => s + bruto(r), 0),
    [rows]
  )

  const exportar = async (tipo) => {
    try {
      const r = tipo === 'excel' ? await reportesAPI.exportExcel(ivaIncluido) : await reportesAPI.exportPdf(ivaIncluido)
      downloadBlob(r.data, `Reporte_Honorarios.${tipo === 'excel' ? 'xlsx' : 'pdf'}`,
        tipo === 'excel' ? undefined : 'application/pdf')
    } catch (e) { alert('Error al exportar: ' + (e.response?.data?.detail || e.message)) }
  }

  // Correo redactado (mailto) como respaldo si el envío automático no está
  const abrirCorreoRedactado = () => {
    const conValor = grupos.filter((g) => g.subtotal > 0)
    if (!conValor.length) { alert('No hay valores a cobrar para enviar.'); return }
    const detalle = conValor.map((g) => {
      const items = g.rows.filter((r) => r.cobrar && (parseFloat(r.valor) || 0) > 0)
        .map((r) => `   - ${r.concepto}: ${money(r.valor)}`).join('\n')
      return `${g.contribuyente} (${g.identificacion})\n${items}\n   Subtotal: ${money(g.subtotal)}`
    }).join('\n\n')
    let cierre = `\n\nTOTAL A FACTURAR: ${money(totalGeneral)}`
    if (ivaIncluido) { const d = desglosa(totalGeneral); cierre = `\n\nTOTAL (IVA incluido): ${money(totalGeneral)}\n   Base imponible: ${money(d.base)}\n   IVA 15%: ${money(d.iva)}` }
    const cuerpo = `Hola Johanna,\n\nDetalle de honorarios para registrar la factura en Odoo:\n\n${detalle}${cierre}\n\nGracias.`
    window.location.href = `mailto:johannanievecela@hotmail.com?subject=${encodeURIComponent('Honorarios para facturar en Odoo')}&body=${encodeURIComponent(cuerpo)}`
  }

  // Intenta el envío automático (servidor); si no está configurado, abre el redactado.
  const enviarAJohanna = async () => {
    try {
      const r = await reportesAPI.enviarCorreo(ivaIncluido)
      if (r.data?.ok) {
        const extra = ivaIncluido && r.data.base != null ? ` (Base ${money(r.data.base)} + IVA ${money(r.data.iva)})` : ''
        alert(`✔ Correo enviado a Johanna (${r.data.destinatario}). Total: ${money(r.data.total)}${extra}`); return
      }
      abrirCorreoRedactado()  // no configurado
    } catch (e) {
      const msg = e.response?.data?.detail || ''
      if (msg) alert('No se pudo enviar automáticamente (' + msg + '). Abriré el correo redactado.')
      abrirCorreoRedactado()
    }
  }

  return (
    <div className="rp-page">
      <header className="rp-header">
        <div>
          <h1>📑 Reportes — Honorarios a cobrar</h1>
          <p className="rp-sub">Cada contribuyente (desplegable) con los servicios que se le hacen. Marca si se cobra y define el valor; se guarda solo. Puedes agregar rubros que no estén en la lista con "➕ Agregar rubro".</p>
        </div>
        <div className="rp-total-box">
          <span className="rp-total-lbl">Total a cobrar{search ? ' (filtrado)' : ''}{ivaIncluido ? ' (IVA incl.)' : ''}</span>
          <span className="rp-total-val">{money(search ? total : totalGeneral)}</span>
          {ivaIncluido && (() => { const d = desglosa(search ? total : totalGeneral); return (
            <span className="rp-total-desglose">Base {money(d.base)} + IVA 15% {money(d.iva)}</span>
          ) })()}
        </div>
      </header>

      <div className="rp-toolbar">
        <input className="rp-search" placeholder="🔍 Buscar contribuyente o concepto…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="rp-count">{grupos.length} contribuyente(s)</span>
        <button className="rp-btn" onClick={() => setColapsados(new Set(grupos.map((g) => g.identificacion)))}>▸ Contraer todo</button>
        <button className="rp-btn" onClick={() => setColapsados(new Set())}>▾ Expandir todo</button>
        <button className="rp-btn" onClick={cargar}>↻ Actualizar</button>
        <span className="rp-iva-hint" title="El IVA se define por cada valor: +IVA suma el 15%, o IVA incluido si ya viene con IVA.">ⓘ El IVA se marca por cada valor (+IVA / incl.)</span>
        <button className="rp-btn" onClick={() => exportar('excel')} disabled={!rows.length}>⬇ Excel</button>
        <button className="rp-btn" onClick={() => exportar('pdf')} disabled={!rows.length}>⬇ PDF</button>
        <button className="rp-btn rp-btn-odoo" onClick={() => navigate('/odoo-facturacion')} disabled={!rows.length} title="Pasar al módulo de Facturación Odoo para crear las facturas de lo marcado">🧾 Enviar a Odoo (facturación)</button>
      </div>

      {error && <div className="rp-error">⚠ {error}</div>}

      <div className="rp-table-wrap">
        {loading ? (
          <div className="rp-empty">Cargando…</div>
        ) : grupos.length === 0 ? (
          <div className="rp-empty">
            {rows.length === 0
              ? 'No hay contribuyentes cargados todavía. Crea clientes y aparecerán aquí con sus servicios.'
              : 'Ninguna fila coincide con la búsqueda.'}
          </div>
        ) : (
          <table className="rp-table">
            <thead>
              <tr>
                <th>Concepto / Servicio</th>
                <th className="c">¿Cobrar?</th>
                <th className="r">Valor a cobrar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {grupos.map((g) => {
                const cerrado = colapsados.has(g.identificacion)
                return (
                  <Grupo key={g.identificacion} g={g} cerrado={cerrado}
                    onToggle={() => toggleGrupo(g.identificacion)}
                    rows={rows} setFila={setFila} guardando={guardando}
                    onAddRubro={() => agregarRubro(g.identificacion, g.contribuyente)}
                    onDelRubro={borrarRubro} money={money}
                    bruto={bruto} desglosa={desglosa} />
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="r"><strong>TOTAL a cobrar{search ? ' (filtrado)' : ''}</strong></td>
                <td></td>
                <td className="r"><strong>{money(search ? total : totalGeneral)}</strong></td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  )
}

function Grupo({ g, cerrado, onToggle, rows, setFila, guardando, onAddRubro, onDelRubro, money, bruto, desglosa }) {
  const d = g.subtotal > 0 ? desglosa(g.subtotal) : null
  return (
    <>
      <tr className="rp-grupo-head">
        <td onClick={onToggle} style={{ cursor: 'pointer' }}>
          <span className="rp-caret">{cerrado ? '▸' : '▾'}</span>
          <strong>{g.contribuyente || '—'}</strong>
          <span className="rp-grupo-ruc">{g.identificacion}</span>
          {g.rows.some((r) => r.hecho) && <span className="rp-lista-badge" title="Tiene declaración/anexo realizado: lista para facturar">✓ Declaración lista</span>}
        </td>
        <td className="c"></td>
        <td className="r">
          <strong>{money(g.subtotal)}</strong>
          {d && <div className="rp-iva-desglose">Base {money(d.base)} · IVA {money(d.iva)} (incl.)</div>}
        </td>
        <td></td>
      </tr>
      {!cerrado && g.rows.map((r) => {
        const realIdx = rows.indexOf(r)
        const key = r.identificacion + '|' + r.concepto
        return (
          <tr key={key} className={!r.cobrar ? 'rp-row-off' : ''}>
            <td className="rp-concepto">
              {r.concepto}
              {r.relevante && <span className="rp-tag" title="Contratado o realizado">●</span>}
              {r.personalizado && <span className="rp-badge-custom">rubro propio</span>}
            </td>
            <td className="c">
              <input type="checkbox" checked={!!r.cobrar}
                onChange={(e) => setFila(realIdx, { cobrar: e.target.checked }, true)} />
            </td>
            <td className="r">
              <div className="rp-valor-cell">
                <span className="rp-money-prefix">$</span>
                <input className="rp-valor" type="number" step="0.01" min="0"
                  value={r.valor}
                  onChange={(e) => setFila(realIdx, { valor: e.target.value })}
                  onBlur={() => setFila(realIdx, {}, true)}
                  disabled={!r.cobrar} />
                <span className="rp-iva-mode" role="group" aria-label="Modo de IVA">
                  <button type="button"
                    className={`rp-iva-opt ${!r.iva_incluido ? 'on' : ''}`}
                    title="El valor es neto; se le suma el 15% de IVA"
                    onClick={() => setFila(realIdx, { iva_incluido: false }, true)}
                    disabled={!r.cobrar}>+IVA</button>
                  <button type="button"
                    className={`rp-iva-opt ${r.iva_incluido ? 'on' : ''}`}
                    title="El valor ya incluye el 15% de IVA"
                    onClick={() => setFila(realIdx, { iva_incluido: true }, true)}
                    disabled={!r.cobrar}>incl.</button>
                </span>
              </div>
              {r.cobrar && (parseFloat(r.valor) || 0) > 0 && (
                <div className="rp-bruto">Total c/IVA: {money(bruto(r))}</div>
              )}
              {guardando === key && <span className="rp-saving">guardando…</span>}
            </td>
            <td className="c">
              {r.personalizado && (
                <button className="rp-del" title="Quitar rubro" onClick={() => onDelRubro(r)}>✕</button>
              )}
            </td>
          </tr>
        )
      })}
      {!cerrado && (
        <tr className="rp-addrow">
          <td colSpan={4}>
            <button className="rp-add-btn" onClick={onAddRubro}>➕ Agregar rubro a {g.contribuyente}</button>
          </td>
        </tr>
      )}
    </>
  )
}
