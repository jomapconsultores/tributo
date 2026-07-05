import { useState, useEffect, useMemo, useRef } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { retencionesEfectuadasAPI, downloadBlob } from '../services/api'
import { descargarXmlsOriginales } from '../utils/xmlOriginales'
import { filterBySearch } from '../utils/search'
import { useClients } from '../context/ClientContext'
import { periodoLargo } from '../utils/periodo'
import BulkBar from '../components/BulkBar'
import { useBulkSelection } from '../hooks/useBulkSelection'
import { useClientList } from '../hooks/useClientList'
import useDraft from '../hooks/useDraft'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import WorkflowGuide from '../components/WorkflowGuide'
import './RetencionesEfectuadas.css'

import { fmtMoney as money, fmtPct as pct, msgFueraPeriodo } from '../utils/format'

const REF_STEPS = [
  { icon: '🧾', label: 'Retenciones efectuadas', current: true },
  { icon: '📄', label: 'Declaración IVA (sección agente)', path: '/declaracion-iva' },
  { icon: '📄', label: 'Declaración 103 (Renta)', path: '/declaracion-103' },
]

const EMPTY = {
  fecha: '', ruc_proveedor: '', nombre_proveedor: '', nro_comprobante: '',
  base_renta: 0, porc_renta: 0, concepto_renta: '',
  base_iva: 0, porc_iva: 0,
}

export default function RetencionesEfectuadas() {
  const navigate = useNavigate()
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, loading: clientsLoading } = useClients()

  // Solo clientes marcados como agente de retención (flag por cliente, no un
  // servicio de client_services): distinto de identsForSvc.
  const idents_agente = useMemo(() => {
    if (clientsLoading) return null
    return new Set(clients.filter((c) => c.es_agente_retencion).map((c) => c.identificacion))
  }, [clients, clientsLoading])

  const { data: rows, loading, error, reload: load } = useClientList(
    retencionesEfectuadasAPI.list, selectedClientId, { errorMessage: 'Error al cargar retenciones efectuadas' }
  )

  const [conceptos, setConceptos] = useState([])
  useEffect(() => {
    retencionesEfectuadasAPI.conceptosRenta().then((r) => setConceptos(r.data?.data || [])).catch(() => setConceptos([]))
  }, [])

  const [form, setForm] = useDraft(selectedClientId ? `draft:refectuadas:form:${selectedClientId}` : null, EMPTY)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const xmlInputRef = useRef(null)

  const elegirConcepto = (label) => {
    const c = conceptos.find((x) => x.label === label)
    setForm((f) => ({ ...f, concepto_renta: label, porc_renta: c?.porc ?? f.porc_renta }))
  }

  const agregar = async () => {
    if (!(form.ruc_proveedor || '').trim()) { alert('Ingresa el RUC/identificación del proveedor'); return }
    setSaving(true)
    try {
      if (editId) await retencionesEfectuadasAPI.update(editId, form)
      else await retencionesEfectuadasAPI.create({ client_id: selectedClientId, ...form })
      setForm(EMPTY)
      setEditId(null)
      await load()
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setSaving(false) }
  }

  const editar = (r) => {
    setEditId(r.id)
    setForm({
      fecha: r.fecha || '', ruc_proveedor: r.ruc_proveedor || '', nombre_proveedor: r.nombre_proveedor || '',
      nro_comprobante: r.nro_comprobante || '', base_renta: r.base_renta ?? 0, porc_renta: r.porc_renta ?? 0,
      concepto_renta: r.concepto_renta || '', base_iva: r.base_iva ?? 0, porc_iva: r.porc_iva ?? 0,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelarEdicion = () => { setEditId(null); setForm(EMPTY) }

  const handleUploadXml = async (files) => {
    if (!selectedClientId || !files.length) return
    setBusy(`Procesando ${files.length} XML de retención…`)
    try {
      const res = await retencionesEfectuadasAPI.processXml(selectedClientId, files)
      alert(`Nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates} | Errores: ${res.data.errors}` + msgFueraPeriodo(res.data))
      await load()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy('')
      if (xmlInputRef.current) xmlInputRef.current.value = ''
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
    if (files.length === 0) { alert('Arrastra archivos XML de comprobantes de retención.'); return }
    handleUploadXml(files)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar este comprobante?')) return
    try { await retencionesEfectuadasAPI.delete(id); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleClear = async () => {
    if (!window.confirm(`¿Eliminar TODAS las retenciones efectuadas de ${selectedClient?.nombre}?`)) return
    try { await retencionesEfectuadasAPI.clear(selectedClientId); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }
  const handleExport = async () => {
    try {
      const res = await retencionesEfectuadasAPI.exportExcel(selectedClientId)
      downloadBlob(res.data, `${selectedClient?.nombre || 'retenciones_efectuadas'}_RET_EFECTUADAS.xlsx`)
    } catch (err) {
      alert('Error Excel: ' + (err.response?.data?.detail || err.message))
    }
  }

  const filtered = useMemo(() =>
    filterBySearch(rows, search, (r) => [r.fecha, r.ruc_proveedor, r.nombre_proveedor, r.nro_comprobante, r.concepto_renta]),
  [rows, search])

  const tot = useMemo(() => filtered.reduce((t, r) => ({
    renta: t.renta + (parseFloat(r.ret_renta) || 0),
    iva: t.iva + (parseFloat(r.ret_iva) || 0),
    total: t.total + (parseFloat(r.total_retenido) || 0),
  }), { renta: 0, iva: 0, total: 0 }), [filtered])

  // ---- Selección múltiple ----
  const { selected, toggleSel, allSelected, toggleAll, clearSel } = useBulkSelection(filtered)

  const bulkMove = async (clientId) => {
    const ids = [...selected]
    try {
      const res = await retencionesEfectuadasAPI.bulkMove(ids, clientId)
      clearSel(); await load()
      const m = res.data?.moved ?? ids.length
      const s = res.data?.skipped ?? 0
      alert(`Movidas: ${m}${s ? ` · Omitidas (duplicadas en destino): ${s}` : ''}`)
    } catch (e) {
      alert('Error al mover: ' + (e.response?.data?.detail || e.message))
    }
  }
  const bulkDelete = async () => {
    const ids = [...selected]
    if (!window.confirm(`¿Eliminar ${ids.length} comprobante(s) seleccionado(s)?`)) return
    try { await retencionesEfectuadasAPI.bulkDelete(ids); clearSel(); await load() }
    catch (e) { alert('Error al eliminar: ' + (e.response?.data?.detail || e.message)) }
  }

  // Preview en vivo de lo que se está ingresando
  const previewRetRenta = round2((parseFloat(form.base_renta) || 0) * (parseFloat(form.porc_renta) || 0) / 100)
  const previewRetIva = round2((parseFloat(form.base_iva) || 0) * (parseFloat(form.porc_iva) || 0) / 100)

  if (!selectedClient || idents_agente === null || !idents_agente.has(selectedClient?.identificacion)) {
    return (
      <ClientPickerScreen
        icon="🧷"
        title="Retenciones efectuadas"
        subtitle="Retenciones de IVA y Renta que el cliente efectúa a sus proveedores como agente de retención"
        idents_svc={idents_agente}
        onNewClient={openNewClient}
        svcLabel="Agente de retención"
        hint={<>Marca <strong>«Es agente de retención»</strong> al crear o editar el cliente.</>}
      />
    )
  }

  return (
    <div className="ref-page">
      <WorkflowGuide steps={REF_STEPS} />
      <header className="ref-header">
        <div>
          <h1>🧷 Retenciones efectuadas <span className="ref-periodo-tag">{periodoLargo(selectedClient)}</span></h1>
          <p className="ref-subhead"><strong className="sub-ruc">{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
        <button className="ref-btn primary" onClick={() => navigate('/declaracion-iva')}>Continuar con {selectedClient.nombre} → Declaración IVA</button>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_agente} />

      {error && <div className="ref-error">⚠ {error}</div>}

      <div className="ref-stats">
        <div className="stat-card"><span className="num">{rows.length}</span><span className="lbl">Comprobantes</span></div>
        <div className="stat-card"><span className="num">{money(tot.renta)}</span><span className="lbl">Ret. Renta</span></div>
        <div className="stat-card"><span className="num">{money(tot.iva)}</span><span className="lbl">Ret. IVA</span></div>
        <div className="stat-card total"><span className="num">{money(tot.total)}</span><span className="lbl">Total retenido</span></div>
      </div>

      {/* Formulario manual */}
      <div className="ref-form">
        <label className="ref-field"><span>Fecha</span>
          <input className="ref-in" type="date" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} /></label>
        <label className="ref-field wide"><span>RUC/Cédula proveedor</span>
          <input className="ref-in" value={form.ruc_proveedor} onChange={(e) => setForm({ ...form, ruc_proveedor: e.target.value })} /></label>
        <label className="ref-field wide"><span>Nombre proveedor</span>
          <input className="ref-in" value={form.nombre_proveedor} onChange={(e) => setForm({ ...form, nombre_proveedor: e.target.value })} /></label>
        <label className="ref-field"><span>N.º comprobante</span>
          <input className="ref-in" value={form.nro_comprobante} onChange={(e) => setForm({ ...form, nro_comprobante: e.target.value })} /></label>

        <label className="ref-field wide"><span>Concepto Renta</span>
          <select className="ref-in" value={form.concepto_renta} onChange={(e) => elegirConcepto(e.target.value)}>
            <option value="">Concepto…</option>
            {conceptos.map((c) => <option key={c.key} value={c.label}>{c.label}{c.porc != null ? ` (${c.porc}%)` : ''}</option>)}
          </select></label>
        <label className="ref-field"><span>Base Renta ($)</span>
          <input className="ref-in s" type="number" step="0.01" value={form.base_renta} onChange={(e) => setForm({ ...form, base_renta: e.target.value })} /></label>
        <label className="ref-field"><span>% Renta</span>
          <input className="ref-in s" type="number" step="0.01" value={form.porc_renta} onChange={(e) => setForm({ ...form, porc_renta: e.target.value })} /></label>

        <label className="ref-field"><span>Base IVA ($)</span>
          <input className="ref-in s" type="number" step="0.01" value={form.base_iva} onChange={(e) => setForm({ ...form, base_iva: e.target.value })} /></label>
        <label className="ref-field"><span>% IVA</span>
          <select className="ref-in s" value={form.porc_iva} onChange={(e) => setForm({ ...form, porc_iva: e.target.value })}>
            <option value="0">—</option>
            <option value="30">30%</option>
            <option value="70">70%</option>
            <option value="100">100%</option>
          </select></label>

        <button className="ref-btn primary ref-add" onClick={agregar} disabled={saving}>{editId ? '💾 Guardar' : '＋ Agregar'}</button>
        {editId && <button className="ref-btn small ref-add" onClick={cancelarEdicion}>Cancelar</button>}
      </div>

      <div className="ref-preview">
        <span className="ref-preview-lbl">Cálculo en vivo:</span>
        <span>Ret. Renta <b className="hi">{money(previewRetRenta)}</b></span>
        <span>Ret. IVA <b className="hi">{money(previewRetIva)}</b></span>
        <span>Total <b className="hi">{money(previewRetRenta + previewRetIva)}</b></span>
      </div>

      {/* XML */}
      <div
        className={`ref-dropzone ${dragActive ? 'active' : ''}`}
        onDragEnter={handleDrag} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrop}
        onClick={() => xmlInputRef.current?.click()}
      >
        <span className="dz-icon">📥</span>
        <span className="dz-text">Arrastra aquí los XML de retención emitidos a proveedores</span>
        <span className="dz-sub">o haz clic para seleccionarlos</span>
      </div>

      <div className="ref-controls">
        <input
          ref={xmlInputRef} type="file" accept=".xml" multiple style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) handleUploadXml(Array.from(e.target.files)) }}
        />
        <button className="ref-btn primary" onClick={() => xmlInputRef.current?.click()}>📂 Cargar XMLs</button>
        <button className="ref-btn small" onClick={handleExport}>⬇ Exportar Excel</button>
        <button className="ref-btn small" onClick={() => descargarXmlsOriginales(selectedClient, selectedClientId, 'RetencionesEfectuadas', 'retencion_efectuada')} title="Descargar los XML originales subidos">⬇ XML originales</button>
        <button className="ref-btn small danger" onClick={handleClear}>🗑 Limpiar todo</button>
        <input
          className="ref-search" placeholder="🔍 Proveedor, RUC, comprobante, concepto…"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {busy && <div className="ref-busy">⏳ {busy}</div>}

      {loading ? (
        <div className="ref-empty">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="ref-empty">Sin retenciones efectuadas. Agrega una manualmente o carga los XML.</div>
      ) : (
        <div className="ref-table-wrap">
          <div className="ref-hint">{filtered.length} de {rows.length}</div>
          <BulkBar count={selected.size} onMove={bulkMove} onDelete={bulkDelete} onClear={clearSel} />
          <div className="ref-scroll">
            <table className="ref-table">
              <thead>
                <tr>
                  <th className="sel-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Seleccionar todo" /></th>
                  <th>Fecha</th><th>RUC Proveedor</th><th>Proveedor</th><th>Comprobante</th>
                  <th>Concepto Renta</th>
                  <th className="r">Base Renta</th><th className="r">% Renta</th><th className="r">Ret. Renta</th>
                  <th className="r">Base IVA</th><th className="r">% IVA</th><th className="r">Ret. IVA</th>
                  <th className="r">Total</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className={selected.has(r.id) ? 'row-sel' : ''}>
                    <td className="sel-col"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} /></td>
                    <td>{r.fecha || '-'}</td>
                    <td>{r.ruc_proveedor || '-'}</td>
                    <td className="prov" title={r.nombre_proveedor}>{r.nombre_proveedor || '-'}</td>
                    <td>{r.nro_comprobante || '-'}</td>
                    <td className="prov" title={r.concepto_renta}>{r.concepto_renta || '-'}</td>
                    <td className="r">{money(r.base_renta)}</td>
                    <td className="r">{pct(r.porc_renta)}</td>
                    <td className="r">{money(r.ret_renta)}</td>
                    <td className="r">{money(r.base_iva)}</td>
                    <td className="r">{pct(r.porc_iva)}</td>
                    <td className="r">{money(r.ret_iva)}</td>
                    <td className="r total">{money(r.total_retenido)}</td>
                    <td>
                      <button className="ref-edit" onClick={() => editar(r)} title="Editar">✏️</button>
                      <button className="ref-del" onClick={() => handleDelete(r.id)} title="Eliminar">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100 }
