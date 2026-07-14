import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { devolucionesIvaAPI, downloadBlob } from '../services/api'
import { fmtMoney } from '../utils/format'
import { nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import WorkflowGuide from '../components/WorkflowGuide'
import './DevolucionesIva.css'

const DV_STEPS = [
  { icon: '📥', label: 'Gastos (subir TXT/XML)', path: '/' },
  { icon: '📄', label: 'Declaraciones IVA', path: '/declaracion-iva' },
  { icon: '👵', label: 'Devolución IVA', current: true },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

const ESTADO_LABEL = {
  borrador: '📝 Borrador',
  presentada: '📤 Presentada',
  aprobada: '✅ Aprobada',
  rechazada: '❌ Rechazada',
}

export default function DevolucionesIvaTerceraEdad() {
  const { openNewClient } = useOutletContext()
  const { selectedClient, identsForSvc } = useClients()
  const idents_svc = identsForSvc('devolucion_iva')

  const [comps, setComps] = useState([])
  const [periodo, setPeriodo] = useState('')
  const [anio, setAnio] = useState(null)
  const [seleccion, setSeleccion] = useState(() => new Set())
  const [tipo, setTipo] = useState('tercera_edad')
  const [porcentaje, setPorcentaje] = useState('')
  const [params, setParams] = useState(null)
  const [solicitudes, setSolicitudes] = useState([])
  const [solicitudActual, setSolicitudActual] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [msg, setMsg] = useState(null) // { tipo: 'ok'|'err', texto }

  const clientId = selectedClient?.id

  const cargar = useCallback(async () => {
    if (!clientId) return
    setCargando(true)
    setMsg(null)
    try {
      const [rc, rs] = await Promise.all([
        devolucionesIvaAPI.comprobantes(clientId),
        devolucionesIvaAPI.solicitudes(clientId),
      ])
      setComps(rc.data.comprobantes || [])
      setPeriodo(rc.data.periodo || '')
      setAnio(rc.data.anio)
      setSolicitudes(rs.data.data || [])
      const sol = rc.data.solicitud
      setSolicitudActual(sol || null)
      setSeleccion(new Set(rc.data.seleccionados || []))
      if (sol) {
        setTipo(sol.tipo_beneficiario || 'tercera_edad')
        setPorcentaje(sol.porcentaje_discapacidad ?? '')
      }
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron cargar los comprobantes.' })
    } finally {
      setCargando(false)
    }
  }, [clientId])

  useEffect(() => { cargar() }, [cargar])

  // Tope mensual según año del período y tipo de beneficiario
  useEffect(() => {
    if (!anio) return
    devolucionesIvaAPI.parametros(anio, tipo, tipo === 'discapacidad' ? porcentaje || null : null)
      .then((r) => setParams(r.data))
      .catch(() => setParams(null))
  }, [anio, tipo, porcentaje])

  const totales = useMemo(() => {
    let base = 0; let iva = 0
    for (const c of comps) {
      if (seleccion.has(c.id)) { base += c.base; iva += c.iva }
    }
    const tope = params?.tope_mensual ?? 0
    return {
      base: Math.round(base * 100) / 100,
      iva: Math.round(iva * 100) / 100,
      tope,
      solicitar: Math.round(Math.min(iva, tope) * 100) / 100,
      excedente: Math.round(Math.max(0, iva - tope) * 100) / 100,
    }
  }, [comps, seleccion, params])

  const toggle = (id) => {
    setSeleccion((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id); else s.add(id)
      return s
    })
  }

  const toggleTodos = () => {
    setSeleccion((prev) => (prev.size === comps.length ? new Set() : new Set(comps.map((c) => c.id))))
  }

  const guardar = async () => {
    if (!seleccion.size) {
      setMsg({ tipo: 'err', texto: 'Marca al menos un comprobante.' })
      return
    }
    setGuardando(true)
    setMsg(null)
    try {
      const r = await devolucionesIvaAPI.guardar({
        client_id: clientId,
        tipo_beneficiario: tipo,
        porcentaje_discapacidad: tipo === 'discapacidad' ? Number(porcentaje) : null,
        invoice_ids: [...seleccion],
      })
      const extra = r.data.excedente > 0
        ? ` OJO: el IVA marcado supera el tope en ${fmtMoney(r.data.excedente)}; se solicita el tope.`
        : ''
      setMsg({ tipo: 'ok', texto: `Solicitud guardada: ${fmtMoney(r.data.monto_solicitado)} a solicitar.${extra}` })
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo guardar la solicitud.' })
    } finally {
      setGuardando(false)
    }
  }

  const exportar = async (sol) => {
    try {
      const r = await devolucionesIvaAPI.exportExcel(sol.id)
      downloadBlob(r.data, `DevolucionIVA_${selectedClient.identificacion}_${sol.anio}-${String(sol.mes).padStart(2, '0')}.xlsx`)
    } catch {
      setMsg({ tipo: 'err', texto: 'No se pudo exportar el Excel.' })
    }
  }

  const cambiarEstado = async (sol, estado) => {
    try {
      await devolucionesIvaAPI.cambiarEstado(sol.id, estado)
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo cambiar el estado.' })
    }
  }

  const eliminar = async (sol) => {
    if (!window.confirm(`¿Eliminar la solicitud de ${String(sol.mes).padStart(2, '0')}/${sol.anio}?`)) return
    try {
      await devolucionesIvaAPI.eliminar(sol.id)
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo eliminar.' })
    }
  }

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon="👵" title="Devolución IVA" subtitle="Devolución para adultos mayores y personas con discapacidad" idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Devolución IVA" />
  }

  return (
    <div className="dv-page">
      <WorkflowGuide steps={DV_STEPS} />
      <header className="dv-header">
        <div>
          <h1>👵 Devolución IVA — Adultos mayores y discapacidad</h1>
          <p className="dv-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre} · Período {periodo || '—'}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      {msg && <div className={`dv-msg ${msg.tipo}`}>{msg.texto}</div>}

      <div className="dv-toolbar">
        <label>
          Beneficiario:{' '}
          <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="tercera_edad">Adulto mayor (65+)</option>
            <option value="discapacidad">Persona con discapacidad</option>
          </select>
        </label>
        {tipo === 'discapacidad' && (
          <label>
            % discapacidad:{' '}
            <input type="number" min="30" max="100" value={porcentaje}
              onChange={(e) => setPorcentaje(e.target.value)} style={{ width: 70 }} />
          </label>
        )}
        {params && (
          <span className="dv-tope">
            Tope mensual {anio}: <strong>{fmtMoney(params.tope_mensual)}</strong>
            {' '}(IVA {Math.round(params.iva_tarifa * 100)}% de hasta {params.base_max_rbu} RBU de {fmtMoney(params.rbu)})
          </span>
        )}
      </div>

      <div className="dv-resumen">
        <div className="dv-res-card"><span>Comprobantes marcados</span><strong>{seleccion.size} / {comps.length}</strong></div>
        <div className="dv-res-card"><span>Base gravada</span><strong>{fmtMoney(totales.base)}</strong></div>
        <div className="dv-res-card"><span>IVA marcado</span><strong>{fmtMoney(totales.iva)}</strong></div>
        <div className={`dv-res-card destacado ${totales.excedente > 0 ? 'alerta' : ''}`}>
          <span>IVA a solicitar</span><strong>{fmtMoney(totales.solicitar)}</strong>
          {totales.excedente > 0 && <em>supera el tope en {fmtMoney(totales.excedente)}</em>}
        </div>
        <button className="dv-btn primary" onClick={guardar} disabled={guardando || !seleccion.size}>
          {guardando ? 'Guardando…' : (solicitudActual ? '💾 Actualizar solicitud' : '💾 Guardar solicitud')}
        </button>
      </div>

      {cargando ? (
        <p className="dv-cargando">Cargando comprobantes…</p>
      ) : comps.length === 0 ? (
        <div className="dv-stub-box">
          <h2>Sin comprobantes en el período</h2>
          <p>
            Primero sube las facturas del mes en <strong>Gastos</strong> (TXT del SRI o XML), o bájalas
            automáticamente con el descargador local:
          </p>
          <p><code>python descargar.py comprobantes --ruc {selectedClient.identificacion} --anio {anio || 'AAAA'} --mes MM --upload</code></p>
        </div>
      ) : (
        <div className="dv-tabla-wrap">
          <table className="dv-tabla">
            <thead>
              <tr>
                <th><input type="checkbox" checked={seleccion.size === comps.length && comps.length > 0} onChange={toggleTodos} title="Marcar/desmarcar todos" /></th>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Clasificación</th>
                <th className="num">Base gravada</th>
                <th className="num">IVA</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c) => (
                <tr key={c.id} className={seleccion.has(c.id) ? 'sel' : ''} onClick={() => toggle(c.id)}>
                  <td><input type="checkbox" checked={seleccion.has(c.id)} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>{c.fecha}</td>
                  <td title={c.ruc_proveedor}>{c.nombre_proveedor}</td>
                  <td>{c.clasificacion || 'SIN CLASIFICAR'}</td>
                  <td className="num">{fmtMoney(c.base)}</td>
                  <td className="num">{fmtMoney(c.iva)}</td>
                  <td className="num">{fmtMoney(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {solicitudes.length > 0 && (
        <section className="dv-historial">
          <h2>📚 Solicitudes guardadas</h2>
          <table className="dv-tabla">
            <thead>
              <tr>
                <th>Período</th><th>Beneficiario</th><th className="num">IVA marcado</th>
                <th className="num">Tope</th><th className="num">Solicitado</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {solicitudes.map((s) => (
                <tr key={s.id}>
                  <td>{nombreMes(s.mes)} {s.anio}</td>
                  <td>{s.tipo_beneficiario === 'discapacidad' ? `Discapacidad ${s.porcentaje_discapacidad || ''}%` : 'Adulto mayor'}</td>
                  <td className="num">{fmtMoney(s.total_iva)}</td>
                  <td className="num">{fmtMoney(s.tope_mensual)}</td>
                  <td className="num"><strong>{fmtMoney(s.monto_solicitado)}</strong></td>
                  <td>
                    <select value={s.estado} onChange={(e) => cambiarEstado(s, e.target.value)}>
                      {Object.entries(ESTADO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td className="dv-acciones">
                    <button className="dv-btn" onClick={() => exportar(s)} title="Exportar Excel">📥 Excel</button>
                    <button className="dv-btn" onClick={() => eliminar(s)} title="Eliminar">🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
