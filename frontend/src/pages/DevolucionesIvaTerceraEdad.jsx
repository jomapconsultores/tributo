import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { devolucionesIvaAPI, downloadBlob } from '../services/api'
import { fmtMoney } from '../utils/format'
import { nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import WorkflowGuide from '../components/WorkflowGuide'
import { setEnviadorDevolucionHref, SRI_DEVOLUCION_URL } from '../utils/enviadorDevolucion'
import BajadorSRI from '../components/BajadorSRI'
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

// Mes (1-12) de un comprobante por su fecha 'dd/mm/aaaa' (o 'aaaa-mm-dd').
function mesDeFecha(fecha) {
  const s = String(fecha || '').trim()
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[3], 10) }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[1], 10) }
  return { mes: null, anio: null }
}

export default function DevolucionesIvaTerceraEdad() {
  const { openNewClient } = useOutletContext()
  const { selectedClient, identsForSvc } = useClients()
  const idents_svc = identsForSvc('devolucion_iva')

  const [comps, setComps] = useState([])
  const [periodo, setPeriodo] = useState('')
  const [anio, setAnio] = useState(null)
  const [meses, setMeses] = useState([])          // meses que cubre el período (6 si es semestral)
  const [rubros, setRubros] = useState([])        // catálogo de tipos de gasto
  const [rubroDe, setRubroDe] = useState({})      // invoice_id → rubro elegido
  const [seleccion, setSeleccion] = useState(() => new Set())
  const [tipo, setTipo] = useState('tercera_edad')
  const [porcentaje, setPorcentaje] = useState('')
  const [params, setParams] = useState(null)
  const [solicitudes, setSolicitudes] = useState([])
  const [solicitudActual, setSolicitudActual] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [verEnviador, setVerEnviador] = useState(false)
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
      const lista = rc.data.comprobantes || []
      setComps(lista)
      setPeriodo(rc.data.periodo || '')
      setAnio(rc.data.anio)
      setMeses(rc.data.meses || [])
      setRubros(rc.data.rubros || [])
      // Rubro por comprobante: el guardado en la solicitud, o el sugerido por la
      // clasificación del proveedor.
      setRubroDe(Object.fromEntries(lista.map((c) => [c.id, c.rubro || c.rubro_sugerido])))
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

  const r2 = (n) => Math.round(n * 100) / 100

  // El tope de la devolución es MENSUAL, así que se aplica mes a mes: un período
  // semestral tiene seis topes y el excedente de un mes no usa el cupo de otro.
  const totales = useMemo(() => {
    const topeMes = params?.tope_mensual ?? 0
    const lista = meses.length ? meses : []
    const ancla = lista.length ? lista[lista.length - 1] : null
    const porMes = new Map(lista.map((m) => [m, { mes: m, comprobantes: 0, base: 0, iva: 0 }]))
    let sueltos = { base: 0, iva: 0 }
    for (const c of comps) {
      if (!seleccion.has(c.id)) continue
      const f = mesDeFecha(c.fecha)
      const destino = (porMes.has(f.mes) && (!anio || f.anio === anio)) ? f.mes : ancla
      if (destino == null) { sueltos.base += c.base; sueltos.iva += c.iva; continue }
      const d = porMes.get(destino)
      d.comprobantes += 1; d.base += c.base; d.iva += c.iva
    }
    const detalle = [...porMes.values()].map((d) => ({
      ...d, base: r2(d.base), iva: r2(d.iva), tope: topeMes,
      solicitar: r2(Math.min(d.iva, topeMes)), excedente: r2(Math.max(0, d.iva - topeMes)),
    }))
    const base = r2(detalle.reduce((s, d) => s + d.base, 0) + sueltos.base)
    const iva = r2(detalle.reduce((s, d) => s + d.iva, 0) + sueltos.iva)
    return {
      detalle, base, iva, topeMes,
      tope: r2(topeMes * (lista.length || 1)),
      solicitar: r2(detalle.reduce((s, d) => s + d.solicitar, 0)),
      excedente: r2(detalle.reduce((s, d) => s + d.excedente, 0)),
    }
  }, [comps, seleccion, params, meses, anio])

  // A qué tipo de gasto se direccionó lo marcado (resumen para revisar antes de enviar).
  const porRubro = useMemo(() => {
    const acc = new Map()
    for (const c of comps) {
      if (!seleccion.has(c.id)) continue
      const k = rubroDe[c.id] || c.rubro_sugerido || 'otros'
      const a = acc.get(k) || { rubro: k, comprobantes: 0, iva: 0 }
      a.comprobantes += 1; a.iva += c.iva
      acc.set(k, a)
    }
    const orden = rubros.map((r) => r.key)
    return [...acc.values()]
      .map((a) => ({ ...a, iva: r2(a.iva), label: rubros.find((r) => r.key === a.rubro)?.label || a.rubro }))
      .sort((a, b) => orden.indexOf(a.rubro) - orden.indexOf(b.rubro))
  }, [comps, seleccion, rubroDe, rubros])

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
      const ids = [...seleccion]
      const r = await devolucionesIvaAPI.guardar({
        client_id: clientId,
        tipo_beneficiario: tipo,
        porcentaje_discapacidad: tipo === 'discapacidad' ? Number(porcentaje) : null,
        invoice_ids: ids,
        rubros: Object.fromEntries(ids.map((id) => [id, rubroDe[id] || 'otros'])),
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
      const sufijo = selectedClient.periodicidad === 'semestral'
        ? `${sol.anio}-S${sol.mes <= 6 ? 1 : 2}`
        : `${sol.anio}-${String(sol.mes).padStart(2, '0')}`
      downloadBlob(r.data, `DevolucionIVA_${selectedClient.identificacion}_${sufijo}.xlsx`)
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

  // Enviar al SRI: el envío ocurre DENTRO del portal (sesión del contribuyente),
  // así que la app deja el paquete de la solicitud en el portapapeles para el
  // enviador que corre allá, abre el portal y registra el envío.
  const enviar = async (sol) => {
    setMsg(null)
    try {
      const r = await devolucionesIvaAPI.envio(sol.id)
      const paquete = JSON.stringify(r.data)
      let copiado = true
      try {
        await navigator.clipboard.writeText(paquete)
      } catch { copiado = false }
      const seguir = window.confirm(
        `📤 Enviar al SRI la devolución de ${r.data.periodo.etiqueta}\n` +
        `${r.data.contribuyente.nombre} (${r.data.contribuyente.identificacion})\n` +
        `${r.data.items.length} comprobante(s) · a solicitar ${fmtMoney(r.data.totales.solicitado)}\n\n` +
        (copiado
          ? 'El paquete de la solicitud quedó COPIADO en el portapapeles.\n\n'
          : '⚠ No se pudo copiar automáticamente: exportá el Excel y usalo como respaldo.\n\n') +
        'En el portal del SRI (Devoluciones → Devolución de IVA), tocá el marcador\n' +
        '"📤 Enviador-DEVOLUCIÓN" y pegá el paquete en el panel que se abre.\n\n' +
        '¿Abrir ahora el portal del SRI en otra pestaña?'
      )
      if (seguir) window.open(SRI_DEVOLUCION_URL, '_blank', 'noopener')
      if (window.confirm('¿Marcar esta solicitud como PRESENTADA al SRI?\n\n' +
                         '(Hacelo cuando el portal ya te haya confirmado el envío.)')) {
        await devolucionesIvaAPI.marcarEnviada(sol.id)
        setMsg({ tipo: 'ok', texto: 'Solicitud marcada como presentada al SRI.' })
        cargar()
      }
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo preparar el envío.' })
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
        <a
          ref={setEnviadorDevolucionHref}
          className="dv-enviador"
          draggable="true"
          onClick={(e) => { e.preventDefault(); setVerEnviador(true) }}
          title="Script que carga la solicitud dentro del portal del SRI: tocalo para copiarlo o instalarlo."
        >📤 Enviador-DEVOLUCIÓN (SRI)</a>
        {params && (
          <span className="dv-tope">
            Tope mensual {anio}: <strong>{fmtMoney(params.tope_mensual)}</strong>
            {' '}(IVA {Math.round(params.iva_tarifa * 100)}% de hasta {params.base_max_rbu} RBU de {fmtMoney(params.rbu)})
            {meses.length > 1 && (
              <> · período de {meses.length} meses → tope total <strong>{fmtMoney(totales.tope)}</strong></>
            )}
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

      {seleccion.size > 0 && porRubro.length > 0 && (
        <div className="dv-rubros-resumen">
          <span className="dv-rubros-lbl">Direccionado a:</span>
          {porRubro.map((r) => (
            <span key={r.rubro} className="dv-rubro-chip" title={`${r.comprobantes} comprobante(s)`}>
              {r.label} · <strong>{fmtMoney(r.iva)}</strong>
            </span>
          ))}
        </div>
      )}

      {meses.length > 1 && seleccion.size > 0 && (
        <div className="dv-tabla-wrap dv-meses">
          <table className="dv-tabla">
            <thead>
              <tr>
                <th>Mes</th><th className="num">Comprobantes</th><th className="num">Base</th>
                <th className="num">IVA</th><th className="num">Tope del mes</th>
                <th className="num">A solicitar</th><th className="num">Excedente</th>
              </tr>
            </thead>
            <tbody>
              {totales.detalle.map((d) => (
                <tr key={d.mes} className={d.excedente > 0 ? 'alerta' : (d.comprobantes === 0 ? 'dv-mes-vacio' : '')}>
                  <td>{nombreMes(d.mes)}</td>
                  <td className="num">{d.comprobantes}</td>
                  <td className="num">{fmtMoney(d.base)}</td>
                  <td className="num">{fmtMoney(d.iva)}</td>
                  <td className="num">{fmtMoney(d.tope)}</td>
                  <td className="num"><strong>{fmtMoney(d.solicitar)}</strong></td>
                  <td className="num">{d.excedente > 0 ? fmtMoney(d.excedente) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dv-nota-meses">
            El tope es <strong>mensual</strong>: se aplica mes a mes y lo que sobra en un mes no
            usa el cupo de otro. Los comprobantes sin fecha legible se imputan al último mes del período.
          </p>
        </div>
      )}

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
                <th>Tipo de gasto</th>
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
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="dv-rubro"
                      value={rubroDe[c.id] || c.rubro_sugerido || 'otros'}
                      onChange={(e) => setRubroDe((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      title="Tipo de gasto al que se direcciona este comprobante en la solicitud"
                    >
                      {rubros.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </td>
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
                  <td>{selectedClient.periodicidad === 'semestral'
                    ? `${s.mes <= 6 ? '1er' : '2do'} semestre ${s.anio}`
                    : `${nombreMes(s.mes)} ${s.anio}`}</td>
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
                    <button className="dv-btn primary" onClick={() => enviar(s)}
                      title="Preparar el envío al portal del SRI y registrarlo">📤 Enviar al SRI</button>
                    <button className="dv-btn" onClick={() => exportar(s)} title="Exportar Excel">📥 Excel</button>
                    <button className="dv-btn" onClick={() => eliminar(s)} title="Eliminar">🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {verEnviador && <BajadorSRI which="devolucion" onClose={() => setVerEnviador(false)} />}
    </div>
  )
}
