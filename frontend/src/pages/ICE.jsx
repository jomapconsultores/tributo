import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { iceAPI, xmlOriginalesAPI, downloadBlob } from '../services/api'

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
import ClientPickerScreen from '../components/ClientPickerScreen'
import ClaveHeader from '../components/ClaveHeader'
import WorkflowGuide from '../components/WorkflowGuide'
import './ICE.css'

import { fmtMoney as money } from '../utils/format'
const n4 = (v) => (parseFloat(v) || 0).toFixed(4)

// 'CORP' es una variante del MISMO producto; se quita para agrupar junto.
const sinCorp = (s) => (s || '').toUpperCase().replace(/\s*\bCORP\b\.?/g, ' ').replace(/\s+/g, ' ').trim()

// Coincidencia de texto para filtrar un cuadro por cualquiera de sus campos.
const incluye = (q, ...vals) => {
  const s = (q || '').toLowerCase().trim()
  return !s || vals.some((v) => String(v ?? '').toLowerCase().includes(s))
}

// Verifica el cuadre de botellas de una línea: unidades vs (cajas × bot/caja).
const chequearBotellas = (r) => {
  const u = parseInt(r.unidades_botellas) || 0
  const cajas = parseFloat(r.cantidad_cajas) || 0
  const bxc = parseFloat(r.botellas_por_caja) || 0
  const esperado = Math.round(cajas * bxc)
  const dif = u - esperado
  return { u, cajas, bxc, esperado, dif, verificable: bxc > 0 && cajas > 0, ok: !(bxc > 0 && cajas > 0) || Math.abs(dif) < 1 }
}

// Cuadro con filtro propio: filtra `data` por `fields` y entrega el subconjunto
// a `children` (que arma la tabla con sus sumatorias sobre lo filtrado).
function CuadroFiltrable({ title, hint, data, fields, value, onFilter, children }) {
  const q = value || ''
  const filt = q.trim() ? data.filter((d) => incluye(q, ...fields.map((f) => d[f]))) : data
  return (
    <div className="ice-report">
      <h2 className="ice-report-title">
        <span className="ice-rep-h">{title}</span>
        <input className="ice-cuadro-fil" placeholder="🔍 filtrar este cuadro…" value={q} onChange={(e) => onFilter(e.target.value)} />
        <span className="ice-cuadro-count">{filt.length}/{data.length}</span>
      </h2>
      {hint}
      <div className="ice-scroll">{children(filt)}</div>
    </div>
  )
}

const ICE_STEPS = [
  { icon: '📚', label: 'Catálogo Productos', path: '/catalogo-productos' },
  { icon: '🧮', label: 'Cálculo previo ICE', path: '/calculo-ice' },
  { icon: '🥃', label: 'Ingresos ICE XML', current: true },
  { icon: '📄', label: 'Declaraciones ICE', path: '/declaracion-ice' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

export default function ICE() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient, identsForSvc } = useClients()
  const idents_svc = identsForSvc('declaracion_ice')
  const navigate = useNavigate()
  const [anexo, setAnexo] = useState(null) // { actImport, xml, advertencias, ventas } | 'open'
  const [difOpen, setDifOpen] = useState(null) // producto cuya explicación está abierta

  const [rows, setRows] = useState([])
  const [report, setReport] = useState(null)
  const [anio, setAnio] = useState(String(selectedClient?.periodo_anio || 2026))
  const [years, setYears] = useState(['2026'])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filtros, setFiltros] = useState({}) // filtro por cada cuadro
  const setFiltro = (k, v) => setFiltros((p) => ({ ...p, [k]: v }))
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
  // Líneas con descuadre de botellas (unidades ≠ cajas × bot/caja)
  const botellasMal = useMemo(() => okRows.filter((r) => !chequearBotellas(r).ok), [okRows])
  const totalBotellas = useMemo(() => okRows.reduce((s, r) => s + (parseInt(r.unidades_botellas) || 0), 0), [okRows])
  const cuadroProducto = useMemo(() => {
    const ag = {}
    okRows.forEach((r) => {
      const k = sinCorp(r.nombre_producto) || '(SIN NOMBRE)'
      const a = ag[k] || (ag[k] = { producto: k, cajas: 0, botellas: 0, base_ice: 0, valor_ice: 0, base_iva: 0, valor_iva: 0, total: 0 })
      a.cajas += parseFloat(r.cantidad_cajas) || 0
      a.botellas += parseInt(r.unidades_botellas) || 0
      a.base_ice += parseFloat(r.base_ice) || 0
      a.valor_ice += parseFloat(r.valor_ice) || 0
      a.base_iva += parseFloat(r.base_iva) || 0
      a.valor_iva += parseFloat(r.valor_iva) || 0
      // Total con impuestos por línea = base IVA + IVA (NO importe_total, que es el total de la factura repetido)
      a.total += (parseFloat(r.base_iva) || 0) + (parseFloat(r.valor_iva) || 0)
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
      a.total += (parseFloat(r.base_iva) || 0) + (parseFloat(r.valor_iva) || 0)
    })
    return Object.values(ag).sort((x, y) => (x.nombre || '').localeCompare(y.nombre || ''))
  }, [okRows])

  // CUADRO 1: reporte por FACTURA (totales globales). El importe_total es el total de
  // la factura (repetido en cada línea); ICE/IVA/subtotal se suman de las líneas.
  const cuadroFactura = useMemo(() => {
    const ag = {}
    okRows.forEach((r) => {
      const clave = String(r.unique_id || '').replace(/-\d+$/, '') || `${r.fecha}|${r.id_cliente}`
      const a = ag[clave] || (ag[clave] = { clave, fecha: r.fecha || '', ruc: r.id_cliente || '', cliente: r.razon_social_cliente || '', lineas: 0, botellas: 0, subtotal: 0, ice: 0, iva: 0, total: 0 })
      a.lineas += 1
      a.botellas += parseInt(r.unidades_botellas) || 0
      a.subtotal += parseFloat(r.precio_total_sin_impuesto) || 0
      a.ice += parseFloat(r.valor_ice) || 0
      a.iva += parseFloat(r.valor_iva) || 0
      a.total = parseFloat(r.importe_total) || a.total // total de la factura (no se suma)
    })
    return Object.values(ag).sort((x, y) => (x.fecha || '').localeCompare(y.fecha || ''))
  }, [okRows])

  // CUADRO por BOTELLA: auditoría por producto con valores UNITARIOS por botella
  // (grado alcohólico y ml son vitales para el cálculo).
  const auditBotella = useMemo(() => {
    if (!report?.detalle) return []
    const ag = {}
    report.detalle.forEach((d) => {
      const k = d.producto_individual
      const a = ag[k] || (ag[k] = { producto: k, grado: d.grado, volumen: d.volumen, precio_botella: d.precio_botella, botellas: 0, ice_esp: 0, ice_adv: 0, total: 0, aplica_adv: false })
      a.botellas += parseFloat(d.botellas) || 0
      a.ice_esp += parseFloat(d.ice_especifico) || 0
      a.ice_adv += parseFloat(d.ice_advalorem) || 0
      a.total += parseFloat(d.total_ice) || 0
      a.aplica_adv = a.aplica_adv || d.aplica_adv
    })
    return Object.values(ag).map((a) => ({
      ...a,
      ice_esp_bot: a.botellas ? a.ice_esp / a.botellas : 0,
      ice_adv_bot: a.botellas ? a.ice_adv / a.botellas : 0,
      total_bot: a.botellas ? a.total / a.botellas : 0,
    })).sort((x, y) => x.producto.localeCompare(y.producto))
  }, [report])

  // Revisión / cuadre: compara los valores de la factura (XML) vs la auditoría (cálculo)
  const cuadre = useMemo(() => {
    const facturaIce = okRows.reduce((s, r) => s + (parseFloat(r.valor_ice) || 0), 0)
    const facturaIva = okRows.reduce((s, r) => s + (parseFloat(r.valor_iva) || 0), 0)
    const facturaSub = okRows.reduce((s, r) => s + (parseFloat(r.precio_total_sin_impuesto) || 0), 0)
    // Total de las líneas de licor (subtotal + ICE + IVA). NO importe_total, que es el total
    // COMPLETO de la factura (incluye productos no-ICE) y no es comparable con la auditoría ICE.
    const facturaTotal = okRows.reduce((s, r) => s + (parseFloat(r.base_iva) || 0) + (parseFloat(r.valor_iva) || 0), 0)
    const g = report?.general || {}
    return [
      { concepto: 'Subtotal (sin impuestos)', factura: facturaSub, audit: g.subtotal || 0 },
      { concepto: 'ICE', factura: facturaIce, audit: g.total_ice || 0 },
      { concepto: 'IVA', factura: facturaIva, audit: g.iva || 0 },
      { concepto: 'Total (con impuestos)', factura: facturaTotal, audit: (g.base_iva || 0) + (g.iva || 0) },
    ].map((x) => ({ ...x, dif: x.factura - x.audit }))
  }, [okRows, report])

  // Diagnóstico de diferencias por producto (factura vs cálculo). Se compara con la MISMA
  // llave: facturado por nombre de línea vs auditoría reagrupada por su producto ORIGINAL
  // (así los packs se comparan contra su línea facturada y no contra sus componentes).
  const diferencias = useMemo(() => {
    if (!report?.detalle) return []
    const fac = {}
    cuadroProducto.forEach((p) => { fac[p.producto] = p })
    const aud = {}
    report.detalle.forEach((d) => {
      const k = sinCorp(d.producto_original || '')
      const a = aud[k] || (aud[k] = { producto: k, botellas: 0, total_ice: 0, ice_especifico: 0, ice_advalorem: 0, aplica_adv: false })
      a.botellas += parseFloat(d.botellas) || 0
      a.total_ice += parseFloat(d.total_ice) || 0
      a.ice_especifico += parseFloat(d.ice_especifico) || 0
      a.ice_advalorem += parseFloat(d.ice_advalorem) || 0
      a.aplica_adv = a.aplica_adv || d.aplica_adv
    })
    const out = []
    Object.values(aud).forEach((a) => {
      const f = fac[a.producto] || {}
      const facIce = parseFloat(f.valor_ice) || 0
      const audIce = a.total_ice
      const dif = facIce - audIce
      if (Math.abs(dif) > 0.01) {
        out.push({
          producto: a.producto, botellas: a.botellas, facIce, audIce, dif,
          iceEsp: a.ice_especifico, iceAdv: a.ice_advalorem, aplicaAdv: a.aplica_adv,
        })
      }
    })
    return out.sort((x, y) => Math.abs(y.dif) - Math.abs(x.dif))
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
    return <ClientPickerScreen icon="🥃" title="ICE — XML" subtitle="Auditoría ICE sobre facturas XML de ventas de licor" idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Declaración ICE" />
  }

  const g = report?.general
  const p = report?.params
  const cb = report?.cuadre_botellas

  return (
    <div className="ice-page">
      <WorkflowGuide steps={ICE_STEPS} />
      <header className="ice-header">
        <div>
          <h1>🥃 Ingresos ICE - XML <span className="ice-periodo-tag">{periodoLargo(selectedClient)}</span></h1>
          <p className="ice-subhead"><strong className="sub-ruc">{selectedClient.identificacion}</strong> — {selectedClient.nombre}<ClaveHeader clientId={selectedClientId} /></p>
        </div>
        <div className="ice-year">
          <button className="continuar-btn" onClick={() => navigate('/declaracion-ice')}>Continuar con {selectedClient.nombre} → Declaración ICE</button>
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
        <button className="ice-btn small" onClick={() => navigate('/calculo-ice')}>🧮 Ir a Cálculo previo ICE</button>
        <button className="ice-btn small" onClick={abrirCodigos}>📊 Abrir Códigos ICE</button>
        <button className="ice-btn small danger" onClick={handleClear}>🗑 Limpiar</button>
        <input className="ice-search" placeholder="🔍 Cliente, producto, código…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {busy && <div className="ice-busy">⏳ {busy}</div>}

      {/* CUADRO 1 — Reporte por factura (totales globales) */}
      {!loading && cuadroFactura.length > 0 && (
        <CuadroFiltrable title="🧾 Reporte por factura (totales globales)" data={cuadroFactura}
          fields={['fecha', 'ruc', 'cliente']} value={filtros.factura} onFilter={(v) => setFiltro('factura', v)}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead><tr>
                <th>Fecha</th><th>RUC</th><th>Cliente</th><th className="r">Líneas</th><th className="r">Botellas</th>
                <th className="r">Subtotal</th><th className="r">ICE</th><th className="r">IVA</th><th className="r">Total factura</th>
              </tr></thead>
              <tbody>
                {filt.map((f) => (
                  <tr key={f.clave}>
                    <td>{f.fecha || '—'}</td>
                    <td>{f.ruc || '—'}</td>
                    <td className="ice-prod" title={f.cliente}>{f.cliente || '—'}</td>
                    <td className="r">{f.lineas}</td>
                    <td className="r">{f.botellas}</td>
                    <td className="r">{money(f.subtotal)}</td>
                    <td className="r">{money(f.ice)}</td>
                    <td className="r">{money(f.iva)}</td>
                    <td className="r strong total">{money(f.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="ice-rep-total">
                  <td>TOTALES</td><td></td><td></td>
                  <td className="r">{filt.reduce((s, f) => s + f.lineas, 0)}</td>
                  <td className="r">{filt.reduce((s, f) => s + f.botellas, 0)}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + f.subtotal, 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + f.ice, 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + f.iva, 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + f.total, 0))}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </CuadroFiltrable>
      )}

      {loading ? (
        <div className="ice-empty">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="ice-empty">Sin datos. Carga facturas XML de venta de licor para comenzar.</div>
      ) : (
        <div className="ice-table-wrap">
          <h2 className="ice-report-title">🧮 Desglose de productos - factura</h2>
          <div className="ice-hint">{filtered.length} de {rows.length}</div>
          {botellasMal.length > 0 ? (
            <div className="ice-bot-warn">⚠ {botellasMal.length} línea(s) con DESCUADRE de botellas (unidades ≠ cajas × bot/caja). Revisa las filas resaltadas en rojo y la columna “Bot/Caja”.</div>
          ) : (
            <div className="ice-bot-ok">✔ Botellas verificadas: <b>{totalBotellas.toLocaleString('es-EC')}</b> botellas en total; unidades = cajas × bot/caja en todas las líneas.</div>
          )}
          <BulkBar count={selected.size} onMove={bulkMove} onDelete={bulkDelete} onClear={clearSel} />
          <div className="ice-scroll">
            <table className="ice-table">
              <thead>
                <tr>
                  <th className="sel-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                  <th>Fecha</th><th>Cliente</th><th>Producto</th><th>Pack</th>
                  <th className="r">Cajas</th><th className="r">Botellas</th>
                  <th className="r" title="Botellas por caja — verificación: unidades = cajas × bot/caja">Bot/Caja</th>
                  <th className="r">$/Caja</th><th className="r">$/Bot.</th>
                  <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">Total</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const bc = chequearBotellas(r)
                  return (
                  <tr key={r.id} className={`${selected.has(r.id) ? 'row-sel' : ''} ${!bc.ok ? 'ice-row-bot-mal' : ''}`}>
                    <td className="sel-col"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} /></td>
                    <td>{r.fecha || '-'}</td>
                    <td className="ice-cli" title={r.razon_social_cliente}>{r.razon_social_cliente || '-'}</td>
                    <td className="ice-prod" title={r.nombre_producto}>{r.nombre_producto || '-'}</td>
                    <td>{r.es_pack ? 'SÍ' : 'NO'}</td>
                    <td className="r">{(parseFloat(r.cantidad_cajas) || 0).toFixed(0)}</td>
                    <td className={`r ${!bc.ok ? 'ice-bot-mal' : ''}`} title={!bc.ok ? `Esperado ${bc.esperado} (${bc.cajas}×${bc.bxc}); difiere en ${bc.dif > 0 ? '+' : ''}${bc.dif}` : ''}>{r.unidades_botellas}</td>
                    <td className={`r ${!bc.ok ? 'ice-bot-mal' : ''}`} title={bc.verificable ? `Esperado: ${bc.cajas} cajas × ${bc.bxc} = ${bc.esperado} botellas` : 'Sin bot/caja para verificar'}>
                      {bc.bxc ? bc.bxc.toFixed(0) : '—'}{!bc.ok ? ` ⚠ (${bc.dif > 0 ? '+' : ''}${bc.dif})` : ''}
                    </td>
                    <td className="r">{money(r.precio_por_caja)}</td>
                    <td className="r">{n4(r.precio_por_botella)}</td>
                    <td className="r">{money(r.base_ice)}</td>
                    <td className="r">{money(r.valor_ice)}</td>
                    <td className="r total">{money((parseFloat(r.base_iva) || 0) + (parseFloat(r.valor_iva) || 0))}</td>
                    <td><button className="ice-del" onClick={() => handleDelete(r.id)}>✕</button></td>
                  </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="ice-foot">
                  <td></td><td></td><td></td><td></td><td>TOTALES</td>
                  <td className="r">{filtered.reduce((s, r) => s + (parseFloat(r.cantidad_cajas) || 0), 0).toFixed(0)}</td>
                  <td className="r">{filtered.reduce((s, r) => s + (parseInt(r.unidades_botellas) || 0), 0)}</td>
                  <td className="r" title="Botellas esperadas: Σ(cajas × bot/caja)">{filtered.reduce((s, r) => s + Math.round((parseFloat(r.cantidad_cajas) || 0) * (parseFloat(r.botellas_por_caja) || 0)), 0)}</td>
                  <td className="r"></td><td className="r"></td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.base_ice) || 0), 0))}</td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.valor_ice) || 0), 0))}</td>
                  <td className="r">{money(filtered.reduce((s, r) => s + (parseFloat(r.base_iva) || 0) + (parseFloat(r.valor_iva) || 0), 0))}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Cuadre de botellas: desglose vs contabilizado para ICE (descompone packs) */}
      {cb && (
        <div className="ice-report">
          <h2 className="ice-report-title"><span className="ice-rep-h">🍾 Cuadre de botellas — vendidas vs contabilizadas para ICE</span></h2>
          <div className={`ice-cuadre-bot ${cb.ok ? 'ok' : 'mal'}`}>
            <div className="cb-card"><span className="cb-lbl">Botellas en el desglose</span><span className="cb-num">{(cb.desglose_total || 0).toLocaleString('es-EC')}</span></div>
            <div className="cb-card"><span className="cb-lbl">Botellas contabilizadas para ICE</span><span className="cb-num">{(cb.audit_total || 0).toLocaleString('es-EC')}</span></div>
            <div className="cb-card dif"><span className="cb-lbl">Diferencia</span><span className="cb-num">{cb.diferencia > 0 ? '+' : ''}{cb.diferencia}</span></div>
          </div>
          {cb.ok ? (
            <p className="ice-bot-ok">✔ Coinciden exactamente: las <b>{(cb.audit_total || 0).toLocaleString('es-EC')}</b> botellas vendidas (incluidas las de packs) están contabilizadas para el ICE.</p>
          ) : (
            <p className="ice-bot-warn">⚠ DIFERENCIA de <b>{Math.abs(cb.diferencia)}</b> botella(s) entre el desglose y lo contabilizado para ICE. Alguna botella (probablemente dentro de un pack) podría no estar pagando ICE. Revisa los packs resaltados.</p>
          )}
          {cb.packs.length > 0 && (
            <div className="ice-scroll">
              <table className="ice-rep-table">
                <thead><tr>
                  <th>Pack</th><th className="r">Cajas</th><th className="r">Bot/pack</th>
                  <th className="r">Unidades (XML)</th><th className="r">Botellas ICE (descompuesto)</th><th className="r">Dif</th>
                </tr></thead>
                <tbody>
                  {cb.packs.map((pk, i) => (
                    <tr key={i} className={Math.abs(pk.dif) > 0.5 ? 'ice-row-bot-mal' : ''}>
                      <td className="ice-prod" title={pk.nombre}>{pk.nombre}</td>
                      <td className="r">{pk.cajas}</td>
                      <td className="r">{pk.botellas_pack}</td>
                      <td className="r">{pk.unidades}</td>
                      <td className="r">{pk.descompuesto}</td>
                      <td className={`r strong ${Math.abs(pk.dif) > 0.5 ? 'ice-bot-mal' : ''}`}>{pk.dif > 0 ? '+' : ''}{pk.dif}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="ice-rep-total">
                  <td>TOTALES PACKS · {cb.packs.length}</td>
                  <td className="r">{cb.packs.reduce((s, pk) => s + (pk.cajas || 0), 0)}</td>
                  <td className="r"></td>
                  <td className="r">{cb.packs.reduce((s, pk) => s + (pk.unidades || 0), 0)}</td>
                  <td className="r">{cb.packs.reduce((s, pk) => s + (pk.descompuesto || 0), 0)}</td>
                  <td className="r">{cb.packs.reduce((s, pk) => s + (pk.dif || 0), 0)}</td>
                </tr></tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Reporte general — auditoría por producto POR BOTELLA (unitario, con grado y ml) */}
      {auditBotella.length > 0 && (
        <CuadroFiltrable title={`🍾 Reporte general — auditoría por producto (por botella) (${anio})`} data={auditBotella}
          fields={['producto']} value={filtros.botella} onFilter={(v) => setFiltro('botella', v)}
          hint={<p className="ice-verif-note">Valores UNITARIOS por botella. El grado alcohólico (%) y la capacidad (ml) determinan el ICE específico; el ad-valorem depende del precio por litro.</p>}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead><tr>
                <th>Producto</th><th className="r">Botellas</th><th className="r">Grado %</th><th className="r">Vol. (ml)</th><th className="r">$/Botella</th>
                <th className="r">ICE Esp./bot</th><th className="r">ICE AdV/bot</th><th className="r">Total ICE/bot</th><th>¿AdV?</th>
              </tr></thead>
              <tbody>
                {filt.map((a) => (
                  <tr key={a.producto}>
                    <td className="ice-prod" title={a.producto}>{a.producto}</td>
                    <td className="r">{(parseFloat(a.botellas) || 0).toFixed(0)}</td>
                    <td className="r">{(parseFloat(a.grado) || 0).toFixed(1)}</td>
                    <td className="r">{(parseFloat(a.volumen) || 0).toFixed(0)}</td>
                    <td className="r">{n4(a.precio_botella)}</td>
                    <td className="r">{n4(a.ice_esp_bot)}</td>
                    <td className="r">{n4(a.ice_adv_bot)}</td>
                    <td className="r strong">{n4(a.total_bot)}</td>
                    <td>{a.aplica_adv ? 'SÍ' : 'NO'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="ice-rep-total">
                <td>TOTAL · {filt.length} producto(s)</td>
                <td className="r">{filt.reduce((s, a) => s + (parseFloat(a.botellas) || 0), 0).toFixed(0)}</td>
                <td className="r" colSpan={6}>(valores por botella, no sumables)</td>
                <td></td>
              </tr></tfoot>
            </table>
          )}
        </CuadroFiltrable>
      )}

      {report?.por_producto?.length > 0 && (
        <CuadroFiltrable title={`📊 Reporte general acumulado (por número de botellas) (${anio})`} data={report.por_producto}
          fields={['producto']} value={filtros.acum} onFilter={(v) => setFiltro('acum', v)}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead>
                <tr>
                  <th>Producto</th><th className="r">Botellas</th><th className="r">Subtotal</th>
                  <th className="r">ICE Específico</th><th className="r">ICE Ad-Valorem</th><th className="r">Total ICE</th>
                  <th className="r">Base IVA</th><th className="r">IVA</th><th>AdV</th>
                </tr>
              </thead>
              <tbody>
                {filt.map((f) => (
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
                  <td>TOTAL · {filt.length} producto(s)</td>
                  <td className="r">{filt.reduce((s, f) => s + (parseFloat(f.botellas) || 0), 0).toFixed(0)}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.subtotal) || 0), 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.ice_especifico) || 0), 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.ice_advalorem) || 0), 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.total_ice) || 0), 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.base_iva) || 0), 0))}</td>
                  <td className="r">{money(filt.reduce((s, f) => s + (parseFloat(f.iva) || 0), 0))}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          )}
        </CuadroFiltrable>
      )}

      {/* Verificación del cálculo ICE (considera grado alcohólico y ml) */}
      {report?.detalle?.length > 0 && (
        <CuadroFiltrable title={`✅ Verificación del cálculo ICE por producto (${anio})`} data={report.detalle}
          fields={['producto_individual']} value={filtros.verif} onFilter={(v) => setFiltro('verif', v)}
          hint={<p className="ice-verif-note">ICE Específico = Litros de alcohol puro × Tarifa · ICE Ad-Valorem = (Precio/Litro − Umbral {money(report.params?.umbral)}) × 75% × Litros, si Precio/Litro &gt; Umbral.</p>}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead><tr>
                <th>Producto</th><th className="r">Botellas</th><th className="r">Vol. (cc)</th><th className="r">Grado %</th>
                <th className="r">Litros Alcohol</th><th className="r">Tarifa</th><th className="r">ICE Esp.</th>
                <th className="r">Precio/Litro</th><th>¿AdV?</th><th className="r">ICE AdV</th><th className="r">Total ICE</th>
              </tr></thead>
              <tbody>
                {filt.map((d, i) => {
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
              <tfoot><tr className="ice-rep-total">
                <td>TOTAL · {filt.length} ítem(s)</td>
                <td className="r">{filt.reduce((s, d) => s + (parseFloat(d.botellas) || 0), 0).toFixed(0)}</td>
                <td className="r"></td><td className="r"></td>
                <td className="r">{filt.reduce((s, d) => s + (parseFloat(d.botellas) || 0) * (parseFloat(d.volumen) || 0) / 1000 * (parseFloat(d.grado) || 0) / 100, 0).toFixed(2)}</td>
                <td className="r"></td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.ice_especifico) || 0), 0))}</td>
                <td className="r"></td><td></td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.ice_advalorem) || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.total_ice) || 0), 0))}</td>
              </tr></tfoot>
            </table>
          )}
        </CuadroFiltrable>
      )}

      {/* Cuadro por producto */}
      {cuadroProducto.length > 0 && (
        <CuadroFiltrable title={`📦 Cuadro por producto — ${selectedClient.identificacion} · ${selectedClient.nombre}`} data={cuadroProducto}
          fields={['producto']} value={filtros.prod} onFilter={(v) => setFiltro('prod', v)}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead><tr>
                <th>Producto</th><th className="r">Cajas</th><th className="r">Botellas</th>
                <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">Base IVA</th><th className="r">IVA</th><th className="r">Total</th>
              </tr></thead>
              <tbody>
                {filt.map((p) => (
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
              <tfoot><tr className="ice-rep-total">
                <td>TOTALES</td>
                <td className="r">{filt.reduce((s, p) => s + (p.cajas || 0), 0).toFixed(0)}</td>
                <td className="r">{filt.reduce((s, p) => s + (p.botellas || 0), 0)}</td>
                <td className="r">{money(filt.reduce((s, p) => s + (p.base_ice || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, p) => s + (p.valor_ice || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, p) => s + (p.base_iva || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, p) => s + (p.valor_iva || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, p) => s + (p.total || 0), 0))}</td>
              </tr></tfoot>
            </table>
          )}
        </CuadroFiltrable>
      )}

      {/* Cuadro por cliente */}
      {cuadroCliente.length > 0 && (
        <CuadroFiltrable title="👥 Cuadro por cliente (genera el anexo SRI)" data={cuadroCliente}
          fields={['ruc', 'nombre']} value={filtros.cli} onFilter={(v) => setFiltro('cli', v)}>
          {(filt) => (
            <table className="ice-rep-table">
              <thead><tr>
                <th>RUC</th><th>Cliente</th><th className="r">Botellas</th>
                <th className="r">Base ICE</th><th className="r">ICE</th><th className="r">IVA</th><th className="r">Total</th>
              </tr></thead>
              <tbody>
                {filt.map((c) => (
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
              <tfoot><tr className="ice-rep-total">
                <td>TOTALES</td><td></td>
                <td className="r">{filt.reduce((s, c) => s + (c.botellas || 0), 0)}</td>
                <td className="r">{money(filt.reduce((s, c) => s + (c.base_ice || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, c) => s + (c.valor_ice || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, c) => s + (c.valor_iva || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, c) => s + (c.total || 0), 0))}</td>
              </tr></tfoot>
            </table>
          )}
        </CuadroFiltrable>
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
        <CuadroFiltrable title="🧠 Análisis de diferencias (factura vs cálculo)" data={diferencias}
          fields={['producto']} value={filtros.dif} onFilter={(v) => setFiltro('dif', v)}
          hint={<p className="ice-verif-note">{diferencias.length} producto(s) con diferencia (los TOTALES de abajo son SOLO de estos productos, no el total general). El total general del período es: <b>ICE facturado {money(okRows.reduce((s, r) => s + (parseFloat(r.valor_ice) || 0), 0))}</b> vs <b>calculado {money(g?.total_ice)}</b> (ver cuadro “Revisión de valores”). Haz clic en una fila para ver la explicación.</p>}>
          {(filt) => (
            <table className="ice-rep-table ice-dif-table">
              <thead><tr>
                <th>Producto</th><th className="r">ICE facturado</th><th className="r">ICE calculado</th>
                <th className="r">Diferencia</th><th></th>
              </tr></thead>
              <tbody>
                {filt.map((d) => {
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
              <tfoot><tr className="ice-rep-total">
                <td>Subtotal · solo {filt.length} producto(s) con diferencia</td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.facIce) || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.audIce) || 0), 0))}</td>
                <td className="r">{money(filt.reduce((s, d) => s + (parseFloat(d.dif) || 0), 0))}</td>
                <td></td>
              </tr></tfoot>
            </table>
          )}
        </CuadroFiltrable>
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
