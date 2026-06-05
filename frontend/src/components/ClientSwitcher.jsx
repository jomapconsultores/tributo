import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import './ClientSwitcher.css'

/**
 * Barra para cambiar de cliente / RUC / período sin salir del módulo, crear uno
 * nuevo o volver al navegador. onNewClient abre el modal de nuevo cliente.
 */
export default function ClientSwitcher({ onNewClient }) {
  const { clients, selectedClientId, selectClient } = useClients()

  const onChange = (e) => {
    const v = e.target.value
    if (v === '__new__') onNewClient?.()
    else if (v === '__back__') selectClient(null)
    else selectClient(v)
  }

  return (
    <div className="cs">
      <button className="cs-back" onClick={() => selectClient(null)} title="Volver al listado">← Volver</button>
      <select className="cs-sel" value={selectedClientId || ''} onChange={onChange}>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.identificacion} — {c.nombre} · {periodoCorto(c)}
          </option>
        ))}
        <option value="__new__">＋ Nuevo cliente…</option>
      </select>
    </div>
  )
}
