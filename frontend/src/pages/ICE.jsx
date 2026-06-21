import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { iceAPI, xmlOriginalesAPI, clientsAPI, downloadBlob } from '../services/api'

// Descarga el ZIP de XML originales subidos, nombrado Tipo_RUC_nombre_mes_año
const descargarXmlsOriginales = async (cliente, clientId, tipo, modulo) => {
  try {
    const nom = (cliente?.nombre || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20)
    const nombre = `${tipo}_${cliente?.identificacion || ''}_${nom}_${String(cliente?.periodo_mes || '').padStart(2, '0')}_${cliente?.periodo_anio || ''}.zip`
    const res = await xmlOriginalesAPI.descargar(clientId, modulo)
    downloadBlob(res.data, nombre, 'application/zip')
  } catch (err) {
    if (err.response?.status === 404) alert('Aún no hay XML guardados para este período. Se guardan automáticamente al subir nuevos XML.')
    else alert('Error: ' + (err.response?.data?.detail || err.message))
  }
}
import { useClients } from '../context/ClientContext'
import { periodoLargo } from '../utils/periodo'
import BulkBar from '../components/BulkBar'
import ClientSwitcher from '../components/ClientSwitcher'
import ClaveHeader from '../components/ClaveHeader'
import './ICE.css'

import { fmtMoney as money } from '../utils/format'
const n4 = (v) => (parseFloat(v) || 0).toFixed(4)

export default function ICE() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient } = useClients()
  const navigate = useNavigate()
  const [anexo, setAnexo] = useState(null) // { actImport, xml, advertencias, ventas } | 'open'
  const [difOpen, setDifOpen] = useState(null) // producto cuya explicación está abierta

  const [idents_svc, setIdentsSvc] = useState(null)
  useEffect(() => {
    clientsAPI.byService('declaracion_ice')
      .then((r) => setIdentsSvc(new Set(r.data?.identificaciones || [])))
      .catch(() => setIdentsSvc(new Set()))
  }, [])

  const [rows, setRows] = useState([])
  const [report, setReport] = useState(null)
  const [anio, setAnio] = useState(String(selectedClient?.periodo_anio || 2026))
  const [years, setYears] = useState(['2026'])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const xmlInputRef = useRef(null)

  useEffect(() => { iceAPI.taxYears().then((r) => setYears(r.data.years || ['2026'])).catch(() => {}) }, [])

  const load = useCallback(async () => {
    if (!selectedClientId) { setRows([]); setReport(null); return }
    setLoading(true); setError('')
    try {
      const res = await iceAPI.list(selectedClientId)
      setRows(res.data?.data || [])
    } catch (err) {
      setError('Error al cargar ICE: ' + (err.response?.data?.detail || err.message))
    } finally { setLoading(false) }
  }, [selectedClientId])

  const loadReport = useCallback(async () => {
    if (!selectedClientId) { setReport(null); return }
    try {
      const res = await iceAPI.report(selectedClientId, anio)
      setReport(res.data)
    } catch { setReport(null) }
  }, [selectedClientId, anio])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadReport() }, [loadReport, rows])

  const handleUploadXml = async (files) => {
    if (!selectedClientId || !files.length) return
    setBusy(`Procesando ${files.length} factura(s) XML…`)
    try {
      const res = await iceAPI.processXml(selectedClientId, files)
      alert(`Líneas con ICE nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates} | Errores/sin ICE: ${res.data.errors}`)
      await load()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy(''); if (xmlInputRef.current) xmlInputRef.current.value = ''
    }
  }

  const handleDrag = (e) => {
    e.preventDefault(); e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true)
    else if (e.type === 'dragleave') setDragActive(false)
  }
  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setDragActive(false)
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.name.toLowerCase().endsWith('.xml'))
    if (!files.length) { alert('Arrastra facturas XML de venta de licor.'); return }
    handleUploadXml(files)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta línea?')) return
    try { await iceAPI.delete(id); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleClear = async () => {
    if (!window.confirm(`¿Eliminar TODOS los datos ICE de ${selectedClient?.nombre}?`)) return
    try { await iceAPI.clear(selectedClientId); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleExport = async () => {
    try {
      const res = await iceAPI.exportExcel(selectedClientId, anio)
      downloadBlob(res.data, `${selectedClient?.nombre || 'ICE'}_ICE_${anio}.xlsx`)
    } catch (err) { alert('Error Excel: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleExportPdf = async () => {
    try {
      const res = await iceAPI.exportPdf(selectedClientId, anio)
      downloadBlob(res.data, `${selectedClient?.nombre || 'ICE'}_ICE_${anio}.pdf`, 'application/pdf')
    } catch (err) { alert('Error PDF: ' + (err.response?.data?.detail || err.message)) }
  }
  const generarAnexo = async (actImport) => {
    try {
      const res = await iceAPI.anexo(selectedClientId, actImport)
      setAnexo({ actImport, ...res.data })
    } catch (err) { alert('Error anexo: ' + (err.response?.data?.detail || err.message)) }
  }
  const descargarAnexo = () => {
    if (!anexo?.xml) return
    const blob = new Blob([anexo.xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `Anexo_ICE_${selectedClient?.identificacion || ''}.xml`
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }
  const abrirCodigos = () => window.open('/recursos-ice', '_blank')

  // Agrupaciones para los cuadros (desde las líneas cargadas)
  const okRows = useMemo(() => rows.filter((r) => r.estado !== 'DUPLICADO'), [rows])
  const cuadroProducto = useMemo(() => {
    const ag = {}
    okRows.forEach((r) => {
      const k = (r.nombre_producto || '(sin nombre)').toUpperCase()
      const a = ag[k] || (ag[k] = { producto: k, cajas: 0, botellas: 0, base_ice: 0, valor_ice: 0, base_iva: 0, valor_iva: 0, total: 0 })
      a.cajas += parseFloat(r.cantidad_cajas) || 0
      a.botellas += parseInt(r.unidades_botellas) || 0
      a.base_ice += parseFloat(r.base_ice) || 0
      a.valor_ice += parseFloat(r.valor_ice) || 0
      a.base_iva += parseFloat(r.base_iva) || 0
      a.valor_iva += parseFloat(r.valor_iva) || 0
      a.total += parseFloat(r.importe_total) || 0
    })
    return Object.values(ag).sort((x, y) => x.producto.localeCompare(y.producto))
  }, [okRows])
  const cuadroCliente = useMemo(() => {
    const ag = {}
    okRows.forEach((r) => {
      const k = r.id_cliente || '(sin RUC)'
      const a = ag[k] || (ag[k] = { ruc: r.id_cliente || '', nombre: r.razon_social_cliente || '', botellas: 0, base_ice: 0, valor_ice: 0, valor_iva: 0, total: 0 })
      a.botellas += parseInt(r.unidades_botellas) || 0
      a.base_ice += parseFloat(r.base_ice) || 0
      a.valor_ice += parseFloat(r.valor_ice) || 0
      a.valor_iva += parseFloat(r.valor_iva) || 0
      a.total += parseFloat(r.importe_total) || 0
    })
    return Object.values(ag).sort((x, y) => (x.nombre || '').localeCompare(y.nombre || ''))
  }, [okRows])

  // Revisión / cuadre: compara los valores de la factura (XML) vs la auditoría (cálculo)
  const cuadre = useMemo(() => {
    const facturaIce = okRows.reduce((s, r) => s + (parseFloat(r.valor_ice) || 0), 0)
    const facturaIva = okRows.reduce((s, r) => s + (parseFloat(r.valor_iva) || 0), 0)
    const facturaSub = okRows.reduce((s, r) => s + (parseFloat(r.precio_total_sin_impuesto) || 0), 0)
    const facturaTotal = okRows.reduce((s, r) => s + (parseFloat(r.importe_total) || 0), 0)
    const g = report?.general || {}
    return [
      { concepto: 'Subtotal (sin impuestos)', factura: facturaSub, audit: g.subtotal || 0 },
      { concepto: 'ICE', factura: facturaIce, audit: g.total_ice || 0 },
      { concepto: 'IVA', factura: facturaIva, audit: g.iva || 0 },
      { concepto: 'Total (con impuestos)', factura: facturaTotal, audit: (g.base_iva || 0) + (g.iva || 0) },
    ].map((x) => ({ ...x, dif: x.factura - x.audit }))
  }, [okRows, report])

  // Diagnóstico de diferencias por producto (factura vs cálculo)
  const diferencias = useMemo(() => {
    if (!report?.por_producto) return []
    const fac = {}
    cuadroProducto.forEach((p) => { fac[p.producto] = p })
    const out = []
    report.por_producto.forEach((a) => {
      const f = fac[a.producto] || {}
      const facIce = parseFloat(f.valor_ice) || 0
      const audIce = parseFloat(a.total_ice) || 0
      const dif = facIce - audIce
      if (Math.abs(dif) > 0.01) {
        out.push({
          producto: a.producto, botellas: a.botellas, facIce, audIce, dif,
          iceEsp: a.ice_especifico, iceAdv: a.ice_advalorem, aplicaAdv: a.aplica_adv,
        })
      }
    })
    return out
  }, [report, cuadroProducto])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter((r) => [r.fecha, r.razon_social_cliente, r.nombre_producto, r.codigo_producto]
      .some((f) => String(f || '').toLowerCase().includes(q)))
  }, [rows, search])

  // selección múltiple
  const toggleSel = (id) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected((p) => {
    if (filtered.every((r) => p.has(r.id))) { const n = new Set(p); filtered.forEach((r) => n.delete(r.id)); return n }
    return new Set([...p, ...filtered.map((r) => r.id)])
  })
  const clearSel = () => setSelected(new Set())
  const bulkMove = async (clientId) => {
    const ids = [...selected]
    try {
      const res = await iceAPI.bulkMove(ids, clientId); clearSel(); await load()
      alert(`Movidas: ${res.data?.moved ?? ids.length}${res.data?.skipped ? ` · Omitidas: ${res.data.skipped}` : ''}`)
    } catch (e) { alert('Error al mover: ' + (e.response?.data?.detail || e.message)) }
  }
  const bulkDelete = async () => {
    const ids = [...selected]
    if (!window.confirm(`¿Eliminar ${ids.length} línea(s)?`)) return
    try { await iceAPI.bulkDelete(ids); clearSel(); await load() }
    catch (e) { alert('Error al eliminar: ' + (e.response?.data?.detail || e.message)) }
  }

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return (
      <div className="ice-page">
        <div className="ice-welcome">
          <h1>🥃 ICE - XML</h1>
          <p>Selecciona un cliente para auditar el ICE de sus ventas de licor desde sus facturas XML.</p>
          <button className="ice-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {(idents_svc ? clients.filter((c) => idents_svc.has(c.identificacion)) : clients).length > 0 && (
          <div className="ice-client-grid">
            {(idents_svc ? clients.filter((c) => idents_svc.has(c.identificacion)) : clients).map((c) => (
              <button key={c.id} className="ice-client-card" onClick={() => selectClient(c.id)}>
                <div className="icc-periodo">{periodoLargo(c)}</div>
                <div className="icc-id">{c.identificacion}</div>
                <div className="icc-name">{c.nombre}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const g = report?.general
  const p = report?.params

  return (
    <div className="ice-page">
      <header className="ice-header">
        <div>
          <h1>🥃 ICE - XML <span className="ice-periodo-tag">{periodoLargo(selectedClient)}</span></h1>
          <p className="ice-subhead"><strong className="sub-ruc">{selectedClient.identificacion}</strong> — {selectedClient.nombre}<ClaveHeader clientId={selectedClientId} /></p>
        </div>
        <div className="ice-year">
          <label>Año fiscal (tarifas)</label>
          <select value={anio} onChange={(e) => setAnio(e.target.value)}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          {p && <span className="ice-params">Esp: {p.esp} · Umbral: {p.umbral} · IVA: {Math.round(p.iva * 100)}%</span>}
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      {error && <div className="ice-error">⚠ {error}</div>}

      <div className="ice-stats">
        <div className="stat-card"><span className="num">{rows.length}</span><span className="lbl">Líneas</span></div>
        <div className="stat-card"><span className="num">{money(g?.subtotal)}</span><span className="lbl">Subtotal</span></div>
        <div className="stat-card"><span className="num">{money(g?.ice_especifico)}</span><span className="lbl">ICE Específico</span></div>
        <div className="stat-card"><span className="num">{money(g?.ice_advalorem)}</span><span className="lbl">ICE Ad-Valorem</span></div>
        <div className="stat-card total"><span className="num">{money(g?.total_ice)}</span><span className="lbl">Total ICE</span></div>
      </div>

      <div className={`ice-dropzone ${dragActive ? 'active' : ''}`}
        onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}
        onClick={() => xmlInputRef.current?.click()}>
        <span className="dz-icon">🥃</span>
        <span className="dz-text">Arrastra aquí las facturas XML de venta de licor</span>
        <span className="dz-sub">o haz clic para seleccionarlas — solo se toman las líneas con ICE</span>
      </div>

      <div className="ice-controls">
        <input ref={xmlInputRef} type="file" accept=".xml" multiple style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) handleUploadXml(Array.from(e.target.files)) }} />
        <button className="ice-btn primary" onClick={() => xmlInputRef.current?.click()}>📂 Cargar XMLs</button>
        <button className="ice-btn small" onClick={handleExport}>⬇ Excel</button>
        <button className="ice-btn small" onClick={handleExportPdf}>⬇ PDF</button>
        <button className="ice-btn small" onClick={() => descargarXmlsOriginales(selectedClient, selectedClientId, 'IngresosICE', 'ingreso_ice')} title="Descargar los XML originales subidos">⬇ XML originales</button>
        <button className="ice-btn anexo" onClick={() => setAnexo('open')}>📄 Generar Anexo ICE</button>
        <button className="ice-btn small" onClick={() => navigate('/calculo-ice')}>🧮 Ir a Cálculo ICE</button>
        <button className="ice-btn small" onClick={abrirCodigos}>📊 Abrir Códigos ICE</button>
        <button className="ice-btn small danger" onClick={handleClear}>🗑 Limpiar</button>
        <input className="ice-search" placeholder="🔍 Cliente, producto, código…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {busy && <div className="ice-busy">⏳ {busy}</div>}

      {loading ? (
        <div className="ice-empty">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="ice-empty">Sin datos. Carga facturas XML de venta de licor para comenzar.</div>
      ) : (
        <div className="ice-table-wrap">
          <div className="ice-hint">{filtered.length} de {rows.length}</div>
          <BulkBar count={selected.size} onMove={bulkMove} onDelete={bulkDelete} onClear={clearSel} />
          <div className="ice-scroll">
            <table className="ice-table">
              <thead>
                <tr>
                  <th className="sel-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th>Fecha</th><th>Cliente</th><th>Producto</th><th>Pack</th>
                  <th className="r">Cajas</th><th className="r">Botellas</th>
                  <th className="r">$/Caja</th><th className="r">$/Bot.</th>
                  <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">Total</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className={selected.has(r.id) ? 'row-sel' : ''}>
                    <td className="sel-col"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} /></td>
                    <td>{r.fecha || '-'}</td>
                    <td className="ice-cli" title={r.razon_social_cliente}>{r.razon_social_cliente || '-'}</td>
                    <td className="ice-prod" title={r.nombre_producto}>{r.nombre_producto || '-'}</td>
                    <td>{r.es_pack ? 'SÍ' : 'NO'}</td>
                    <td className="r">{(parseFloat(r.cantidad_cajas) || 0).toFixed(0)}</td>
                    <td className="r">{r.unidades_botellas}</td>
                    <td className="r">{money(r.precio_por_caja)}</td>
                    <td className="r">{n4(r.precio_por_botella)}</td>
                    <td className="r">{money(r.base_ice)}</td>
                    <td className="r">{money(r.valor_ice)}</td>
                    <td className="r total">{money(r.importe_total)}</td>
                    <td><button className="ice-del" onClick={() => handleDelete(r.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ice-foot">
                  <td></td><td></td><td></td><td></td><td>TOTALES</td>
                  <td className="r">{filtered.reduce((s, r) => s + (parseFloat(r.cantidad_cajas) || 0), 0).toFixed(0)}</td>
                  <td className="r">{filtered.reduce((s, r) => s + (parseInt(r.unidades_botellas) || 0), 0)}</td>
                  <td className="r"></td><td className="r"></td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.base_ice) || 0), 0))}</td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.valor_ice) || 0), 0))}</td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.importe_total) || 0), 0))}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {report?.por_producto?.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">📊 Reporte general — auditoría por producto ({anio})</h2>
          <div className="ice-scroll">
            <table className="ice-rep-table">
              <thead>
                <tr>
                  <th>Producto</th><th className="r">Botellas</th><th className="r">Subtotal</th>
                  <th className="r">ICE Específico</th><th className="r">ICE Ad-Valorem</th><th className="r">Total ICE</th>
                  <th className="r">Base IVA</th><th className="r">IVA</th><th>AdV</th>
                </tr>
              </thead>
              <tbody>
                {report.por_producto.map((f) => (
                  <tr key={f.producto}>
                    <td className="ice-prod" title={f.producto}>{f.producto}</td>
                    <td className="r">{(parseFloat(f.botellas) || 0).toFixed(0)}</td>
                    <td className="r">{money(f.subtotal)}</td>
                    <td className="r">{money(f.ice_especifico)}</td>
                    <td className="r">{money(f.ice_advalorem)}</td>
                    <td className="r strong">{money(f.total_ice)}</td>
                    <td className="r">{money(f.base_iva)}</td>
                    <td className="r">{money(f.iva)}</td>
                    <td>{f.aplica_adv ? 'SÍ' : 'NO'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ice-rep-total">
                  <td>TOTAL · {g?.lineas} línea(s)</td>
                  <td className="r"></td>
                  <td className="r">{money(g?.subtotal)}</td>
                  <td className="r">{money(g?.ice_especifico)}</td>
                  <td className="r">{money(g?.ice_advalorem)}</td>
                  <td className="r">{money(g?.total_ice)}</td>
                  <td className="r">{money(g?.base_iva)}</td>
                  <td className="r">{money(g?.iva)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Cuadro por producto */}
      {cuadroProducto.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">📦 Cuadro por producto — {selectedClient.identificacion} · {selectedClient.nombre}</h2>
          <div className="ice-scroll">
            <table className="ice-rep-table">
              <thead><tr>
                <th>Producto</th><th className="r">Cajas</th><th className="r">Botellas</th>
                <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">Base IVA</th><th className="r">IVA</th><th className="r">Total</th>
              </tr></thead>
              <tbody>
                {cuadroProducto.map((p) => (
                  <tr key={p.producto}>
                    <td className="ice-prod" title={p.producto}>{p.producto}</td>
                    <td className="r">{p.cajas.toFixed(0)}</td>
                    <td className="r">{p.botellas}</td>
                    <td className="r">{money(p.base_ice)}</td>
                    <td className="r strong">{money(p.valor_ice)}</td>
                    <td className="r">{money(p.base_iva)}</td>
                    <td className="r">{money(p.valor_iva)}</td>
                    <td className="r">{money(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cuadro por cliente */}
      {cuadroCliente.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">👥 Cuadro por cliente (genera el anexo SRI)</h2>
          <div className="ice-scroll">
            <table className="ice-rep-table">
              <thead><tr>
                <th>RUC</th><th>Cliente</th><th className="r">Botellas</th>
                <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">IVA</th><th className="r">Total</th>
              </tr></thead>
              <tbody>
                {cuadroCliente.map((c) => (
                  <tr key={c.ruc + c.nombre}>
                    <td>{c.ruc || '—'}</td>
                    <td className="ice-prod" title={c.nombre}>{c.nombre || '—'}</td>
                    <td className="r">{c.botellas}</td>
                    <td className="r">{money(c.base_ice)}</td>
                    <td className="r strong">{money(c.valor_ice)}</td>
                    <td className="r">{money(c.valor_iva)}</td>
                    <td className="r">{money(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Cuadro de verificación: recálculo de ICE por línea */}
      {report?.detalle?.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">✅ Verificación del cálculo ICE por producto ({anio})</h2>
          <p className="ice-verif-note">ICE Específico = Litros de alcohol puro × Tarifa · ICE Ad-Valorem = (Precio/Litro − Umbral {money(report.params?.umbral)}) × 75% × Litros, si Precio/Litro &gt; Umbral.</p>
          <div className="ice-scroll">
            <table className="ice-rep-table">
              <thead><tr>
                <th>Producto</th><th className="r">Botellas</th><th className="r">Vol. (cc)</th><th className="r">Grado %</th>
                <th className="r">Litros Alcohol</th><th className="r">Tarifa</th><th className="r">ICE Esp.</th>
                <th className="r">Precio/Litro</th><th>¿AdV?</th><th className="r">ICE AdV</th><th className="r">Total ICE</th>
              </tr></thead>
              <tbody>
                {report.detalle.map((d, i) => {
                  const litrosAlc = (parseFloat(d.botellas) || 0) * (parseFloat(d.volumen) || 0) / 1000 * (parseFloat(d.grado) || 0) / 100
                  return (
                    <tr key={i}>
                      <td className="ice-prod" title={d.producto_individual}>{d.producto_individual}</td>
                      <td className="r">{(parseFloat(d.botellas) || 0).toFixed(0)}</td>
                      <td className="r">{(parseFloat(d.volumen) || 0).toFixed(0)}</td>
                      <td className="r">{(parseFloat(d.grado) || 0).toFixed(1)}</td>
                      <td className="r">{litrosAlc.toFixed(4)}</td>
                      <td className="r">{report.params?.esp}</td>
                      <td className="r strong">{money(d.ice_especifico)}</td>
                      <td className="r">{(parseFloat(d.precio_litro) || 0).toFixed(4)}</td>
                      <td>{d.aplica_adv ? 'SÍ' : 'NO'}</td>
                      <td className="r">{money(d.ice_advalorem)}</td>
                      <td className="r">{money(d.total_ice)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Revisión / cuadre: factura vs auditoría */}
      {report?.general && rows.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">🔎 Revisión de valores (factura vs cálculo)</h2>
          <div className="ice-scroll">
            <table className="ice-rep-table">
              <thead><tr>
                <th>Concepto</th><th className="r">Según factura (XML)</th><th className="r">Según cálculo (auditoría)</th><th className="r">Diferencia</th>
              </tr></thead>
              <tbody>
                {cuadre.map((x) => (
                  <tr key={x.concepto} className={Math.abs(x.dif) > 0.01 ? 'ice-dif' : ''}>
                    <td>{x.concepto}</td>
                    <td className="r">{money(x.factura)}</td>
                    <td className="r">{money(x.audit)}</td>
                    <td className="r strong">{money(x.dif)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="ice-verif-note">Las filas resaltadas tienen diferencia entre lo facturado y lo calculado. Una diferencia en ICE puede indicar tarifas o grados mal cargados.</p>
        </div>
      )}

      {/* Análisis de diferencias (solo si las hay) — tabla con explicación al hacer clic */}
      {diferencias.length > 0 && (
        <div className="ice-report">
          <h2 className="ice-report-title">🧠 Análisis de diferencias (factura vs cálculo)</h2>
          <p className="ice-verif-note">{diferencias.length} producto(s) con diferencia. Haz clic en una fila para ver la explicación.</p>
          <div className="ice-scroll">
            <table className="ice-rep-table ice-dif-table">
              <thead><tr>
                <th>Producto</th><th className="r">ICE facturado</th><th className="r">ICE calculado</th>
                <th className="r">Diferencia</th><th></th>
              </tr></thead>
              <tbody>
                {diferencias.map((d) => {
                  const mas = d.dif > 0
                  const abierto = difOpen === d.producto
                  return (
                    <Fragment key={d.producto}>
                      <tr className="ice-dif-row" onClick={() => setDifOpen(abierto ? null : d.producto)}>
                        <td className="ice-prod" title={d.producto}>{d.producto}</td>
                        <td className="r">{money(d.facIce)}</td>
                        <td className="r">{money(d.audIce)}</td>
                        <td className={`r strong ${mas ? 'dif-mas' : 'dif-menos'}`}>{money(d.dif)}</td>
                        <td className="r ice-dif-caret">{abierto ? '▾' : '▸'}</td>
                      </tr>
                      {abierto && (
                        <tr className="ice-dif-detail">
                          <td colSpan={5}>
                            <div className="ice-dif-nums">
                              <span>ICE facturado (XML): <b>{money(d.facIce)}</b></span>
                              <span>ICE calculado: <b>{money(d.audIce)}</b> = Específico {money(d.iceEsp)} + Ad-Valorem {money(d.iceAdv)}</span>
                              <span>Botellas: <b>{(parseFloat(d.botellas) || 0).toFixed(0)}</b></span>
                              <span className={`ice-dif-tag ${mas ? 'mas' : 'menos'}`}>{mas ? 'Facturado de MÁS' : 'Facturado de MENOS'} {money(Math.abs(d.dif))}</span>
                            </div>
                            <p className="ice-dif-text">
                              El comprobante registra <b>{money(d.facIce)}</b> de ICE, pero el cálculo según la ley arroja <b>{money(d.audIce)}</b>
                              {' '}(específico {money(d.iceEsp)}{d.aplicaAdv ? ` + ad-valorem ${money(d.iceAdv)}` : ', sin ad-valorem porque el precio/litro no supera el umbral'}),
                              una diferencia de <b>{money(Math.abs(d.dif))}</b> {mas ? 'a favor de lo facturado' : 'que faltaría facturar'}.
                              {' '}Causas probables: (1) el <b>grado alcohólico</b> o la <b>capacidad</b> del producto no coinciden con los reales
                              {' '}(si el producto no se reconoció, se usan 15% y 750 ml por defecto); (2) la <b>tarifa del año</b> o el <b>umbral ad-valorem</b> aplicados; (3) redondeos.
                              {' '}Verifica el grado, la capacidad y el código en el <b>Catálogo de productos</b> de este cliente.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal Anexo ICE */}
      {anexo && (
        <div className="ice-modal-bg" onClick={() => setAnexo(null)}>
          <div className="ice-modal" onClick={(e) => e.stopPropagation()}>
            <h2>📄 Generar Anexo ICE (SRI)</h2>
            <div className="ice-modal-row">
              <label>Actividad (actImport)</label>
              <select
                defaultValue={typeof anexo === 'object' ? anexo.actImport : '02'}
                onChange={(e) => generarAnexo(e.target.value)}
              >
                <option value="01">01 - Fabricante Nacional</option>
                <option value="02">02 - Distribuidor</option>
                <option value="03">03 - Importador</option>
              </select>
              <button className="ice-btn primary" onClick={() => generarAnexo(typeof anexo === 'object' ? anexo.actImport : '02')}>Generar</button>
            </div>

            {typeof anexo === 'object' && (
              <>
                {anexo.advertencias?.length > 0 && (
                  <div className="ice-modal-warn">
                    ⚠ {anexo.advertencias.join(' ')}<br />
                    Corrige los códigos en "Códigos ICE" o el catálogo antes de subir al SRI.
                  </div>
                )}
                <div className="ice-modal-ok">{anexo.ventas} venta(s) agrupadas.</div>
                <pre className="ice-modal-xml">{anexo.xml}</pre>
                <div className="ice-modal-actions">
                  <button className="ice-btn primary" onClick={descargarAnexo}>💾 Descargar XML</button>
                  <button className="ice-btn small" onClick={() => setAnexo(null)}>Cerrar</button>
                </div>
              </>
            )}
            {anexo === 'open' && (
              <div className="ice-modal-actions">
                <button className="ice-btn small" onClick={() => setAnexo(null)}>Cancelar</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
