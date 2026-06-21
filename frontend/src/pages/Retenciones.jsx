import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import { retentionsAPI, xmlOriginalesAPI, clientsAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoLargo } from '../utils/periodo'
import BulkBar from '../components/BulkBar'

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
import RetentionReport from '../components/RetentionReport'
import ClientSwitcher from '../components/ClientSwitcher'
import './Retenciones.css'

import { fmtMoney as money, fmtPct as pct, msgFueraPeriodo } from '../utils/format'

export default function Retenciones() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient } = useClients()

  const [idents_svc, setIdentsSvc] = useState(null)
  useEffect(() => {
    clientsAPI.byService('declaracion_iva')
      .then((r) => setIdentsSvc(new Set(r.data?.identificaciones || [])))
      .catch(() => setIdentsSvc(new Set()))
  }, [])

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const xmlInputRef = useRef(null)

  const load = useCallback(async () => {
    if (!selectedClientId) { setRows([]); return }
    setLoading(true)
    setError('')
    try {
      const res = await retentionsAPI.list(selectedClientId)
      setRows(res.data?.data || [])
    } catch (err) {
      setError('Error al cargar retenciones: ' + (err.response?.data?.detail || err.message))
    } finally {
      setLoading(false)
    }
  }, [selectedClientId])

  useEffect(() => { load() }, [load])

  const handleUploadXml = async (files) => {
    if (!selectedClientId || !files.length) return
    setBusy(`Procesando ${files.length} XML de retención…`)
    try {
      const res = await retentionsAPI.processXml(selectedClientId, files)
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
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true)
    else if (e.type === 'dragleave') setDragActive(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.name.toLowerCase().endsWith('.xml'))
    if (files.length === 0) {
      alert('Arrastra archivos XML de comprobantes de retención.')
      return
    }
    handleUploadXml(files)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('¿Eliminar esta retención?')) return
    try { await retentionsAPI.delete(id); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }

  const handleClear = async () => {
    if (!window.confirm(`¿Eliminar TODAS las retenciones de ${selectedClient?.nombre}?`)) return
    try { await retentionsAPI.clear(selectedClientId); await load() }
    catch (err) { alert('Error: ' + (err.response?.data?.detail || err.message)) }
  }

  const handleExport = async () => {
    try {
      const res = await retentionsAPI.exportExcel(selectedClientId)
      downloadBlob(res.data, `${selectedClient?.nombre || 'retenciones'}_RET.xlsx`)
    } catch (err) {
      alert('Error Excel: ' + (err.response?.data?.detail || err.message))
    }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter((r) =>
      [r.fecha, r.ruc_emisor, r.agente_retencion, r.nro_comprobante, r.periodo_fiscal]
        .some((f) => String(f || '').toLowerCase().includes(q))
    )
  }, [rows, search])

  const tot = useMemo(() => filtered.reduce((t, r) => ({
    renta: t.renta + (parseFloat(r.ret_renta) || 0),
    iva: t.iva + (parseFloat(r.ret_iva) || 0),
    isd: t.isd + (parseFloat(r.ret_isd) || 0),
    total: t.total + (parseFloat(r.total_retenido) || 0),
  }), { renta: 0, iva: 0, isd: 0, total: 0 }), [filtered])

  // ---- Selección múltiple ----
  const toggleSel = (id) => setSelected((prev) => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id))
  const toggleAll = () => setSelected((prev) => {
    if (filtered.every((r) => prev.has(r.id))) {
      const n = new Set(prev); filtered.forEach((r) => n.delete(r.id)); return n
    }
    return new Set([...prev, ...filtered.map((r) => r.id)])
  })
  const clearSel = () => setSelected(new Set())

  const bulkMove = async (clientId) => {
    const ids = [...selected]
    try {
      const res = await retentionsAPI.bulkMove(ids, clientId)
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
    if (!window.confirm(`¿Eliminar ${ids.length} retención(es) seleccionada(s)?`)) return
    try {
      await retentionsAPI.bulkDelete(ids)
      clearSel(); await load()
    } catch (e) {
      alert('Error al eliminar: ' + (e.response?.data?.detail || e.message))
    }
  }

  // ---------- Sin cliente seleccionado ----------
  if (!selectedClient) {
    const conServicio = idents_svc
      ? clients.filter((c) => idents_svc.has(c.identificacion))
      : clients
    return (
      <div className="ret-page">
        <div className="ret-welcome">
          <h1>🧾 Retenciones</h1>
          <p>
            {idents_svc
              ? `${conServicio.length} contribuyente(s) con servicio IVA activo.`
              : 'Selecciona un cliente para cargar y ver sus comprobantes de retención.'}
          </p>
          <button className="ret-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {conServicio.length > 0 && (
          <div className="ret-client-grid">
            {conServicio.map((c) => (
              <button key={c.id} className="ret-client-card" onClick={() => selectClient(c.id)}>
                <div className="rc-periodo">{periodoLargo(c)}</div>
                <div className="rc-name">{c.nombre}</div>
                <div className="rc-id">{c.tipo_identificacion}: {c.identificacion}</div>
              </button>
            ))}
          </div>
        )}
        {idents_svc && conServicio.length === 0 && (
          <div className="ret-welcome" style={{ marginTop: 8 }}>
            Ningún cliente tiene activo el servicio "Declaración IVA". Actívalo en CREDENCIALES SRI.
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="ret-page">
      <header className="ret-header">
        <div>
          <h1>🧾 Retenciones <span className="ret-periodo-tag">{periodoLargo(selectedClient)}</span></h1>
          <p className="ret-subhead"><strong className="sub-ruc">{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      {error && <div className="ret-error">⚠ {error}</div>}

      <div className="ret-stats">
        <div className="stat-card"><span className="num">{rows.length}</span><span className="lbl">Comprobantes</span></div>
        <div className="stat-card"><span className="num">{money(tot.renta)}</span><span className="lbl">Ret. Renta</span></div>
        <div className="stat-card"><span className="num">{money(tot.iva)}</span><span className="lbl">Ret. IVA</span></div>
        <div className="stat-card"><span className="num">{money(tot.isd)}</span><span className="lbl">Ret. ISD</span></div>
        <div className="stat-card total"><span className="num">{money(tot.total)}</span><span className="lbl">Total retenido</span></div>
      </div>

      <div
        className={`ret-dropzone ${dragActive ? 'active' : ''}`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => xmlInputRef.current?.click()}
      >
        <span className="dz-icon">📥</span>
        <span className="dz-text">Arrastra aquí los XML de retención</span>
        <span className="dz-sub">o haz clic para seleccionarlos — se incluirán en el cálculo</span>
      </div>

      <div className="ret-controls">
        <input
          ref={xmlInputRef}
          type="file"
          accept=".xml"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) handleUploadXml(Array.from(e.target.files)) }}
        />
        <button className="ret-btn primary" onClick={() => xmlInputRef.current?.click()}>📂 Cargar XMLs</button>
        <button className="ret-btn small" onClick={handleExport}>⬇ Exportar Excel</button>
        <button className="ret-btn small" onClick={() => descargarXmlsOriginales(selectedClient, selectedClientId, 'Retenciones', 'retencion')} title="Descargar los XML originales subidos">⬇ XML originales</button>
        <button className="ret-btn small danger" onClick={handleClear}>🗑 Limpiar todo</button>
        <input
          className="ret-search"
          placeholder="🔍 Agente, RUC, comprobante, período…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {busy && <div className="ret-busy">⏳ {busy}</div>}

      {loading ? (
        <div className="ret-empty">Cargando…</div>
      ) : rows.length === 0 ? (
        <div className="ret-empty">Sin retenciones. Carga los XML de comprobantes de retención para comenzar.</div>
      ) : (
        <div className="ret-table-wrap">
          <div className="ret-hint">{filtered.length} de {rows.length}</div>
          <BulkBar count={selected.size} onMove={bulkMove} onDelete={bulkDelete} onClear={clearSel} />
          <div className="ret-scroll">
            <table className="ret-table">
              <thead>
                <tr>
                  <th className="sel-col"><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Seleccionar todo" /></th>
                  <th>Estado</th><th>Fecha</th><th>RUC Emisor</th><th>Agente Retención</th>
                  <th>Comprobante</th><th>Período</th>
                  <th className="r">Base Renta</th><th className="r">% Renta</th><th className="r">Ret. Renta</th>
                  <th className="r">Base IVA</th><th className="r">% IVA</th><th className="r">Ret. IVA</th>
                  <th className="r">Ret. ISD</th><th className="r">Total</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className={`${r.estado === 'DUPLICADO' ? 'row-dup' : ''} ${selected.has(r.id) ? 'row-sel' : ''}`}>
                    <td className="sel-col">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSel(r.id)} />
                    </td>
                    <td>{r.estado}</td>
                    <td>{r.fecha || '-'}</td>
                    <td>{r.ruc_emisor || '-'}</td>
                    <td className="agente" title={r.agente_retencion}>{r.agente_retencion || '-'}</td>
                    <td>{r.nro_comprobante || '-'}</td>
                    <td>{r.periodo_fiscal || '-'}</td>
                    <td className="r">{money(r.base_renta)}</td>
                    <td className="r">{pct(r.porc_renta)}</td>
                    <td className="r">{money(r.ret_renta)}</td>
                    <td className="r">{money(r.base_iva)}</td>
                    <td className="r">{pct(r.porc_iva)}</td>
                    <td className="r">{money(r.ret_iva)}</td>
                    <td className="r">{money(r.ret_isd)}</td>
                    <td className="r total">{money(r.total_retenido)}</td>
                    <td><button className="ret-del" onClick={() => handleDelete(r.id)} title="Eliminar">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.length > 0 && <RetentionReport rows={rows} />}
    </div>
  )
}
