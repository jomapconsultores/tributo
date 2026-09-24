import { useState, useEffect, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { invoicesAPI, downloadBlob } from '../services/api'
import { descargarXmlsOriginales } from '../utils/xmlOriginales'
import { useClients } from '../context/ClientContext'
import WorkflowGuide from '../components/WorkflowGuide'
import InvoiceTabs from '../components/InvoiceTabs'
import UploadPanel from '../components/UploadPanel'
import NewClientModal from '../components/NewClientModal'
import ClientNavigator from '../components/ClientNavigator'
import ClientSwitcher from '../components/ClientSwitcher'
import ClaveHeader from '../components/ClaveHeader'
import BajadorSRI from '../components/BajadorSRI'
import { periodoLargo } from '../utils/periodo'
import { fmtMoney, msgFueraPeriodo, msgIdentAjena } from '../utils/format'
import './Database.css'

export default function Database() {
  const navigate = useNavigate()
  const { openNewClient } = useOutletContext()
  const { selectedClient, selectedClientId, refreshClients, deleteClient } = useClients()
  // Gastos es el módulo de entrada: se muestran TODOS los clientes visibles al usuario,
  // sin filtrar por servicio (el filtro por servicio aplica solo en módulos de declaración).
  const idents_all = null

  const [invoices, setInvoices] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [editClient, setEditClient] = useState(null)
  const [verBajador, setVerBajador] = useState(false)

  const loadInvoices = useCallback(async (silent = false) => {
    if (!selectedClientId) {
      setInvoices([])
      return
    }
    // Recarga "silenciosa" (sin spinner) para no desmontar InvoiceTabs y perder la
    // pestaña activa (ej. al asignar una categoría desde Pendientes).
    if (!silent) setLoading(true)
    setError('')
    try {
      const res = await invoicesAPI.list(selectedClientId)
      setInvoices(res.data?.data || [])
    } catch (err) {
      setError('Error al cargar facturas: ' + (err.response?.data?.detail || err.message))
    } finally {
      if (!silent) setLoading(false)
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
      msg += msgFueraPeriodo(d) + msgIdentAjena(d)
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
      alert(`Nuevas: ${res.data.new} | Duplicadas: ${res.data.duplicates} | Errores: ${res.data.errors}` + msgFueraPeriodo(res.data) + msgIdentAjena(res.data))
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

  const handleDownloadXmls = () => descargarXmlsOriginales(selectedClient, selectedClientId, 'Gastos', 'gasto')

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
      <div className="ui-page">
        <header className="ui-head">
          <div className="ui-head-txt">
            <div className="ui-eyebrow">🗄️ Base de datos</div>
            <h1 className="ui-title">Contribuyentes</h1>
            <p className="ui-subtitle">Elige un contribuyente y abre su año, mes y tipo de datos.</p>
          </div>
          {/* openNewClient es null cuando no se puede dar de alta: sin esto el
              botón se quedaba puesto y no hacía nada al pulsarlo. */}
          {openNewClient && (
            <div className="ui-head-acts">
              <button className="ui-btn primary" onClick={openNewClient}>＋ Nuevo contribuyente</button>
            </div>
          )}
        </header>
        <ClientNavigator idents_svc={idents_all} />
      </div>
    )
  }

  // ---------- Vista: cliente seleccionado ----------
  const totalAmount = invoices.reduce((s, i) => s + (parseFloat(i.total) || 0), 0)
  const unclassified = invoices.filter(i => !i.clasificacion || i.clasificacion === 'SIN CLASIFICAR').length
  const yanbalCount = invoices.filter(i => i.es_yanbal).length

  const DB_STEPS = [
    { icon: '📥', label: 'Subir TXT/XML de gastos', current: true },
    { icon: '🗂', label: 'Clasificar comprobantes', path: '/clasificador' },
    { icon: '📄', label: 'Declaraciones IVA / ICE', path: '/declaracion-iva' },
    { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
    { icon: '🧾', label: 'Facturar en Odoo', path: '/facturacion' },
  ]

  return (
    <div className="ui-page">
      <WorkflowGuide steps={DB_STEPS} />
      {/* Cabecera: de quién, de cuándo, y las acciones de la pantalla. El RUC y
          el período estaban dentro del título, todo en una línea; ahora el
          contexto va arriba y el nombre manda. */}
      <header className="ui-head">
        <div className="ui-head-txt">
          <div className="ui-eyebrow">
            <span className="ui-tag">💸 Gastos</span>
            <span>{selectedClient.identificacion}</span>
            <span className="ui-tag neutro">{periodoLargo(selectedClient)}</span>
            <ClaveHeader clientId={selectedClientId} />
          </div>
          <h1 className="ui-title">{selectedClient.nombre}</h1>
        </div>
        <div className="ui-head-acts">
          <button className="ui-btn primary" onClick={() => navigate('/clasificador')}>Clasificar →</button>
          <button className="ui-btn ghost" onClick={() => setEditClient(selectedClient)}>✏️ Editar</button>
          <button className="ui-btn peligro" onClick={handleDeleteClient}>🗑 Eliminar</button>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_all} />

      {error && <div className="ui-alert error">⚠ {error}</div>}

      <div className="ui-stats">
        <div className="ui-stat">
          <span className="ui-stat-num">{invoices.length}</span>
          <span className="ui-stat-lbl">Facturas</span>
        </div>
        <div className="ui-stat">
          <span className="ui-stat-num">{fmtMoney(totalAmount)}</span>
          <span className="ui-stat-lbl">Monto total</span>
        </div>
        <div className={`ui-stat ${unclassified ? 'alerta' : 'ok'}`}>
          <span className="ui-stat-num">{unclassified}</span>
          <span className="ui-stat-lbl">Sin clasificar</span>
          {/* Decir que están todas clasificadas vale tanto como decir cuántas
              faltan: es la señal de que el mes está listo para declarar. */}
          <span className="ui-stat-pie">{unclassified ? 'Pendientes de rubro' : 'Todo clasificado'}</span>
        </div>
        <div className="ui-stat morado">
          <span className="ui-stat-num">{yanbalCount}</span>
          <span className="ui-stat-lbl">Yanbal (desc.)</span>
        </div>
      </div>

      <UploadPanel onProcessTxt={handleUploadTxt} onProcessXml={handleUploadXml} />

      {busy && <div className="ui-alert info">⏳ {busy}</div>}

      <div className="ui-toolbar">
        <button className="ui-btn" onClick={() => setVerBajador(true)}
          title="Bajar del SRI los comprobantes recibidos (gastos y/o retenciones) del mes o semestre que elijas">
          📥 Bajador-GASTOS (SRI)
        </button>
        <span className="ui-toolbar-sep" />
        <div className="ui-toolbar-grupo">
          <span className="ui-toolbar-lbl">Descargar</span>
          <button className="ui-btn sm" onClick={handleExportExcel}>Excel</button>
          <button className="ui-btn sm" onClick={handleExportPdf}>PDF</button>
          <button className="ui-btn sm" onClick={handleDownloadXmls} title="Descargar los XML originales subidos">XML originales</button>
        </div>
        {/* Separada del resto: es la única que borra. */}
        <button className="ui-btn peligro sm" onClick={handleClear}>🗑 Limpiar facturas</button>
      </div>

      {loading ? (
        <div className="ui-cargando">Cargando facturas…</div>
      ) : invoices.length === 0 ? (
        <div className="ui-vacio">
          <span className="ui-vacio-ico">📥</span>
          <div className="ui-vacio-tit">Todavía no hay facturas en este período</div>
          <p className="ui-vacio-txt">
            Sube el TXT de claves del SRI o los archivos XML con el panel de arriba.
            Si aún no los tienes, bájalos del portal con el Bajador-GASTOS.
          </p>
        </div>
      ) : (
        <InvoiceTabs invoices={invoices} client={selectedClient} onInvoicesChange={() => loadInvoices(true)} />
      )}

      <NewClientModal open={!!editClient} editClient={editClient} onClose={() => setEditClient(null)} />
      {verBajador && <BajadorSRI which="gastos" onClose={() => setVerBajador(false)} />}
    </div>
  )
}
