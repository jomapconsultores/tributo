import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { invoicesAPI, xmlOriginalesAPI, clientsAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import InvoiceTabs from '../components/InvoiceTabs'
import UploadPanel from '../components/UploadPanel'
import NewClientModal from '../components/NewClientModal'
import ClientNavigator from '../components/ClientNavigator'
import ClientSwitcher from '../components/ClientSwitcher'
import ClaveHeader from '../components/ClaveHeader'
import { periodoLargo } from '../utils/periodo'
import { fmtMoney, msgFueraPeriodo } from '../utils/format'
import './Database.css'

export default function Database() {
  const { openNewClient } = useOutletContext()
  const { selectedClient, selectedClientId, refreshClients, deleteClient } = useClients()

  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editClient, setEditClient] = useState(null)
  const [idents_svc, setIdentsSvc] = useState(null)
  useEffect(() => {
    clientsAPI.byService('declaracion_iva,declaracion_ice,declaracion_renta,devolucion_iva')
      .then((r) => setIdentsSvc(new Set(r.data?.identificaciones || [])))
      .catch(() => setIdentsSvc(new Set()))
  }, [])

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
      const faltan = d.no_descargadas ?? 0
      let msg = `Claves en el archivo: ${d.total_claves}\n` +
                `Descargadas del SRI: ${d.descargadas ?? d.processed} de ${d.total_claves}\n` +
                `Nuevas: ${d.new} | Duplicadas: ${d.duplicates}`
      if (faltan > 0) {
        msg += `\n\n⚠ ${faltan} no se pudieron bajar (el SRI las rechazó tras varios reintentos).` +
               `\nVuelve a subir el MISMO archivo: solo reintentará las que faltan (las ya bajadas saldrán como duplicadas).`
      } else {
        msg += `\n\n✔ Se bajaron TODAS las facturas.`
      }
      msg += msgFueraPeriodo(d)
      alert(msg)
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
      alert(`Nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates} | Errores: ${res.data.errors}` + msgFueraPeriodo(res.data))
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

  const handleDownloadXmls = async () => {
    try {
      const c = selectedClient || {}
      const nom = (c.nombre || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20)
      const nombre = `Gastos_${c.identificacion || ''}_${nom}_${String(c.periodo_mes || '').padStart(2, '0')}_${c.periodo_anio || ''}.zip`
      const res = await xmlOriginalesAPI.descargar(selectedClientId, 'gasto')
      downloadBlob(res.data, nombre, 'application/zip')
    } catch (err) {
      if (err.response?.status === 404) alert('Aún no hay XML guardados para este período. Se guardan automáticamente al subir nuevos XML.')
      else alert('Error: ' + (err.response?.data?.detail || err.message))
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

  // ---------- Vista: ningún cliente seleccionado (navegador) ----------
  if (!selectedClient) {
    return (
      <div className="db-page">
        <div className="db-nav-head">
          <div>
            <h1>🗄️ Base de Datos</h1>
            <p className="db-subhead">Elige un contribuyente y abre su año, mes y tipo de datos.</p>
          </div>
          <button className="db-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        <ClientNavigator idents_svc={idents_svc} />
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
          <h1><span className="db-ruc">{selectedClient.identificacion}</span> {selectedClient.nombre} <span className="db-periodo-tag">{periodoLargo(selectedClient)}</span><ClaveHeader clientId={selectedClientId} /></h1>
        </div>
        <div className="db-header-actions">
          <button className="db-btn ghost" onClick={() => setEditClient(selectedClient)}>✏️ Editar</button>
          <button className="db-btn danger-ghost" onClick={handleDeleteClient}>🗑 Eliminar cliente</button>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      {error && <div className="db-error">⚠ {error}</div>}

      <div className="db-stats">
        <div className="stat-card"><span className="num">{invoices.length}</span><span className="lbl">Facturas</span></div>
        <div className="stat-card"><span className="num">{fmtMoney(totalAmount)}</span><span className="lbl">Monto total</span></div>
        <div className="stat-card warn"><span className="num">{unclassified}</span><span className="lbl">Sin clasificar</span></div>
        <div className="stat-card yanbal"><span className="num">{yanbalCount}</span><span className="lbl">Yanbal (desc.)</span></div>
      </div>

      <UploadPanel onProcessTxt={handleUploadTxt} onProcessXml={handleUploadXml} />

      {busy && <div className="db-busy">⏳ {busy}</div>}

      <div className="db-controls">
        <button className="db-btn small" onClick={handleExportExcel}>⬇ Excel</button>
        <button className="db-btn small" onClick={handleExportPdf}>⬇ PDF</button>
        <button className="db-btn small" onClick={handleDownloadXmls} title="Descargar los XML originales subidos">⬇ XML originales</button>
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
