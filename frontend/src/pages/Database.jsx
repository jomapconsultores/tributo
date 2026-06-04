import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { invoicesAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import InvoiceTabs from '../components/InvoiceTabs'
import UploadPanel from '../components/UploadPanel'
import NewClientModal from '../components/NewClientModal'
import { periodoLargo } from '../utils/periodo'
import './Database.css'

export default function Database() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient, refreshClients, deleteClient } = useClients()

  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editClient, setEditClient] = useState(null)

  const loadInvoices = useCallback(async () => {
    if (!selectedClientId) {
      setInvoices([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await invoicesAPI.list(selectedClientId)
      setInvoices(res.data?.data || [])
    } catch (err) {
      setError('Error al cargar facturas: ' + (err.response?.data?.detail || err.message))
    } finally {
      setLoading(false)
    }
  }, [selectedClientId])

  useEffect(() => { loadInvoices() }, [loadInvoices])

  const afterImport = async () => {
    await loadInvoices()
    await refreshClients()
  }

  const handleUploadTxt = async (file) => {
    if (!selectedClientId) return
    setBusy('Descargando y procesando XMLs desde el SRI…')
    try {
      const res = await invoicesAPI.processTxt(selectedClientId, file)
      const d = res.data
      alert(`Claves: ${d.total_claves} | Procesadas: ${d.processed}\nNuevas: ${d.new} | Duplicadas: ${d.duplicates} | Errores: ${d.errors}`)
      await afterImport()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy('')
    }
  }

  const handleUploadXml = async (files) => {
    if (!selectedClientId) return
    setBusy(`Procesando ${files.length} archivo(s) XML…`)
    try {
      const res = await invoicesAPI.processXml(selectedClientId, files)
      alert(`Nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates} | Errores: ${res.data.errors}`)
      await afterImport()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    } finally {
      setBusy('')
    }
  }

  const handleExportExcel = async () => {
    try {
      const res = await invoicesAPI.exportExcel(selectedClientId)
      downloadBlob(res.data, `${selectedClient?.nombre || 'facturas'}.xlsx`)
    } catch (err) {
      alert('Error Excel: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleExportPdf = async () => {
    try {
      const res = await invoicesAPI.exportPdf(selectedClientId)
      downloadBlob(res.data, `${selectedClient?.nombre || 'facturas'}.pdf`, 'application/pdf')
    } catch (err) {
      alert('Error PDF: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleClear = async () => {
    if (!window.confirm(`¿Eliminar TODAS las facturas de ${selectedClient?.nombre}?`)) return
    try {
      await invoicesAPI.clear(selectedClientId)
      await afterImport()
    } catch (err) {
      alert('Error: ' + (err.response?.data?.detail || err.message))
    }
  }

  const handleDeleteClient = async () => {
    if (!window.confirm(`¿Eliminar el cliente ${selectedClient?.nombre} y TODAS sus facturas?`)) return
    await deleteClient(selectedClientId)
  }

  // ---------- Vista: ningún cliente seleccionado ----------
  if (!selectedClient) {
    return (
      <div className="db-page">
        <div className="db-welcome">
          <h1>🗄️ Base de Datos</h1>
          <p>Selecciona un cliente para ver sus gastos clasificados, o crea uno nuevo.</p>
          <button className="db-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>

        {clients.length > 0 && (
          <div className="client-grid">
            {clients.map((c) => (
              <button key={c.id} className="client-card" onClick={() => selectClient(c.id)}>
                <div className="cc-periodo">{periodoLargo(c)}</div>
                <div className="cc-name">{c.nombre}</div>
                <div className="cc-id">{c.tipo_identificacion}: {c.identificacion}</div>
                <div className="cc-stats">
                  <span>{c.num_facturas || 0} facturas</span>
                  <span>${(c.monto_total || 0).toFixed(2)}</span>
                </div>
                {c.sin_clasificar > 0 && (
                  <div className="cc-warn">{c.sin_clasificar} sin clasificar</div>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ---------- Vista: cliente seleccionado ----------
  const totalAmount = invoices.reduce((s, i) => s + (parseFloat(i.total) || 0), 0)
  const unclassified = invoices.filter(i => !i.clasificacion || i.clasificacion === 'SIN CLASIFICAR').length
  const yanbalCount = invoices.filter(i => i.es_yanbal).length

  return (
    <div className="db-page">
      <header className="db-header">
        <div>
          <h1>{selectedClient.nombre} <span className="db-periodo-tag">{periodoLargo(selectedClient)}</span></h1>
          <p className="db-subhead">
            {selectedClient.tipo_identificacion}: {selectedClient.identificacion}
          </p>
        </div>
        <div className="db-header-actions">
          <button className="db-btn ghost" onClick={() => setEditClient(selectedClient)}>✏️ Editar</button>
          <button className="db-btn danger-ghost" onClick={handleDeleteClient}>🗑 Eliminar cliente</button>
        </div>
      </header>

      {error && <div className="db-error">⚠ {error}</div>}

      <div className="db-stats">
        <div className="stat-card"><span className="num">{invoices.length}</span><span className="lbl">Facturas</span></div>
        <div className="stat-card"><span className="num">${totalAmount.toFixed(2)}</span><span className="lbl">Monto total</span></div>
        <div className="stat-card warn"><span className="num">{unclassified}</span><span className="lbl">Sin clasificar</span></div>
        <div className="stat-card yanbal"><span className="num">{yanbalCount}</span><span className="lbl">Yanbal (desc.)</span></div>
      </div>

      <UploadPanel onProcessTxt={handleUploadTxt} onProcessXml={handleUploadXml} />

      {busy && <div className="db-busy">⏳ {busy}</div>}

      <div className="db-controls">
        <button className="db-btn small" onClick={handleExportExcel}>⬇ Excel</button>
        <button className="db-btn small" onClick={handleExportPdf}>⬇ PDF</button>
        <button className="db-btn small danger" onClick={handleClear}>🗑 Limpiar facturas</button>
      </div>

      {loading ? (
        <div className="db-loading">Cargando facturas…</div>
      ) : invoices.length === 0 ? (
        <div className="db-empty">Sin facturas. Importa un TXT (claves SRI) o archivos XML para comenzar.</div>
      ) : (
        <InvoiceTabs invoices={invoices} onInvoicesChange={loadInvoices} />
      )}

      <NewClientModal open={!!editClient} editClient={editClient} onClose={() => setEditClient(null)} />
    </div>
  )
}
