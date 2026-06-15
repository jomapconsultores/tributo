import { useState, useEffect, useCallback, Fragment } from 'react'
import useDraft from '../hooks/useDraft'
import { useOutletContext } from 'react-router-dom'
import { declaracionesAPI, clientsAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoLargo, nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import './Declaraciones.css'

import { fmtMoney as money } from '../utils/format'

// Casilleros TOTAL (resaltados en dorado, igual que el formulario oficial del SRI)
const TOTALES_SRI = new Set([
  '409', '419', '429', '499', '509', '519', '529', '620', '699', '859', '999',  // IVA
  '399', '902',  // ICE
])

// Etiquetas legibles de los servicios contratados (client_services)
const SERVICIO_LBL = {
  declaracion_iva: 'Declaración IVA', declaracion_ice: 'Declaración ICE',
  declaracion_renta: 'Declaración Renta', devolucion_iva: 'Devolución IVA',
}

export default function Declaraciones({ tipo }) {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectedClientId, selectClient } = useClients()

  // Auto-guardado local: los valores que escribes (overrides) se guardan al
  // instante en el navegador, por cliente+tipo. Si se cae el internet o recargas,
  // no se pierden. dk(nombre) = clave del borrador (null si no hay cliente).
  const draftKey = selectedClientId ? `draft:decl:${tipo}:${selectedClientId}` : null
  const dk = (name) => (draftKey ? `${draftKey}:${name}` : null)

  const [decl, setDecl] = useState(null)
  const [saved, setSaved] = useState([])
  const [aplazados, setAplazados] = useState([])
  const [loading, setLoading] = useState(false)
  const [clientSearch, setClientSearch] = useState('')
  // RUCs que tienen el servicio activo (null = cargando, Set = listo)
  const [idents_svc, setIdentsSvc] = useState(null)
  // Credenciales/servicios del contribuyente (punto 4)
  const [creds, setCreds] = useState(null)
  const [claveSRI, setClaveSRI] = useState('')

  // Overrides editables del crédito tributario mes anterior (605/606)
  // null = usar el pre-cargado del backend; número = override manual
  const [credAdq, setCredAdq] = useDraft(dk('credAdq'), null)
  const [credRet, setCredRet] = useDraft(dk('credRet'), null)
  const [editAdq, setEditAdq] = useState(false)
  const [editRet, setEditRet] = useState(false)

  // Override manual de ventas/ingresos (cuando no se tienen los XML).
  // null = usar lo calculado de los comprobantes; número = ingresado a mano.
  const [ventas15, setVentas15] = useDraft(dk('ventas15'), null)
  const [ventas5, setVentas5] = useDraft(dk('ventas5'), null)
  const [ventas0, setVentas0] = useDraft(dk('ventas0'), null)
  const [editV15, setEditV15] = useState(false)
  const [editV5, setEditV5] = useState(false)
  const [editV0, setEditV0] = useState(false)

  // Factor de proporcionalidad del crédito IVA: null = auto (calculado de las
  // ventas); número 0..1 = override manual.
  const [factorProp, setFactorProp] = useDraft(dk('factorProp'), null)
  const [editFactor, setEditFactor] = useState(false)

  // Rebajas y exenciones ICE: null = auto (precalculado del módulo Rebajas y
  // exenciones); número = override manual. Mismo patrón que 605/606.
  const [rebajaIce, setRebajaIce] = useDraft(dk('rebajaIce'), null)
  const [exencionIce, setExencionIce] = useDraft(dk('exencionIce'), null)
  const [editReb, setEditReb] = useState(false)
  const [editExe, setEditExe] = useState(false)
  // Casillas "aplica" manuales (sin cálculo del módulo): generan advertencia
  const [marcaReb, setMarcaReb] = useDraft(dk('marcaReb'), false)
  const [marcaExe, setMarcaExe] = useDraft(dk('marcaExe'), false)

  // Diferir pago al guardar: 0 (no diferir), 1, 2 o 3 meses
  const [diferirMeses, setDiferirMeses] = useDraft(dk('diferirMeses'), 0)

  const isIVA = tipo === 'IVA'
  const maxDiferir = isIVA ? 3 : 1

  const load = useCallback(async () => {
    if (!selectedClientId) { setDecl(null); setSaved([]); setAplazados([]); return }
    setLoading(true)
    try {
      const params = {}
      if (credAdq != null) params.credito_adq = credAdq
      if (credRet != null) params.credito_ret = credRet
      if (rebajaIce != null) params.rebaja_ice = rebajaIce
      if (exencionIce != null) params.exencion_ice = exencionIce
      if (marcaReb) params.rebaja_manual = 1
      if (marcaExe) params.exencion_manual = 1
      if (ventas15 != null) params.ventas_15 = ventas15
      if (ventas5 != null) params.ventas_5 = ventas5
      if (ventas0 != null) params.ventas_0 = ventas0
      if (factorProp != null) params.factor_prop = factorProp
      if (diferirMeses > 0) params.diferir_meses = diferirMeses
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
  }, [selectedClientId, tipo, credAdq, credRet, rebajaIce, exencionIce, marcaReb, marcaExe, ventas15, ventas5, ventas0, factorProp, diferirMeses, isIVA])

  useEffect(() => { load() }, [load])

  // Cargar qué RUCs tienen el servicio IVA/ICE activo para filtrar la grilla
  useEffect(() => {
    setIdentsSvc(null)
    const svc = tipo === 'IVA' ? 'declaracion_iva' : 'declaracion_ice'
    clientsAPI.byService(svc)
      .then((r) => setIdentsSvc(new Set(r.data?.identificaciones || [])))
      .catch(() => setIdentsSvc(new Set()))
  }, [tipo])

  // Servicios contratados + clave SRI en un solo viaje (reveal=true)
  useEffect(() => {
    setCreds(null); setClaveSRI('')
    if (!selectedClientId) return
    let cancelled = false
    declaracionesAPI.credenciales(selectedClientId, true)
      .then((r) => {
        if (cancelled) return
        setCreds(r.data)
        if (r.data?.es_admin && r.data?.credencial?.password) {
          setClaveSRI(r.data.credencial.password)
        }
      })
      .catch(() => { if (!cancelled) setCreds(null) })
    return () => { cancelled = true }
  }, [selectedClientId])

  const guardar = async () => {
    try {
      await declaracionesAPI.save(selectedClientId, tipo, decl, diferirMeses)
      setDiferirMeses(0)
      await load()
      let msg = '✔ Declaración guardada. Queda LISTA para facturar (aparece marcada en Reportes).'
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
      const res = await declaracionesAPI.exportExcel(selectedClientId, tipo, overridesActuales())
      downloadBlob(res.data, `Declaracion_${tipo}_${selectedClient?.nombre || ''}.xlsx`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const exportarOficial = async () => {
    try {
      const res = await declaracionesAPI.exportOficial(selectedClientId, tipo, overridesActuales())
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
    else if (campo === 'ret') { setCredRet(v); setEditRet(false) }
    else if (campo === 'reb') { setRebajaIce(v); setEditReb(false) }
    else if (campo === 'exe') { setExencionIce(v); setEditExe(false) }
    else if (campo === 'v15') { setVentas15(v); setEditV15(false) }
    else if (campo === 'v5') { setVentas5(v); setEditV5(false) }
    else if (campo === 'v0') { setVentas0(v); setEditV0(false) }
  }
  const limpiarOverride = (campo) => {
    if (campo === 'adq') setCredAdq(null)
    else if (campo === 'ret') setCredRet(null)
    else if (campo === 'reb') setRebajaIce(null)
    else if (campo === 'exe') setExencionIce(null)
    else if (campo === 'v15') setVentas15(null)
    else if (campo === 'v5') setVentas5(null)
    else if (campo === 'v0') setVentas0(null)
  }

  // Overrides activos para incluir en las exportaciones (Excel / formulario oficial)
  const overridesActuales = () => {
    const ov = {}
    if (credAdq != null) ov.credito_adq = credAdq
    if (credRet != null) ov.credito_ret = credRet
    if (rebajaIce != null) ov.rebaja_ice = rebajaIce
    if (exencionIce != null) ov.exencion_ice = exencionIce
    if (marcaReb) ov.rebaja_manual = 1
    if (marcaExe) ov.exencion_manual = 1
    if (ventas15 != null) ov.ventas_15 = ventas15
    if (ventas5 != null) ov.ventas_5 = ventas5
    if (ventas0 != null) ov.ventas_0 = ventas0
    if (factorProp != null) ov.factor_prop = factorProp
    return ov
  }

  const icon = tipo === 'ICE' ? '🥃' : '🧾'

  if (!selectedClient) {
    // Solo clientes con el servicio marcado; si aún cargando mostrar todos
    const conServicio = idents_svc
      ? clients.filter((c) => idents_svc.has(c.identificacion))
      : clients
    const q = clientSearch.trim().toLowerCase()
    const clientesFiltrados = q
      ? conServicio.filter((c) => [c.nombre, c.identificacion].some((f) => String(f || '').toLowerCase().includes(q)))
      : conServicio

    return (
      <div className="dc-page">
        <div className="dc-welcome">
          <h1>{icon} Declaración {tipo}</h1>
          <p>
            {idents_svc
              ? `${conServicio.length} contribuyente(s) habilitado(s) para Declaración ${tipo}.`
              : `Selecciona un contribuyente para la Declaración ${tipo}.`}
          </p>
          <button className="dc-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {clients.length > 0 && (
          <>
            <input
              className="dc-client-search"
              placeholder="🔍 Buscar por nombre o RUC…"
              value={clientSearch}
              onChange={(e) => setClientSearch(e.target.value)}
              autoFocus
            />
            {clientesFiltrados.length === 0 ? (
              <div className="dc-empty">
                {conServicio.length === 0
                  ? `Ningún cliente tiene activo el servicio "Declaración ${tipo}". Actívalo en CREDENCIALES SRI.`
                  : `Sin resultados para "${clientSearch}"`}
              </div>
            ) : (
              <div className="dc-grid">
                {clientesFiltrados.map((c) => (
                  <button key={c.id} className="dc-card" onClick={() => selectClient(c.id)}>
                    <div className="dc-card-id">{c.identificacion}</div>
                    <div className="dc-card-name">{c.nombre}</div>
                    <div className="dc-card-per">{periodoLargo(c)}</div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const resumen = decl?.resumen || {}
  const aplazadosPendientes = aplazados.filter((a) => a.estado === 'pendiente')
  const aplazadosVencen = decl?.aplazados_vencen || []
  const aplazadosOtros = aplazadosPendientes.filter((a) =>
    !aplazadosVencen.some((v) => v.id === a.id)
  )
  const hayMontoAPagar = (resumen.iva_a_pagar || 0) > 0 ||
                         (resumen.ice_a_pagar || 0) > 0 ||
                         (resumen.total_a_pagar || 0) > 0

  // Vista previa del aplazamiento: el cálculo lo hace el backend cuando
  // diferirMeses > 0 (se pasa como query param). Acá solo derivamos la fecha
  // de vencimiento y el monto para mostrar el resumen amigable.
  const previewAplazamiento = (() => {
    if (!diferirMeses || diferirMeses < 1) return null
    const m0 = selectedClient.periodo_mes
    const a0 = selectedClient.periodo_anio
    const total = (m0 - 1) + diferirMeses
    const venceMes = (total % 12) + 1
    const venceAnio = a0 + Math.floor(total / 12)
    return {
      montoIvaDiferido: parseFloat(resumen.iva_diferido_actual || 0),
      ventasDiferidas: parseFloat(resumen.ventas_diferidas_monto || 0),
      saldoAFavor: parseFloat(resumen.saldo_a_favor_proximo_mes || 0),
      aPagar: parseFloat(resumen.iva_a_pagar || 0),
      venceMes, venceAnio,
    }
  })()

  const filasDisplay = decl?.filas || []
  const seccionesDisplay = filasDisplay.length
    ? [...new Set(filasDisplay.map((f) => f.seccion))]
    : []

  return (
    <div className="dc-page">
      <header className="dc-header">
        <div>
          <h1>{icon} Declaración {tipo}</h1>
          <p className="dc-sub">
            <strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre} · {nombreMes(selectedClient.periodo_mes)} {selectedClient.periodo_anio}
            {creds?.es_admin && creds?.credencial && (
              <span className="clave-header-tag">
                🔐 <strong>{creds.credencial.username || '—'}</strong>
                {claveSRI && <code className="clave-header-code">{claveSRI}</code>}
              </span>
            )}
          </p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

      {/* Servicios contratados + acceso al portal SRI (punto 4) */}
      {creds && ((creds.servicios && creds.servicios.length > 0) || creds.credencial) && (
        <div className="dc-card-box dc-credit-box">
          <h2 className="dc-h2">🔗 Servicios y acceso SRI del contribuyente</h2>
          {creds.servicios && creds.servicios.length > 0 ? (
            <p className="dc-credit-help" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>Servicios contratados:</span>
              {creds.servicios.map((s) => (
                <span key={s} style={{ background: '#1a5276', color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 600 }}>
                  {SERVICIO_LBL[s] || s}
                </span>
              ))}
            </p>
          ) : (
            <p className="dc-credit-help">Este contribuyente no tiene servicios contratados marcados.</p>
          )}
          {creds.es_admin && creds.credencial && (
            <p className="dc-credit-help" style={{ marginTop: 6 }}>
              🔐 Portal SRI · usuario: <strong>{creds.credencial.username || '—'}</strong>
              {claveSRI && <> · clave: <code>{claveSRI}</code></>}
              {!claveSRI && <span style={{ color: '#94a3b8', fontSize: 12, marginLeft: 6 }}>cargando…</span>}
            </p>
          )}
        </div>
      )}

      {/* ── Fila IVA: Ventas · Crédito anterior · Factor (3 paneles en una línea) ── */}
      {isIVA && decl && (
        <div className="dc-row-triple">
          {/* Ingresos / Ventas */}
          <div className="dc-card-box dc-credit-box">
            <h2 className="dc-h2">🧾 Ingresos / Ventas</h2>
            <p className="dc-credit-help dc-help-sm">
              {resumen.ventas_manual ? 'Override manual activo.' : 'Desde comprobantes. Editá si no tenés XML.'}
            </p>
            <div className="dc-credit-grid">
              <div className="dc-credit-field">
                <label>411 — Base 15%</label>
                {editV15 ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.01" autoFocus
                      defaultValue={resumen.ventas_15 || 0}
                      onBlur={(e) => aplicarOverride('v15', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </div>
                ) : (
                  <div className="dc-credit-value">
                    <strong>{money(resumen.ventas_15 || 0)}</strong>
                    <button className="dc-btn-mini" onClick={() => setEditV15(true)} title="Editar">✎</button>
                    {ventas15 != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('v15')} title="Volver al automático">↺</button>}
                    <span className="dc-hint-arrow">→ 421: {money(resumen.iva_ventas_15 || 0)}</span>
                  </div>
                )}
              </div>
              <div className="dc-credit-field">
                <label>412 — Base 5%</label>
                {editV5 ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.01" autoFocus
                      defaultValue={resumen.ventas_5 || 0}
                      onBlur={(e) => aplicarOverride('v5', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </div>
                ) : (
                  <div className="dc-credit-value">
                    <strong>{money(resumen.ventas_5 || 0)}</strong>
                    <button className="dc-btn-mini" onClick={() => setEditV5(true)} title="Editar">✎</button>
                    {ventas5 != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('v5')} title="Volver al automático">↺</button>}
                    <span className="dc-hint-arrow">→ 422: {money(resumen.iva_ventas_5 || 0)}</span>
                  </div>
                )}
              </div>
              <div className="dc-credit-field">
                <label>413 — Tarifa 0%</label>
                {editV0 ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.01" autoFocus
                      defaultValue={resumen.ventas_0 || 0}
                      onBlur={(e) => aplicarOverride('v0', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </div>
                ) : (
                  <div className="dc-credit-value">
                    <strong>{money(resumen.ventas_0 || 0)}</strong>
                    <button className="dc-btn-mini" onClick={() => setEditV0(true)} title="Editar">✎</button>
                    {ventas0 != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('v0')} title="Volver al automático">↺</button>}
                    <span className="dc-hint-arrow" style={{ color: '#7f8c8d' }}>(sin IVA)</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Crédito tributario del mes anterior */}
          <div className="dc-card-box dc-credit-box">
            <h2 className="dc-h2">🔁 Crédito mes anterior</h2>
            <p className="dc-credit-help dc-help-sm">
              {credAdq != null || credRet != null ? 'Override manual activo.' : 'Pre-cargado del mes anterior (0 si no hay historial).'}
            </p>
            <div className="dc-credit-grid">
              <div className="dc-credit-field">
                <label>605 — Por adquisiciones</label>
                {editAdq ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.01" autoFocus
                      defaultValue={resumen.credito_mes_anterior_adquisiciones || 0}
                      onBlur={(e) => aplicarOverride('adq', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
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
                <label>606 — Por retenciones</label>
                {editRet ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.01" autoFocus
                      defaultValue={resumen.credito_mes_anterior_retenciones || 0}
                      onBlur={(e) => aplicarOverride('ret', e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
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

          {/* Factor de proporcionalidad */}
          <div className="dc-card-box dc-credit-box">
            <h2 className="dc-h2">⚖️ Factor proporcionalidad</h2>
            <p className="dc-credit-help dc-help-sm">
              {factorProp != null ? 'Override manual activo.' : 'Automático: ventas 15% ÷ (15%+0%). Si solo hay 15%, factor = 100%.'}
            </p>
            <div className="dc-credit-grid">
              <div className="dc-credit-field">
                <label>Factor (0 a 1)</label>
                {editFactor ? (
                  <div className="dc-credit-edit">
                    <input type="number" step="0.0001" min="0" max="1" autoFocus
                      defaultValue={resumen.factor_proporcionalidad ?? 1}
                      onBlur={(e) => { const v = parseFloat(e.target.value); setFactorProp(isNaN(v) ? 0 : Math.max(0, Math.min(1, v))); setEditFactor(false) }}
                      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                  </div>
                ) : (
                  <div className="dc-credit-value">
                    <strong>{((resumen.factor_proporcionalidad ?? 1) * 100).toFixed(2)}%</strong>
                    <button className="dc-btn-mini" onClick={() => setEditFactor(true)} title="Editar">✎</button>
                    {factorProp != null && <button className="dc-btn-mini" onClick={() => setFactorProp(null)} title="Volver al automático">↺</button>}
                  </div>
                )}
              </div>
              <div className="dc-credit-field">
                <label>564 — Crédito acreditable</label>
                <div className="dc-credit-value">
                  <strong>{money(resumen.credito_adq_aplicable || 0)}</strong>
                  {(resumen.iva_no_acreditable || 0) > 0 && (
                    <span className="dc-hint-arrow" style={{ color: '#b9770e' }}>
                      no acred.: {money(resumen.iva_no_acreditable)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Rebajas y exenciones ICE — compacto en una sola línea */}
      {!isIVA && decl && (
        <div className="dc-card-box dc-credit-box">
          <h2 className="dc-h2">⚖️ Rebajas y exenciones</h2>
          {(resumen.advertencias || []).map((a, i) => (
            <p key={i} className="dc-credit-help" style={{ color: '#b9770e', fontWeight: 600, marginBottom: 6 }}>{a}</p>
          ))}
          <div className="dc-rebajas-row">
            {/* ── Rebaja 50% ── */}
            <label className="dc-aplazar-control" title="Aplica el 50% de la tarifa específica total sin el cálculo del módulo">
              <input type="checkbox" checked={marcaReb} disabled={rebajaIce != null}
                onChange={(e) => setMarcaReb(e.target.checked)} />
              Rebaja 50%
            </label>
            <div className="dc-credit-field">
              <label className="dc-rebajas-lbl">(−) Rebaja tarifa específica</label>
              {editReb ? (
                <div className="dc-credit-edit">
                  <input type="number" step="0.01" autoFocus
                    defaultValue={resumen.rebaja_ice || 0}
                    onBlur={(e) => aplicarOverride('reb', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                </div>
              ) : (
                <div className="dc-credit-value">
                  <strong>{money(resumen.rebaja_ice || 0)}</strong>
                  <button className="dc-btn-mini" onClick={() => setEditReb(true)} title="Editar">✎</button>
                  {rebajaIce != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('reb')} title="Volver al automático">↺</button>}
                </div>
              )}
            </div>

            <div className="dc-rebajas-sep" />

            {/* ── Exención ── */}
            <label className="dc-aplazar-control" title="Exonera el ICE restante del período sin el cálculo del módulo">
              <input type="checkbox" checked={marcaExe} disabled={exencionIce != null}
                onChange={(e) => setMarcaExe(e.target.checked)} />
              Exención
            </label>
            <div className="dc-credit-field">
              <label className="dc-rebajas-lbl">(−) Exenciones</label>
              {editExe ? (
                <div className="dc-credit-edit">
                  <input type="number" step="0.01" autoFocus
                    defaultValue={resumen.exencion_ice || 0}
                    onBlur={(e) => aplicarOverride('exe', e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                </div>
              ) : (
                <div className="dc-credit-value">
                  <strong>{money(resumen.exencion_ice || 0)}</strong>
                  <button className="dc-btn-mini" onClick={() => setEditExe(true)} title="Editar">✎</button>
                  {exencionIce != null && <button className="dc-btn-mini" onClick={() => limpiarOverride('exe')} title="Volver al automático">↺</button>}
                </div>
              )}
            </div>

            {/* ── Nota de estado ── */}
            <span className="dc-rebajas-hint">
              {rebajaIce != null || exencionIce != null
                ? 'Override manual'
                : (resumen.productos_con_rebaja || []).length > 0 || (resumen.productos_exentos || []).length > 0
                  ? 'Auto desde módulo'
                  : 'Sin productos calificados'}
            </span>
          </div>

          {/* Detalle de productos (solo si hay) */}
          {!rebajaIce && !exencionIce && ((resumen.productos_exentos || []).length > 0 || (resumen.productos_con_rebaja || []).length > 0) && (
            <p className="dc-credit-help" style={{ marginTop: 6 }}>
              {(resumen.productos_exentos || []).length > 0 && <>Exentos: <strong>{resumen.productos_exentos.map((p) => p.producto).join(', ')}</strong>. </>}
              {(resumen.productos_con_rebaja || []).length > 0 && <>Rebaja: <strong>{resumen.productos_con_rebaja.map((p) => p.producto).join(', ')}</strong>.</>}
            </p>
          )}
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

      {/* Vista previa del aplazamiento — cálculo real desde backend (casillero 481/484 SRI) */}
      {previewAplazamiento && (
        <div className="dc-aplazar-preview">
          <div className="dc-aplazar-preview-head">
            🔄 <strong>Efecto del aplazamiento ({diferirMeses} mes{diferirMeses > 1 ? 'es' : ''})</strong>
            <span className="dc-aplazar-preview-tag">borrador · cálculo SRI 481/484</span>
          </div>
          <div className="dc-aplazar-preview-grid">
            <div>
              <span className="dc-aplazar-preview-lbl">481 — Ventas con cobro diferido</span>
              <span className="dc-aplazar-preview-val">{money(previewAplazamiento.ventasDiferidas)}</span>
            </div>
            <div>
              <span className="dc-aplazar-preview-lbl">484 — IVA diferido (no se causa hoy)</span>
              <span className="dc-aplazar-preview-val warn">{money(previewAplazamiento.montoIvaDiferido)}</span>
            </div>
            <div>
              <span className="dc-aplazar-preview-lbl">{previewAplazamiento.saldoAFavor > 0 ? '699 — Saldo a favor próximo mes' : '902 — IVA a pagar HOY'}</span>
              <span className={`dc-aplazar-preview-val ${previewAplazamiento.saldoAFavor > 0 ? 'good' : 'warn'}`}>
                {money(previewAplazamiento.saldoAFavor > 0 ? previewAplazamiento.saldoAFavor : previewAplazamiento.aPagar)}
              </span>
            </div>
            <div>
              <span className="dc-aplazar-preview-lbl">El 484 vencerá en</span>
              <span className="dc-aplazar-preview-val">📅 {nombreMes(previewAplazamiento.venceMes)} {previewAplazamiento.venceAnio}</span>
            </div>
          </div>
          <p className="dc-aplazar-preview-note">
            {previewAplazamiento.saldoAFavor > 0 ? (
              <>El crédito tributario disponible (compras + arrastre + retenciones) es <strong>mayor</strong> al
              impuesto causado neto, por lo que este período <strong>no hay pago</strong> y queda saldo a favor
              de <strong>{money(previewAplazamiento.saldoAFavor)}</strong> para el siguiente mes.</>
            ) : (
              <>El causado neto supera al crédito, por lo que igual queda IVA a pagar de
              <strong> {money(previewAplazamiento.aPagar)}</strong> este período.</>
            )}
            {' '}En <strong>{nombreMes(previewAplazamiento.venceMes)} {previewAplazamiento.venceAnio}</strong> el
            IVA diferido entrará automáticamente como casillero 480. Cambiá el dropdown a "No aplazar" para deshacer.
          </p>
        </div>
      )}

      {decl && (
        <div className="dc-conteos">
          🧾 Comprobantes del período —{' '}
          {isIVA ? (
            <>
              Ventas: <strong>{(resumen.num_ventas_ice || 0) + (resumen.num_ventas_iva_solo || 0)}</strong> ·{' '}
              Compras: <strong>{resumen.num_facturas_ejercicio || 0}</strong> ·{' '}
              Retenciones: <strong>{resumen.num_retenciones_periodo || 0}</strong> ·{' '}
              Total: <strong>{(resumen.num_ventas_ice || 0) + (resumen.num_ventas_iva_solo || 0) + (resumen.num_facturas_ejercicio || 0) + (resumen.num_retenciones_periodo || 0)}</strong>
            </>
          ) : (
            <>Registros ICE: <strong>{resumen.num_registros || 0}</strong></>
          )}
        </div>
      )}

      {loading ? (
        <div className="dc-empty">Calculando…</div>
      ) : !decl ? (
        <div className="dc-empty">Sin datos.</div>
      ) : (
        <div className="dc-card-box">
          <table className="dc-table dc-table-sri">
            <thead><tr><th>Código SRI</th><th>Concepto</th><th className="r"># Fact.</th><th className="r">Valor</th></tr></thead>
            <tbody>
              {seccionesDisplay.map((sec) => (
                <Fragment key={sec}>
                  <tr className="dc-sec"><td colSpan={4}>{sec}</td></tr>
                  {filasDisplay.filter((f) => f.seccion === sec).map((f, i) => {
                    const esCasilleroAplazado = ['480', '481', '484', '609.X', '699'].includes(f.codigo)
                    const esTotal = TOTALES_SRI.has(f.codigo)
                    return (
                      <tr key={sec + i} className={`${f.seccion === 'RESULTADO' ? 'dc-res' : ''} ${esTotal ? 'dc-total' : ''} ${esCasilleroAplazado ? 'dc-row-diferido' : ''}`}>
                        <td className="dc-cod">{f.codigo}</td>
                        <td>{f.concepto}</td>
                        <td className="r">{f.num_comprobantes != null ? f.num_comprobantes : ''}</td>
                        <td className="r">{money(f.valor)}</td>
                      </tr>
                    )
                  })}
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
