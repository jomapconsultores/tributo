import { useState, useEffect, useCallback, Fragment } from 'react'
import { useOutletContext } from 'react-router-dom'
import { declaracionesAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoLargo, nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import './Declaraciones.css'

const money = (v) => `$${(parseFloat(v) || 0).toFixed(2)}`

export default function Declaraciones({ tipo }) {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient } = useClients()

  const [decl, setDecl] = useState(null)
  const [saved, setSaved] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!selectedClientId) { setDecl(null); setSaved([]); return }
    setLoading(true)
    try {
      const [c, s] = await Promise.all([
        declaracionesAPI.calcular(selectedClientId, tipo),
        declaracionesAPI.list(selectedClientId, tipo),
      ])
      setDecl(c.data)
      setSaved(s.data?.data || [])
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }, [selectedClientId, tipo])

  useEffect(() => { load() }, [load])

  const guardar = async () => {
    try {
      await declaracionesAPI.save(selectedClientId, tipo, decl)
      await load()
      alert('✔ Declaración guardada.')
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const exportar = async () => {
    try {
      const res = await declaracionesAPI.exportExcel(selectedClientId, tipo)
      downloadBlob(res.data, `Declaracion_${tipo}_${selectedClient?.nombre || ''}.xlsx`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const exportarOficial = async () => {
    try {
      const res = await declaracionesAPI.exportOficial(selectedClientId, tipo)
      downloadBlob(res.data, `Formulario_${tipo}_${selectedClient?.nombre || ''}.xlsx`)
      const ll = res.headers['x-codigos-llenados']
      const om = res.headers['x-codigos-omitidos']
      let msg = `📄 Formulario oficial ${tipo} generado (borrador).\nCódigos llenados: ${ll || '—'}`
      if (om) msg += `\nOmitidos (los calcula el formulario): ${om}`
      msg += '\n\n⚠ Verifica los valores y casilleros antes de presentar al SRI.'
      alert(msg)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    if (!window.confirm('¿Eliminar esta declaración guardada?')) return
    try { await declaracionesAPI.delete(id); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const icon = tipo === 'ICE' ? '🥃' : '🧾'

  if (!selectedClient) {
    return (
      <div className="dc-page">
        <div className="dc-welcome">
          <h1>{icon} Declaración {tipo}</h1>
          <p>Selecciona un contribuyente (RUC) y período para armar la declaración {tipo}.</p>
          <button className="dc-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {clients.length > 0 && (
          <div className="dc-grid">
            {clients.map((c) => (
              <button key={c.id} className="dc-card" onClick={() => selectClient(c.id)}>
                <div className="dc-card-id">{c.identificacion}</div>
                <div className="dc-card-name">{c.nombre}</div>
                <div className="dc-card-per">{periodoLargo(c)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const secciones = decl ? [...new Set(decl.filas.map((f) => f.seccion))] : []

  return (
    <div className="dc-page">
      <header className="dc-header">
        <div>
          <h1>{icon} Declaración {tipo}</h1>
          <p className="dc-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre} · {nombreMes(selectedClient.periodo_mes)} {selectedClient.periodo_anio}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      <div className="dc-toolbar">
        <button className="dc-btn primary" onClick={guardar} disabled={!decl}>💾 Guardar declaración</button>
        <button className="dc-btn small" onClick={exportar} disabled={!decl}>⬇ Excel (código/valor)</button>
        <button className="dc-btn oficial" onClick={exportarOficial} disabled={!decl}>📄 Formulario oficial SRI</button>
      </div>

      {loading ? (
        <div className="dc-empty">Calculando…</div>
      ) : !decl ? (
        <div className="dc-empty">Sin datos.</div>
      ) : (
        <div className="dc-card-box">
          <table className="dc-table">
            <thead><tr><th>Código SRI</th><th>Concepto</th><th className="r">Valor</th></tr></thead>
            <tbody>
              {secciones.map((sec) => (
                <Fragment key={sec}>
                  <tr className="dc-sec"><td colSpan={3}>{sec}</td></tr>
                  {decl.filas.filter((f) => f.seccion === sec).map((f, i) => (
                    <tr key={sec + i} className={f.seccion === 'RESULTADO' ? 'dc-res' : ''}>
                      <td className="dc-cod">{f.codigo}</td>
                      <td>{f.concepto}</td>
                      <td className="r">{money(f.valor)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
          <p className="dc-note">⚠ Valores calculados automáticamente desde los datos cargados. Verifica los códigos con tu contador antes de presentar al SRI.</p>
        </div>
      )}

      {saved.length > 0 && (
        <div className="dc-card-box">
          <h2 className="dc-h2">Declaraciones guardadas</h2>
          <ul className="dc-saved">
            {saved.map((s) => (
              <li key={s.id}>
                <span>{nombreMes(s.mes)} {s.anio} · {s.tipo}</span>
                <button className="dc-del" onClick={() => borrar(s.id)}>🗑</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
