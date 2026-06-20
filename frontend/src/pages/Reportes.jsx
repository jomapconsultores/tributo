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

export default function Reportes({ modo }) {
  // modo: 'faltantes' (pendientes por facturar) | 'realizados' (ya facturados en
  // Odoo) | undefined (ambas secciones). Define qué submenú se está viendo.
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
  const [historial, setHistorial] = useState({})  // { ruc: [{anio,mes,etiqueta,subtotal,items}] }
  const [periodo, setPeriodo] = useState(null)     // { mes, anio, etiqueta }
  const [histAbierto, setHistAbierto] = useState(() => new Set())  // rucs con histórico expandido
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
      setHistorial(r.data?.historial || {})
      setPeriodo(r.data?.periodo || null)
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
        precio_oficial: fila.precio_oficial != null && fila.precio_oficial !== '' ? parseFloat(fila.precio_oficial) || 0 : null,
        descuento: parseFloat(fila.descuento) || 0,
        iva_incluido: !!fila.iva_incluido,
      })
      clearRpDraft(key)  // guardado confirmado: ya no hace falta el borrador local
    } catch (e) {
      alert('No se pudo guardar: ' + (e.response?.data?.detail || e.message))
    } finally { setGuardando('') }
  }

  // Edita oficial / descuento / neto manteniendo la relación neto = oficial×(1−desc/100).
  const r2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100
  const setPrecio = (i, campo, val, guardar = false) => {
    setRows((rs) => {
      const next = rs.map((r, idx) => {
        if (idx !== i) return r
        let oficial = parseFloat(r.precio_oficial) || 0
        let desc = parseFloat(r.descuento) || 0
        let neto = parseFloat(r.valor) || 0
        const v = parseFloat(val) || 0
        if (campo === 'oficial') { oficial = v; neto = r2(oficial * (1 - desc / 100)) }
        else if (campo === 'descuento') { desc = Math.min(100, Math.max(0, v)); neto = r2(oficial * (1 - desc / 100)) }
        else if (campo === 'neto') { neto = v; desc = oficial > 0 ? r2(Math.max(0, (1 - neto / oficial) * 100)) : 0 }
        return { ...r, precio_oficial: oficial, descuento: desc, valor: neto }
      })
      const f = next[i]
      writeRpDraft(f.identificacion + '|' + f.concepto, { valor: f.valor, cobrar: f.cobrar, iva_incluido: f.iva_incluido, precio_oficial: f.precio_oficial, descuento: f.descuento })
      if (guardar) guardarFila(f)
      return next
    })
  }

  const setFila = (i, cambios, guardar = false) => {
    setRows((rs) => {
      const next = rs.map((r, idx) => (idx === i ? { ...r, ...cambios } : r))
      const f = next[i]
      // Guardar al instante en el navegador cada cambio (sobrevive a cortes de internet)
      writeRpDraft(f.identificacion + '|' + f.concepto, { valor: f.valor, cobrar: f.cobrar, iva_incluido: f.iva_incluido, precio_oficial: f.precio_oficial, descuento: f.descuento })
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
  const toggleHist = (ident) => setHistAbierto((s) => {
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
        procesado: !!r.procesado,           // ya facturado en Odoo este período
        certificada: !!r.certificada,       // con autorización del SRI
        factura_numero: r.factura_numero,
        factura_fecha: r.factura_fecha,
        autorizacion: r.autorizacion,
        rows: [],
      })
      m.get(r.identificacion).rows.push(r)
    }
    const out = [...m.values()]
    out.forEach((g) => { g.subtotal = g.rows.filter((r) => r.cobrar).reduce((s, r) => s + bruto(r), 0) })
    return out
  }, [filtradas])

  // Dos partes: pendientes (sin factura emitida en Odoo) y procesadas (ya facturadas).
  const pendientes = useMemo(() => grupos.filter((g) => !g.procesado), [grupos])
  const procesados = useMemo(() => grupos.filter((g) => g.procesado), [grupos])
  const totalPendiente = useMemo(() => pendientes.reduce((s, g) => s + g.subtotal, 0), [pendientes])
  const totalProcesado = useMemo(() => procesados.reduce((s, g) => s + g.subtotal, 0), [procesados])


  const exportar = async (tipo) => {
    try {
      const r = tipo === 'excel' ? await reportesAPI.exportExcel(ivaIncluido) : await reportesAPI.exportPdf(ivaIncluido)
      downloadBlob(r.data, `Reporte_Honorarios.${tipo === 'excel' ? 'xlsx' : 'pdf'}`,
        tipo === 'excel' ? undefined : 'application/pdf')
    } catch (e) { alert('Error al exportar: ' + (e.response?.data?.detail || e.message)) }
  }

  // Correo redactado (mailto) como respaldo si el envío automático no está
  const abrirCorreoRedactado = () => {
    // Solo lo PENDIENTE (lo procesado ya está facturado en Odoo).
    const conValor = pendientes.filter((g) => g.subtotal > 0)
    if (!conValor.length) { alert('No hay valores pendientes a cobrar para enviar.'); return }
    const detalle = conValor.map((g) => {
      const items = g.rows.filter((r) => r.cobrar && (parseFloat(r.valor) || 0) > 0)
        .map((r) => `   - ${r.concepto}: ${money(r.valor)}`).join('\n')
      return `${g.contribuyente} (${g.identificacion})\n${items}\n   Subtotal: ${money(g.subtotal)}`
    }).join('\n\n')
    let cierre = `\n\nTOTAL A FACTURAR: ${money(totalPendiente)}`
    if (ivaIncluido) { const d = desglosa(totalPendiente); cierre = `\n\nTOTAL (IVA incluido): ${money(totalPendiente)}\n   Base imponible: ${money(d.base)}\n   IVA 15%: ${money(d.iva)}` }
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

  // Tabla de una de las dos partes (pendientes / procesadas).
  const renderTabla = (lista, totalLista, totalLabel) => (
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
        {lista.map((g) => (
          <Grupo key={g.identificacion} g={g} cerrado={colapsados.has(g.identificacion)}
            onToggle={() => toggleGrupo(g.identificacion)}
            rows={rows} setFila={setFila} setPrecio={setPrecio} guardando={guardando}
            onAddRubro={() => agregarRubro(g.identificacion, g.contribuyente)}
            onDelRubro={borrarRubro} money={money}
            bruto={bruto} desglosa={desglosa}
            historial={historial[g.identificacion] || []}
            histAbierto={histAbierto.has(g.identificacion)}
            onToggleHist={() => toggleHist(g.identificacion)} />
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className="r"><strong>{totalLabel}{search ? ' (filtrado)' : ''}</strong></td>
          <td></td>
          <td className="r"><strong>{money(totalLista)}</strong></td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  )

  // Qué submenú se ve: Faltantes (por facturar), Realizados (ya facturados) o ambos.
  const verFaltantes = modo !== 'realizados'
  const verRealizados = modo !== 'faltantes'
  const lista = modo === 'realizados' ? procesados : modo === 'faltantes' ? pendientes : grupos
  const tituloModo = modo === 'realizados' ? 'Realizados (facturados en Odoo)'
    : modo === 'faltantes' ? 'Faltantes (por facturar)' : 'Honorarios a cobrar'
  const totalActivo = modo === 'realizados' ? totalProcesado : totalPendiente

  return (
    <div className="rp-page">
      <header className="rp-header">
        <div>
          <h1>📑 Reportes — {tituloModo} {periodo && <span className="rp-periodo">· {periodo.etiqueta}</span>}</h1>
          <p className="rp-sub">Cada contribuyente (desplegable) con los servicios que se le hacen. <strong>Faltantes</strong> = aún no facturados en Odoo este período; <strong>Realizados</strong> = ya facturados (✅), con la insignia de <strong>certificación SRI</strong> si tienen número de autorización. Cada concepto muestra el <strong>precio sugerido de Odoo</strong> (💡); el botón <strong>"usar"</strong> lo aplica. Lo que cargues a mano se respeta y se guarda.</p>
        </div>
        <div className="rp-total-box">
          <span className="rp-total-lbl">{modo === 'realizados' ? 'Ya facturado en Odoo' : 'Pendiente a cobrar'}{search ? ' (filtrado)' : ''}{ivaIncluido ? ' (IVA incl.)' : ''}</span>
          <span className="rp-total-val">{money(totalActivo)}</span>
          {ivaIncluido && (() => { const d = desglosa(totalActivo); return (
            <span className="rp-total-desglose">Base {money(d.base)} + IVA 15% {money(d.iva)}</span>
          ) })()}
          {!modo && totalProcesado > 0 && <span className="rp-total-proc">Ya facturado en Odoo: {money(totalProcesado)}</span>}
        </div>
      </header>

      <div className="rp-toolbar">
        <input className="rp-search" placeholder="🔍 Buscar contribuyente o concepto…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="rp-count">{lista.length} contribuyente(s)</span>
        <button className="rp-btn" onClick={() => setColapsados(new Set(lista.map((g) => g.identificacion)))}>▸ Contraer todo</button>
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
        ) : rows.length === 0 ? (
          <div className="rp-empty">No hay contribuyentes cargados todavía. Crea clientes y aparecerán aquí con sus servicios.</div>
        ) : (
          <>
            {verFaltantes && (
              <div className="rp-seccion">
                <h2 className="rp-seccion-tit rp-seccion-pend">
                  🟠 Faltantes (por facturar) <span className="rp-seccion-cnt">{pendientes.length}</span>
                </h2>
                <p className="rp-seccion-sub">Aún no tienen factura emitida en Odoo este período.</p>
                {pendientes.length === 0
                  ? <div className="rp-empty">{search ? 'Ninguno coincide con la búsqueda.' : 'Nada faltante: todo lo visible ya fue facturado en Odoo. 🎉'}</div>
                  : renderTabla(pendientes, totalPendiente, 'TOTAL faltante a cobrar')}
              </div>
            )}

            {verRealizados && (
              <div className="rp-seccion">
                <h2 className="rp-seccion-tit rp-seccion-proc">
                  ✅ Realizados (facturados en Odoo) <span className="rp-seccion-cnt">{procesados.length}</span>
                </h2>
                <p className="rp-seccion-sub">Ya facturados en Odoo este período. La insignia indica si están <strong>certificados por el SRI</strong> (con número de autorización).</p>
                {procesados.length === 0
                  ? <div className="rp-empty">{search ? 'Ninguno coincide con la búsqueda.' : 'Todavía no hay facturas emitidas en Odoo este período.'}</div>
                  : renderTabla(procesados, totalProcesado, 'TOTAL ya facturado en Odoo')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Grupo({ g, cerrado, onToggle, rows, setFila, setPrecio, guardando, onAddRubro, onDelRubro, money, bruto, desglosa, historial, histAbierto, onToggleHist }) {
  const d = g.subtotal > 0 ? desglosa(g.subtotal) : null
  return (
    <>
      <tr className="rp-grupo-head">
        <td onClick={onToggle} style={{ cursor: 'pointer' }}>
          <span className="rp-caret">{cerrado ? '▸' : '▾'}</span>
          <strong>{g.contribuyente || '—'}</strong>
          <span className="rp-grupo-ruc">{g.identificacion}</span>
          {g.rows.some((r) => r.hecho) && <span className="rp-lista-badge" title="Tiene declaración/anexo realizado: lista para facturar">✓ Declaración lista</span>}
          {!g.procesado && g.rows.some((r) => r.sin_odoo) && <span className="rp-sinodoo-badge" title="No se encontró una factura de este cliente en Odoo: el valor quedó en blanco. Cárgalo a mano o emítele una factura en Odoo.">⚠ sin valor en Odoo</span>}
          {g.procesado && (
            g.certificada
              ? <span className="rp-cert-badge" title={`Factura ${g.factura_numero || ''} autorizada por el SRI${g.autorizacion ? ' · Aut. ' + g.autorizacion : ''}${g.factura_fecha ? ' · ' + g.factura_fecha : ''}`}>🧾 Certificada SRI{g.factura_numero ? ' · ' + g.factura_numero : ''}</span>
              : <span className="rp-proc-badge" title={`Factura ${g.factura_numero || ''} emitida en Odoo; autorización del SRI pendiente${g.factura_fecha ? ' · ' + g.factura_fecha : ''}`}>🧾 Facturada (SRI pendiente){g.factura_numero ? ' · ' + g.factura_numero : ''}</span>
          )}
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
          <tr key={key} className={`${!r.cobrar ? 'rp-row-off ' : ''}${r.hecho ? 'rp-row-hecho' : ''}`}>
            <td className="rp-concepto">
              {r.hecho && <span className="rp-check" title="Declaración hecha este mes: se debe facturar">✓</span>}
              {r.concepto}
              {r.relevante && !r.hecho && <span className="rp-tag" title="Contratado o realizado">●</span>}
              {r.personalizado && <span className="rp-badge-custom">rubro propio</span>}
              {r.arrastrado && <span className="rp-arrastrado" title="Valor traído del mes anterior; ajústalo si cambió">↩ mes anterior</span>}
              {r.origen === 'odoo' && <span className="rp-odoo-tag" title="Valor traído de la última factura emitida a este cliente en Odoo (base sin IVA). Ajústalo si cambió.">Odoo</span>}
            </td>
            <td className="c">
              <input type="checkbox" checked={!!r.cobrar}
                onChange={(e) => setFila(realIdx, { cobrar: e.target.checked }, true)} />
            </td>
            <td className="r">
              <div className="rp-precio-cell">
                <label className="rp-pc" title="Precio oficial (de lista). A Odoo va como precio unitario.">
                  <span>Oficial</span>
                  <input type="number" step="0.01" min="0" value={r.precio_oficial ?? ''}
                    onChange={(e) => setPrecio(realIdx, 'oficial', e.target.value)}
                    onBlur={() => setPrecio(realIdx, 'oficial', r.precio_oficial, true)}
                    disabled={!r.cobrar} />
                </label>
                <label className="rp-pc rp-pc-desc" title="% de descuento sobre el oficial. A Odoo va como descuento de la línea.">
                  <span>Desc%</span>
                  <input type="number" step="0.01" min="0" max="100" value={r.descuento ?? 0}
                    onChange={(e) => setPrecio(realIdx, 'descuento', e.target.value)}
                    onBlur={() => setPrecio(realIdx, 'descuento', r.descuento, true)}
                    disabled={!r.cobrar} />
                </label>
                <label className="rp-pc rp-pc-neto" title="Neto a cobrar (oficial con el descuento). Si lo cambiás, el descuento se recalcula.">
                  <span>Neto</span>
                  <input type="number" step="0.01" min="0" value={r.valor}
                    onChange={(e) => setPrecio(realIdx, 'neto', e.target.value)}
                    onBlur={() => setPrecio(realIdx, 'neto', r.valor, true)}
                    disabled={!r.cobrar} />
                </label>
                <span className="rp-iva-mode" role="group" aria-label="Modo de IVA">
                  <button type="button" className={`rp-iva-opt ${!r.iva_incluido ? 'on' : ''}`}
                    title="El neto es base; se le suma el 15% de IVA"
                    onClick={() => setFila(realIdx, { iva_incluido: false }, true)} disabled={!r.cobrar}>+IVA</button>
                  <button type="button" className={`rp-iva-opt ${r.iva_incluido ? 'on' : ''}`}
                    title="El neto ya incluye el 15% de IVA"
                    onClick={() => setFila(realIdx, { iva_incluido: true }, true)} disabled={!r.cobrar}>incl.</button>
                </span>
              </div>
              {r.cobrar && (parseFloat(r.valor) || 0) > 0 && (
                <div className="rp-bruto">
                  {(parseFloat(r.descuento) || 0) > 0 && <span>oficial {money(r.precio_oficial)} −{r.descuento}% · </span>}
                  Total c/IVA: {money(bruto(r))}
                </div>
              )}
              {r.sugerido != null && (
                <div className="rp-sugerido" title={`Última factura en Odoo: ${r.sugerido_concepto || ''}${r.sugerido_fecha ? ' · ' + r.sugerido_fecha : ''}`}>
                  💡 Odoo:{' '}
                  {r.sugerido_descuento > 0
                    ? <span>oficial <strong>{money(r.sugerido_oficial)}</strong> −{r.sugerido_descuento}% = <strong>{money(r.sugerido)}</strong></span>
                    : <strong>{money(r.sugerido)}</strong>}
                  <span className="rp-sug-con"> {r.sugerido_concepto}</span>
                  {Math.abs((parseFloat(r.valor) || 0) - r.sugerido) > 0.005
                    ? <button className="rp-sug-aplicar" onClick={() => setFila(realIdx, { precio_oficial: r.sugerido_oficial, descuento: r.sugerido_descuento, valor: r.sugerido, iva_incluido: false, cobrar: true }, true)}>usar</button>
                    : <span className="rp-sug-ok"> ✓ aplicado</span>}
                </div>
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
            {historial.length > 0 && (
              <button className="rp-hist-btn" onClick={onToggleHist}
                title="Ver lo cobrado en meses anteriores">
                {histAbierto ? '▾' : '▸'} 🗂 Meses anteriores ({historial.length})
              </button>
            )}
          </td>
        </tr>
      )}
      {!cerrado && histAbierto && historial.map((p) => (
        <tr key={`${g.identificacion}-${p.anio}-${p.mes}`} className="rp-hist-row">
          <td colSpan={4}>
            <div className="rp-hist-per">
              <span className="rp-hist-mes">{p.etiqueta}</span>
              <span className="rp-hist-items">
                {p.items.map((it, i) => (
                  <span key={i} className="rp-hist-item">
                    {it.concepto}: {money(it.bruto)}{it.iva_incluido ? ' (incl.)' : ' (+IVA)'}
                  </span>
                ))}
              </span>
              <span className="rp-hist-sub">Subtotal {money(p.subtotal)}</span>
            </div>
          </td>
        </tr>
      ))}
    </>
  )
}
