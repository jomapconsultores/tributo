import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { clientsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoLargo } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import './DevolucionesIva.css'

export default function DevolucionesIvaTerceraEdad() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient } = useClients()

  const [idents_svc, setIdentsSvc] = useState(null)
  useEffect(() => {
    clientsAPI.byService('devolucion_iva')
      .then((r) => setIdentsSvc(new Set(r.data?.identificaciones || [])))
      .catch(() => setIdentsSvc(new Set()))
  }, [])

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon="👵" title="Devolución IVA" subtitle="Devolución para adultos mayores y personas con discapacidad" idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Devolución IVA" />
  }

  return (
    <div className="dv-page">
      <header className="dv-header">
        <div>
          <h1>👵 Devolución IVA — Adultos mayores</h1>
          <p className="dv-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      <div className="dv-stub-box">
        <h2>🚧 Módulo en construcción</h2>
        <p>Este módulo va a permitir:</p>
        <ol>
          <li>
            <strong>Bajar comprobantes</strong> automáticamente desde el portal SRI de
            Devoluciones IVA Tercera Edad (<code>srienlinea.sri.gob.ec/devolucionTerceraEdad-internet</code>),
            usando el descargador local (<code>sri_downloader/</code>).
          </li>
          <li>
            <strong>Marcar comprobantes</strong> que aplican a la devolución (filtros por
            categoría, período, monto).
          </li>
          <li>
            <strong>Clasificar automáticamente</strong> cada comprobante según el mapa
            RUC → categoría del Clasificador de Gastos.
          </li>
          <li>
            <strong>Guardar en BD</strong> la solicitud + ítems para reusar entre meses y
            exportar a Excel/PDF para presentar al SRI.
          </li>
        </ol>
        <p className="dv-roadmap">
          <strong>Roadmap</strong>: el frontend (esta página) está listo como esqueleto.
          Pendiente: scraper SRI (parte de la iteración 2+ del SRI Downloader),
          endpoints backend (<code>/api/devoluciones-iva/...</code>) y tabla
          <code>devoluciones_iva_solicitudes</code> en Supabase.
        </p>
      </div>
    </div>
  )
}
