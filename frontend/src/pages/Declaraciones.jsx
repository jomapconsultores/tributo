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
  const [aplazados, setAplazados] = useState([])
  const [loading, setLoading] = useState(false)

  // Overrides editables del crédito tributario mes anterior (605/606)
  // null = usar el pre-cargado del backend; número = override manual
  const [credAdq, setCredAdq] = useState(null)
  const [credRet, setCredRet] = useState(null)
  const [editAdq, setEditAdq] = useState(false)
  const [editRet, setEditRet] = useState(false)

  // Diferir pago al guardar: 0 (no diferir), 1, 2 o 3 meses
  const [diferirMeses, setDiferirMeses] = useState(0)

  const isIVA = tipo === 'IVA'
  const maxDiferir = isIVA ? 3 : 1

  const load = useCallback(async () => {
    if (!selectedClientId) { setDecl(null); setSaved([]); setAplazados([]); return }
    setLoading(true)
    try {
      const params = {}
      if (credAdq != null) params.credito_adq = credAdq
      if (credRet != null) params.credito_ret = credRet
      const [c, s, a] = await Promise.all([
        declaracionesAPI.calcular(selectedClientId, tipo, params),
        declaracionesAPI.list(selectedClientId, tipo),
        declaracionesAPI.listAplazados(selectedClientId).catch(() => ({ data: { data: [] } })),
      ])
      setDecl(c.data)
      setSaved(s.data?.data || [])
      // Filtrar aplazados por tipo de declaración (IVA o ICE)
      const allAplazados = a.data?.data || []
      setAplazados(allAplazados.filter((x) => (x.tipo || '').toUpperCase() === tipo))
    } catch (e) {
      alert('Error: ' + (e.response?.data?.detail || e.message))
    } finally { setLoading(false) }
  }, [selectedClientId, tipo, credAdq, credRet, isIVA])

  useEffect(() => { load() }, [load])

  const guardar = async () => {
    try {
      await declaracionesAPI.save(selectedClientId, tipo, decl, diferirMeses)
      setDiferirMeses(0)
      await load()
      let msg = '✔ Declaración guardada.'
      if (diferirMeses > 0) {
        const venceMes = (selectedClient.periodo_mes + diferirMeses - 1) % 12 + 1
        const venceAnio = selectedClient.periodo_anio + Math.floor((selectedClient.periodo_mes + diferirMeses - 1) / 12)
        msg += `\n\n📅 Pago aplazado ${diferirMeses} mes(es). Vence en ${nombreMes(venceMes)} ${venceAnio}.`
      }
      alert(msg)
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
  const marcarPagado = async (apId) => {
    if (!window.confirm('¿Marcar este pago aplazado como pagado?')) return
    try { await declaracionesAPI.marcarAplazado(apId, 'pagado'); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const cancelarAplazado = async (apId) => {
    if (!window.confirm('¿Cancelar este aplazamiento? No se podrá deshacer.')) return
    try { await declaracionesAPI.marcarAplazado(apId, 'cancelado'); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const aplicarOverride = (campo, valor) => {
    const num = parseFloat(valor)
    const v = isNaN(num) ? 0 : num
    if (campo === 'adq') { setCredAdq(v); setEditAdq(false) }
    else { setCredRet(v); setEditRet(false) }
  }
  const limpiarOverride = (campo) => {
    if (campo === 'adq') setCredAdq(null)
    else setCredRet(null)
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
  const resumen = decl?.resumen || {}
  const aplazadosPendientes = aplazados.filter((a) => a.estado === 'pendiente')
  const aplazadosVencen = decl?.aplazados_vencen || []
  const aplazadosOtros = aplazadosPendientes.filter((a) =>
    !aplazadosVencen.some((v) => v.id === a.id)
  )
  const hayMontoAPagar = (resumen.iva_a_pagar || 0) > 0 ||
                         (resumen.ice_a_pagar || 0) > 0 ||
                         (resumen.total_a_pagar || 0) > 0

  return (
    <div className="dc-page">
      <header className="dc-header">
        <div>
          <h1>{icon} Declaración {tipo}</h1>
          <p className="dc-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre} · {nombreMes(selectedClient.periodo_mes)} {selectedClient.periodo_anio}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      {/* Crédito tributario del mes anterior (solo IVA) */}
      {isIVA && decl && (
        <div className="dc-card-box dc-credit-box">
          <h2 className="dc-h2">🔁 Crédito tributario del mes anterior</h2>
          <p className="dc-credit-help">
            {credAdq != null || credRet != null
              ? 'Valores ingresados manualmente (override).'
              : 'Pre-cargado del histórico (declaración del mes anterior). Si no hay historial, queda en 0 y podés editarlo.'}
          </p>
          <div className="dc-credit-grid">
            <div className="dc-credit-field">
              <label>605 — Crédito por adquisiciones</label>
              {editAdq ? (
                <div className="dc-credit-edit">
                  <input
                    type="number" step="0.01" autoFocus
                    defaultValue={resumen.credito_mes_anterior_adquisiciones || 0}
                    onBlur={(e) => aplicarOverride('adq', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                  />
                </div>
              ) : (
                <div className="dc-credit-value">
                  <strong>{money(resumen.credito_mes_anterior_adquisiciones || 0)}</strong>
                  <button className="dc-btn-mini" onClick={() => setEditAdq(true)} title="Editar">✎</button>
                  {credAdq != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('adq')} title="Volver al automático">↺</button>}
                </div>
              )}
            </div>
            <div className="dc-credit-field">
              <label>606 — Crédito por retenciones</label>
              {editRet ? (
                <div className="dc-credit-edit">
                  <input
                    type="number" step="0.01" autoFocus
                    defaultValue={resumen.credito_mes_anterior_retenciones || 0}
                    onBlur={(e) => aplicarOverride('ret', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                  />
                </div>
              ) : (
                <div className="dc-credit-value">
                  <strong>{money(resumen.credito_mes_anterior_retenciones || 0)}</strong>
                  <button className="dc-btn-mini" onClick={() => setEditRet(true)} title="Editar">✎</button>
                  {credRet != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('ret')} title="Volver al automático">↺</button>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Aplazamientos VENCEN este período (deudas que se suman al pago de hoy) */}
      {aplazadosVencen.length > 0 && (
        <div className="dc-card-box dc-aplazado-vencen">
          <h2 className="dc-h2">⚠ Pagos aplazados que vencen este período ({aplazadosVencen.length})</h2>
          <p className="dc-credit-help">Se sumaron al casillero 903 / 904 del cálculo. Marcalos como pagados después de presentar.</p>
          <ul className="dc-aplazado-list">
            {aplazadosVencen.map((a) => (
              <li key={a.id}>
                <span>📅 De {nombreMes(a.origen_mes)} {a.origen_anio} → vence {nombreMes(a.vence_mes)} {a.vence_anio} ({a.meses_aplazados} mes/es)</span>
                <strong>{money(a.monto)}</strong>
                <button className="dc-btn-mini" onClick={() => marcarPagado(a.id)} title="Marcar pagado">✓</button>
                <button className="dc-btn-mini danger" onClick={() => cancelarAplazado(a.id)} title="Cancelar aplazamiento">✕</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Toolbar con guardar + aplazar pago */}
      <div className="dc-toolbar">
        <button className="dc-btn primary" onClick={guardar} disabled={!decl}>💾 Guardar declaración</button>
        {hayMontoAPagar && (
          <label className="dc-aplazar-control">
            Aplazar pago:
            <select value={diferirMeses} onChange={(e) => setDiferirMeses(parseInt(e.target.value, 10))}>
              <option value={0}>No aplazar</option>
              {Array.from({ length: maxDiferir }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n} mes{n > 1 ? 'es' : ''}</option>
              ))}
            </select>
            <small>{isIVA ? '(IVA: hasta 3 meses, Art. 67 LRTI)' : '(ICE: 1 mes max, reglamento ICE)'}</small>
          </label>
        )}
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
            <thead><tr><th>Código SRI</th><th>Concepto</th><th className="r"># Fact.</th><th className="r">Valor</th></tr></thead>
            <tbody>
              {secciones.map((sec) => (
                <Fragment key={sec}>
                  <tr className="dc-sec"><td colSpan={4}>{sec}</td></tr>
                  {decl.filas.filter((f) => f.seccion === sec).map((f, i) => (
                    <tr key={sec + i} className={f.seccion === 'RESULTADO' ? 'dc-res' : ''}>
                      <td className="dc-cod">{f.codigo}</td>
                      <td>{f.concepto}</td>
                      <td className="r">{f.num_comprobantes != null ? f.num_comprobantes : ''}</td>
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

      {/* Aplazamientos pendientes de otros períodos (informativo) */}
      {aplazadosOtros.length > 0 && (
        <div className="dc-card-box">
          <h2 className="dc-h2">📅 Otros pagos aplazados pendientes ({aplazadosOtros.length})</h2>
          <ul className="dc-aplazado-list">
            {aplazadosOtros.map((a) => (
              <li key={a.id}>
                <span>De {nombreMes(a.origen_mes)} {a.origen_anio} → vence {nombreMes(a.vence_mes)} {a.vence_anio}</span>
                <strong>{money(a.monto)}</strong>
                <button className="dc-btn-mini" onClick={() => marcarPagado(a.id)} title="Marcar pagado">✓</button>
              </li>
            ))}
          </ul>
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
