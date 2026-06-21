import { useState, useEffect, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { rebajasAPI, productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import WorkflowGuide from '../components/WorkflowGuide'
import useDraft from '../hooks/useDraft'
import './RebajasExenciones.css'

const RE_STEPS = [
  { icon: '📚', label: 'Catálogo Productos', path: '/catalogo-productos' },
  { icon: '🧮', label: 'Cálculo ICE', path: '/calculo-ice' },
  { icon: '⚖️', label: 'Rebajas y Exenciones', current: true },
  { icon: '🥃', label: 'ICE XML', path: '/ice' },
  { icon: '📄', label: 'Declaraciones ICE', path: '/declaracion-ice' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

const EMPTY = { ingrediente: '', ruc_proveedor: '', proveedor_nombre: '', cantidad: '', unidad: 'ml', origen: 'NACIONAL', calificado: false }
const esAgua = (nombre) => (nombre || '').trim().toUpperCase() === 'AGUA'
const MINPROD = 'https://servicios.produccion.gob.ec/rum/publico/consultaCategorizacion.jsf'
const UMBRAL = 70 // % mínimo de materia prima nacional calificada

export default function RebajasExenciones() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient, identsForSvc } = useClients()
  const ident = selectedClient?.identificacion
  const idents_svc = identsForSvc('declaracion_ice')

  const [productos, setProductos] = useState([])
  const [producto, setProducto] = useState('')
  const [ings, setIngs] = useState([])
  const [form, setForm] = useDraft(ident && producto ? `draft:rebajas:form:${ident}:${producto}` : null, EMPTY)
  const [verif, setVerif] = useState(null) // { estado, texto }
  // Condiciones normativas del producto (Art. 82/77 LRTI, Art. 199.4/199.5 RLRTI)
  const [cond, setCond] = useState({ es_cerveza: false, nueva_marca: false, cupo_anual_sri: false })

  const verificarRuc = async () => {
    const ruc = (form.ruc_proveedor || '').trim()
    if (!ruc) { alert('Ingresa el RUC del proveedor.'); return }
    setVerif({ estado: 'wait', texto: 'Consultando Ministerio de Producción y SRI…' })
    try {
      const r = await rebajasAPI.verificarRuc(ruc)
      const d = r.data
      const nombre = d.razon_social || '—'
      setForm((f) => ({ ...f, calificado: d.cumple === true, proveedor_nombre: d.razon_social || f.proveedor_nombre }))
      let estado = 'wait', texto = `⚠ ${d.mensaje}${nombre !== '—' ? ' · ' + nombre : ''}`
      if (d.cumple) { estado = 'ok'; texto = `✔ Cumple · ${nombre} · ${d.categoria}${d.vigencia ? ' · ' + d.vigencia : ''}` }
      else if (d.calificado === true) { estado = 'no'; texto = `✗ No cumple · ${nombre} · categorizado como ${d.categoria} (no es MIPYME)` }
      else if (d.calificado === false) { estado = 'no'; texto = `✗ No cumple · ${nombre} · no categorizado en el Ministerio${d.tipo ? ' · ' + d.tipo : ''}` }
      setVerif({ estado, texto })
    } catch (e) {
      setVerif({ estado: 'wait', texto: 'Error al verificar: ' + (e.response?.data?.detail || e.message) })
    }
  }

  // Productos del catálogo del cliente
  useEffect(() => {
    if (!ident) { setProductos([]); return }
    productsAPI.list(ident).then((r) => setProductos(r.data?.data || [])).catch(() => setProductos([]))
  }, [ident])

  const loadIngs = useCallback(async () => {
    if (!ident || !producto) { setIngs([]); return }
    const res = await rebajasAPI.list(ident, producto)
    setIngs(res.data?.data || [])
  }, [ident, producto])
  useEffect(() => { loadIngs() }, [loadIngs])

  // Condiciones normativas guardadas del producto
  useEffect(() => {
    setCond({ es_cerveza: false, nueva_marca: false, cupo_anual_sri: false })
    if (!ident || !producto) return
    rebajasAPI.getCondiciones(ident, producto).then((r) => {
      const d = (r.data?.data || [])[0]
      if (d) setCond({ es_cerveza: !!d.es_cerveza, nueva_marca: !!d.nueva_marca, cupo_anual_sri: !!d.cupo_anual_sri })
    }).catch(() => {})
  }, [ident, producto])

  const setCondicion = async (campo, valor) => {
    const nuevo = { ...cond, [campo]: valor }
    setCond(nuevo)
    try {
      await rebajasAPI.setCondiciones({ identificacion: ident, producto, ...nuevo })
    } catch (e) { alert('Error al guardar la condición: ' + (e.response?.data?.detail || e.message)) }
  }

  const agregar = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    if (!form.ingrediente.trim()) { alert('Ingresa el ingrediente.'); return }
    try {
      await rebajasAPI.create({ identificacion: ident, producto, ...form, cantidad: parseFloat(form.cantidad) || 0 })
      setForm(EMPTY)
      await loadIngs()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    try { await rebajasAPI.delete(id); await loadIngs() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const resumen = useMemo(() => {
    const sum = (arr) => arr.reduce((s, i) => s + (parseFloat(i.cantidad) || 0), 0)
    const noAgua = ings.filter((i) => !esAgua(i.ingrediente))
    const total = sum(noAgua)
    const calif = sum(noAgua.filter((i) => i.calificado))
    const pct = total ? (calif / total) * 100 : 0
    return { total, calif, pct, cumple: pct >= UMBRAL }
  }, [ings])

  // Incidencia (%) de cada fila: agua = 0, no calificado = 0, resto = cantidad/total
  const incidencia = (i) => {
    if (esAgua(i.ingrediente) || !i.calificado || !resumen.total) return 0
    return (parseFloat(i.cantidad) || 0) / resumen.total * 100
  }

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon="⚖️" title="Rebajas y Exenciones" subtitle="Porcentaje de materia prima nacional — Art. 82 LRTI" idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Declaración ICE" />
  }

  return (
    <div className="re-page">
      <WorkflowGuide steps={RE_STEPS} />
      <header className="re-header">
        <div>
          <h1>⚖️ Rebajas y exenciones</h1>
          <p className="re-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      <div className="re-prodsel">
        <label>Producto</label>
        <input
          list="re-prod-list"
          value={producto}
          onChange={(e) => setProducto(e.target.value.toUpperCase())}
          placeholder="Escribe el producto o elígelo del catálogo…"
        />
        <datalist id="re-prod-list">
          {productos.map((p) => <option key={p.id} value={p.nombre} />)}
        </datalist>
        <span className="re-hint">Puedes elegir uno del catálogo del cliente o escribir el nombre.</span>
      </div>

      {/* Normas de aplicación (arriba) */}
      <details className="re-normas" open>
        <summary>📖 Normas de aplicación</summary>
        <div className="re-normas-body">
          <p><strong>Rebaja / exención de ICE por componente nacional.</strong> El beneficio aplica cuando la bebida se elabora con al menos <strong>{UMBRAL}%</strong> de materia prima nacional adquirida a <strong>artesanos, micro, pequeñas o medianas empresas (MIPYME) u organizaciones de la economía popular y solidaria</strong>, categorizados por el Ministerio de Producción.</p>
          <ul>
            <li>Al pulsar <strong>🔎 Verificar</strong> se consulta el RUC en el Ministerio: si está categorizado como <strong>MIPYME/artesano</strong> → <strong>cumple</strong>; si es <strong>"NO MIPYME"</strong> (empresa grande) → <strong>no cumple</strong>, aunque esté categorizado.</li>
            <li>Si el RUC <strong>no está</strong> en el Ministerio, se consulta el <strong>SRI</strong> para obtener la razón social/nombre (y queda como "no cumple").</li>
            <li>El <strong>agua no se contabiliza</strong> (incidencia 0%); un proveedor que <strong>no cumple</strong> tiene incidencia <strong>0%</strong>.</li>
            <li>El <strong>%</strong> de cada fila = cantidad ÷ total (sin agua); la suma debe ser ≥ {UMBRAL}%.</li>
          </ul>
          <p className="re-normas-nota">Fundamento: LRTI — rebaja de hasta 50% de la tarifa específica para bebidas con materia prima nacional de proveedores MIPYME/artesanos; la exención no aplica si el contenido nacional es menor al 70%. Verifica la normativa vigente antes de aplicar el beneficio.</p>
        </div>
      </details>

      {selectedClient && (
        <>
          <div className="re-form">
            <label className="re-f"><span>RUC proveedor</span>
              <input value={form.ruc_proveedor} onChange={(e) => { setForm({ ...form, ruc_proveedor: e.target.value }); setVerif(null) }} placeholder="RUC" /></label>
            <button type="button" className="re-verif" onClick={verificarRuc} title="Verificar categorización en el Ministerio de Producción">🔎 Verificar</button>
            <label className="re-f"><span>¿Cumple?</span>
              <span className="re-check"><input type="checkbox" checked={form.calificado} onChange={(e) => setForm({ ...form, calificado: e.target.checked })} /> {form.calificado ? 'Sí' : 'No'}</span></label>
            <label className="re-f wide"><span>Empresa / Persona</span>
              <input value={form.proveedor_nombre} onChange={(e) => setForm({ ...form, proveedor_nombre: e.target.value.toUpperCase() })} placeholder="Nombre del proveedor" /></label>
            <label className="re-f wide"><span>Producto / Ingrediente</span>
              <input value={form.ingrediente} onChange={(e) => setForm({ ...form, ingrediente: e.target.value.toUpperCase() })} placeholder="Ej. ALCOHOL, JUGO, AGUA…" /></label>
            <label className="re-f s"><span>Cantidad</span>
              <input type="number" step="0.01" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} /></label>
            <label className="re-f s"><span>Unidad</span>
              <input value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} /></label>
            <button className="re-btn primary" onClick={agregar}>＋ Agregar</button>
          </div>

          {verif && (
            <div className={`re-verif-res ${verif.estado}`}>
              {verif.texto}
            </div>
          )}

          <div className="re-table-wrap">
            <table className="re-table">
              <thead><tr>
                <th>RUC</th><th>Cumple</th><th>Empresa / Persona</th><th>Producto</th>
                <th className="r">Cantidad</th><th className="r">%</th><th></th>
              </tr></thead>
              <tbody>
                {ings.length === 0 ? (
                  <tr><td colSpan={7} className="re-empty">Sin ingredientes. Agrega el primero con el formulario.</td></tr>
                ) : ings.map((i) => {
                  const agua = esAgua(i.ingrediente)
                  return (
                    <tr key={i.id} className={agua ? 'agua' : ''}>
                      <td>{i.ruc_proveedor || '—'}</td>
                      <td>
                        <span className={`re-badge ${i.calificado ? 'ok' : 'no'}`}>{i.calificado ? 'Cumple' : 'No cumple'}</span>
                        {i.ruc_proveedor && <a className="re-vlink" href={MINPROD} target="_blank" rel="noreferrer" title="Verificar en Min. Producción">🔎</a>}
                      </td>
                      <td>{i.proveedor_nombre || '—'}</td>
                      <td>{i.ingrediente}{agua && <em> (no cuenta)</em>}</td>
                      <td className="r">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</td>
                      <td className="r strong">{incidencia(i).toFixed(2)}%</td>
                      <td><button className="re-del" onClick={() => borrar(i.id)}>✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="re-foot">
                  <td colSpan={4}>
                    TOTAL · <span className={`re-cumple ${resumen.cumple ? 'ok' : 'no'}`}>{resumen.cumple ? `✔ Cumple (≥ ${UMBRAL}%)` : `✗ No cumple (mín. ${UMBRAL}%)`}</span>
                  </td>
                  <td className="r">{resumen.total.toFixed(2)}</td>
                  <td className="r">{resumen.pct.toFixed(2)}%</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Condiciones normativas del producto (se usan en la declaración ICE) */}
          {producto && (
            <div className="re-normas" style={{ marginTop: 14 }}>
              <div className="re-normas-body">
                <p><strong>📋 Condiciones normativas de «{producto}»</strong> — determinan los beneficios en la declaración ICE:</p>
                <p style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                  <label><input type="checkbox" checked={cond.es_cerveza}
                    onChange={(e) => setCondicion('es_cerveza', e.target.checked)} /> Es cerveza</label>
                  <label title="Sin marca primigenia registrada en propiedad intelectual + nueva notificación sanitaria (Art. 199.5 RLRTI)">
                    <input type="checkbox" checked={cond.nueva_marca}
                      onChange={(e) => setCondicion('nueva_marca', e.target.checked)} /> Producto nuevo / nueva marca</label>
                  <label title="Cupo anual de exoneración otorgado por el SRI (Art. 77.1 LRTI / Art. 199.4 RLRTI)">
                    <input type="checkbox" checked={cond.cupo_anual_sri}
                      onChange={(e) => setCondicion('cupo_anual_sri', e.target.checked)} /> Cupo anual SRI obtenido (exención)</label>
                </p>
                {(() => {
                  const marcaOk = !cond.es_cerveza || cond.nueva_marca
                  const rebajaOk = resumen.cumple && marcaOk
                  const exencionOk = rebajaOk && cond.cupo_anual_sri
                  return (
                    <ul>
                      <li><span className={`re-badge ${rebajaOk ? 'ok' : 'no'}`}>{rebajaOk ? '✔' : '✗'}</span>{' '}
                        <strong>Rebaja 50% tarifa específica</strong> (Art. 82 LRTI / Art. 199.5 RLRTI):
                        {' '}{resumen.cumple ? `cumple el ≥${UMBRAL}% nacional` : `no cumple el ≥${UMBRAL}% nacional`}
                        {cond.es_cerveza && (cond.nueva_marca ? '; cerveza con nueva marca ✔' : '; cerveza SIN nueva marca: la rebaja solo aplica a nuevas marcas')}.
                      </li>
                      <li><span className={`re-badge ${exencionOk ? 'ok' : 'no'}`}>{exencionOk ? '✔' : '✗'}</span>{' '}
                        <strong>Exención del ICE</strong> (Art. 77.1 LRTI / Art. 199.4 RLRTI): requiere las condiciones de la rebaja
                        {' '}y el <strong>cupo anual del SRI</strong>{cond.cupo_anual_sri ? ' (marcado ✔)' : ' (sin marcar)'}.
                        {' '}El cupo es un límite anual: verifica el monto otorgado por resolución.
                      </li>
                    </ul>
                  )
                })()}
                <p className="re-normas-nota">Estos datos se aplican automáticamente al calcular la <strong>Declaración ICE</strong> (exención por producto sobre su ICE sin beneficio; rebaja del 50% del específico para los demás que cumplan). Consulta los textos legales en <strong>Información útil → Normativa</strong>.</p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
