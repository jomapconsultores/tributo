import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
import './ClientSwitcher.css'

/**
 * Selector de contribuyente (RUC) + período (mes/año) sin salir del módulo.
 * Permite cambiar de cliente, de período, crear uno nuevo o volver al listado.
 */
export default function ClientSwitcher({ onNewClient }) {
  const { clients, selectedClientId, selectClient } = useClients()
  const current = clients.find((c) => c.id === selectedClientId)
  const ident = current?.identificacion || ''

  // Contribuyentes únicos por identificación
  const contribs = []
  const vistos = new Set()
  for (const c of clients) {
    if (!vistos.has(c.identificacion)) { vistos.add(c.identificacion); contribs.push(c) }
  }
  contribs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))

  // Períodos del contribuyente actual
  const periodos = clients
    .filter((c) => c.identificacion === ident)
    .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))

  const cambiarContrib = (e) => {
    const v = e.target.value
    if (v === '__new__') { onNewClient?.(); return }
    const list = clients.filter((c) => c.identificacion === v)
      .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))
    if (list[0]) selectClient(list[0].id)
  }

  const cambiarPeriodo = (e) => {
    const v = e.target.value
    if (v === '__new__') onNewClient?.()
    else selectClient(v)
  }

  return (
    <div className="cs">
      <button className="cs-back" onClick={() => selectClient(null)} title="Volver al listado">← Volver</button>
      <select className="cs-sel" value={ident} onChange={cambiarContrib} title="Contribuyente (RUC)">
        {contribs.map((c) => (
          <option key={c.identificacion} value={c.identificacion}>{c.identificacion} — {c.nombre}</option>
        ))}
        <option value="__new__">＋ Nuevo cliente…</option>
      </select>
      <select className="cs-sel cs-per" value={selectedClientId || ''} onChange={cambiarPeriodo} title="Período (mes/año)">
        {periodos.map((c) => (
          <option key={c.id} value={c.id}>{periodoCorto(c)}</option>
        ))}
        <option value="__new__">＋ Otro período…</option>
      </select>
    </div>
  )
}
