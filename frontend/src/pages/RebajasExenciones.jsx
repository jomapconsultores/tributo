import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  { icon: '🧮', label: 'Cálculo previo ICE', path: '/calculo-ice' },
  { icon: '⚖️', label: 'Rebajas y Exenciones', current: true },
  { icon: '🥃', label: 'ICE XML', path: '/ice' },
  { icon: '📄', label: 'Declaraciones ICE', path: '/declaracion-ice' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

const EMPTY = { ingrediente: '', ruc_proveedor: '', proveedor_nombre: '', cantidad: '', unidad: 'ml', densidad: '1', origen: 'NACIONAL', calificado: false }
const esAgua = (nombre) => (nombre || '').trim().toUpperCase() === 'AGUA'
const MINPROD = 'https://servicios.produccion.gob.ec/rum/publico/consultaCategorizacion.jsf'
const UMBRAL = 70 // % mínimo de materia prima nacional calificada

// Equivalencia en litros. Densidad en g/ml (= kg/L); líquidos acuosos ≈ 1.
const U = (u) => (u || '').trim().toLowerCase()
const aLitros = (cantidad, unidad, densidad) => {
  const c = parseFloat(cantidad) || 0
  const d = parseFloat(densidad) || 1
  const u = U(unidad)
  if (['ml', 'cc', 'cm3', 'mililitro', 'mililitros'].includes(u)) return c / 1000
  if (['l', 'lt', 'lts', 'litro', 'litros'].includes(u)) return c
  if (['g', 'gr', 'gramo', 'gramos'].includes(u)) return (c / d) / 1000
  if (['kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos'].includes(u)) return c / d
  return c / 1000 // unidad desconocida: se asume ml
}

// Parser del pegado (Excel/CSV). Detecta encabezados; si no, asume orden:
// RUC · Proveedor · Ingrediente · Cantidad · Unidad · Densidad
const ALIAS = {
  ruc: ['ruc', 'ruc proveedor'], prov: ['proveedor', 'empresa', 'nombre', 'razon social', 'razón social'],
  ing: ['ingrediente', 'componente', 'producto', 'materia prima', 'insumo'],
  cant: ['cantidad', 'cant', 'volumen', 'peso'], und: ['unidad', 'und', 'um'], dens: ['densidad', 'dens'],
}
const parsePaste = (txt) => {
  const lines = (txt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',')
  const split = (l) => l.split(delim).map((c) => c.trim())
  const head = split(lines[0]).map((h) => h.toLowerCase())
  const col = (al) => head.findIndex((h) => al.includes(h))
  let m = { ruc: col(ALIAS.ruc), prov: col(ALIAS.prov), ing: col(ALIAS.ing), cant: col(ALIAS.cant), und: col(ALIAS.und), dens: col(ALIAS.dens) }
  const hasHeader = m.ing >= 0 || m.cant >= 0
  let data = lines
  if (!hasHeader) m = { ruc: 0, prov: 1, ing: 2, cant: 3, und: 4, dens: 5 }
  else data = lines.slice(1)
  const g = (c, i) => (i >= 0 && i < c.length ? c[i] : '')
  return data.map(split).map((c) => ({
    ruc_proveedor: g(c, m.ruc), proveedor_nombre: g(c, m.prov), ingrediente: g(c, m.ing),
    cantidad: g(c, m.cant), unidad: g(c, m.und) || 'ml', densidad: g(c, m.dens) || '1',
  })).filter((it) => (it.ingrediente || '').trim())
}

export default function RebajasExenciones() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient, identsForSvc } = useClients()
  const ident = selectedClient?.identificacion
  const idents_svc = identsForSvc('declaracion_ice')

  const [productos, setProductos] = useState([])
  const [producto, setProducto] = useState('')
  const [ings, setIngs] = useState([])
  const [proveedores, setProveedores] = useState([])
  const [form, setForm] = useDraft(ident && producto ? `draft:rebajas:form:${ident}:${producto}` : null, EMPTY)
  const [verif, setVerif] = useState(null) // { estado, texto }
  const [cond, setCond] = useState({ es_cerveza: false, nueva_marca: false, cupo_anual_sri: false })
  // Carga masiva
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteTxt, setPasteTxt] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState('')
  const fileRef = useRef(null)

  // Catálogo de proveedores del contribuyente (RUC → nombre/calificado)
  const loadProv = useCallback(() => {
    if (!ident) { setProveedores([]); return }
    rebajasAPI.listProveedores(ident).then((r) => setProveedores(r.data?.data || [])).catch(() => setProveedores([]))
  }, [ident])
  useEffect(() => { loadProv() }, [loadProv])

  const onRucChange = (v) => {
    setVerif(null)
    const p = proveedores.find((x) => (x.ruc || '') === v.trim())
    setForm((f) => ({ ...f, ruc_proveedor: v, ...(p ? { proveedor_nombre: p.nombre || f.proveedor_nombre, calificado: !!p.calificado } : {}) }))
  }

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
      // Guarda el proveedor en el catálogo para reutilizarlo
      try {
        await rebajasAPI.upsertProveedor({ identificacion: ident, ruc, nombre: d.razon_social || '', calificado: d.cumple === true, categoria: d.categoria || '', vigencia: d.vigencia || '' })
        loadProv()
      } catch { /* no bloquea */ }
    } catch (e) {
      setVerif({ estado: 'wait', texto: 'Error al verificar: ' + (e.response?.data?.detail || e.message) })
    }
  }

  // Verifica TODOS los RUC del producto en el Ministerio y propaga el resultado
  const verificarTodos = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    setBusy('Verificando todos los RUC del producto en el Ministerio…')
    try {
      const r = await rebajasAPI.verificarTodos(ident, producto)
      await loadIngs(); loadProv()
      setVerif({ estado: 'ok', texto: `✔ ${r.data.verificados} RUC verificados y actualizados` })
    } catch (e) {
      alert('Error al verificar: ' + (e.response?.data?.detail || e.message))
    } finally { setBusy('') }
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
    try { await rebajasAPI.setCondiciones({ identificacion: ident, producto, ...nuevo }) }
    catch (e) { alert('Error al guardar la condición: ' + (e.response?.data?.detail || e.message)) }
  }

  const agregar = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    if (!form.ingrediente.trim()) { alert('Ingresa el ingrediente.'); return }
    try {
      await rebajasAPI.create({ identificacion: ident, producto, ...form, cantidad: parseFloat(form.cantidad) || 0, densidad: parseFloat(form.densidad) || 1 })
      setForm(EMPTY)
      await loadIngs()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    try { await rebajasAPI.delete(id); await loadIngs() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  // Carga masiva: pegar de Excel
  const cargarPegado = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    const items = parsePaste(pasteTxt)
    if (!items.length) { alert('No se detectaron filas. Pega columnas: RUC, Proveedor, Ingrediente, Cantidad, Unidad, Densidad.'); return }
    setBusy(`Cargando ${items.length} componentes…`)
    try {
      const r = await rebajasAPI.bulk({ identificacion: ident, producto, items })
      setPasteTxt(''); setPasteOpen(false); await loadIngs()
      alert(`✔ ${r.data.insertados} componentes cargados.`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy('') }
  }
  // Carga masiva: subir archivo .xlsx/.csv
  const cargarArchivo = async (file) => {
    if (!file) return
    if (!producto) { alert('Elige un producto del catálogo antes de subir el archivo.'); return }
    if (!/\.(xlsx|xls|csv|txt)$/i.test(file.name)) { alert('Sube un archivo Excel (.xlsx/.xls) o CSV.'); return }
    setBusy('Leyendo archivo…')
    try {
      const r = await rebajasAPI.parseFile(ident, producto, file)
      await loadIngs()
      alert(`✔ ${r.data.insertados} componentes cargados desde el archivo.`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = '' }
  }
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); cargarArchivo(e.dataTransfer.files?.[0]) }

  const litros = (i) => aLitros(i.cantidad, i.unidad, i.densidad)
  const resumen = useMemo(() => {
    const noAgua = ings.filter((i) => !esAgua(i.ingrediente))
    const total = noAgua.reduce((s, i) => s + litros(i), 0)
    const calif = noAgua.filter((i) => i.calificado).reduce((s, i) => s + litros(i), 0)
    const pct = total ? (calif / total) * 100 : 0
    return { total, calif, pct, cumple: pct >= UMBRAL }
  }, [ings])

  // Incidencia (%) por fila en litros: agua = 0, no calificado = 0
  const incidencia = (i) => {
    if (esAgua(i.ingrediente) || !i.calificado || !resumen.total) return 0
    return litros(i) / resumen.total * 100
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

      <details className="re-normas" open>
        <summary>📖 Normas de aplicación</summary>
        <div className="re-normas-body">
          <p><strong>Rebaja / exención de ICE por componente nacional.</strong> El beneficio aplica cuando la bebida se elabora con al menos <strong>{UMBRAL}%</strong> de materia prima nacional adquirida a <strong>artesanos, micro, pequeñas o medianas empresas (MIPYME) u organizaciones de la economía popular y solidaria</strong>, categorizados por el Ministerio de Producción.</p>
          <ul>
            <li>Al pulsar <strong>🔎 Verificar</strong> se consulta el RUC en el Ministerio: si está categorizado como <strong>MIPYME/artesano</strong> → <strong>cumple</strong>; si es <strong>"NO MIPYME"</strong> → <strong>no cumple</strong>. El proveedor verificado queda <strong>guardado</strong> para reutilizarlo.</li>
            <li>El <strong>%</strong> se calcula sobre la <strong>equivalencia en litros</strong> de cada componente (las masas en g/kg se convierten con su <strong>densidad</strong>). El <strong>agua no se contabiliza</strong>.</li>
            <li>Puedes cargar los componentes <strong>uno por uno</strong>, <strong>pegando</strong> desde Excel o <strong>subiendo</strong> un archivo .xlsx/.csv.</li>
          </ul>
          <p className="re-normas-nota">Fundamento: LRTI — rebaja de hasta 50% de la tarifa específica para bebidas con materia prima nacional de proveedores MIPYME/artesanos; la exención no aplica si el contenido nacional es menor al 70%.</p>
        </div>
      </details>

      <div className="re-form">
        <label className="re-f"><span>RUC proveedor</span>
          <input list="re-prov-list" value={form.ruc_proveedor} onChange={(e) => onRucChange(e.target.value)} placeholder="RUC" /></label>
        <datalist id="re-prov-list">
          {proveedores.map((p) => <option key={p.id} value={p.ruc}>{p.nombre}{p.calificado ? ' ✔' : ''}</option>)}
        </datalist>
        <button type="button" className="re-verif" onClick={verificarRuc} title="Verificar categorización en el Ministerio de Producción">🔎 Verificar</button>
        <label className="re-f"><span>¿Cumple?</span>
          <span className="re-check"><input type="checkbox" checked={form.calificado} onChange={(e) => setForm({ ...form, calificado: e.target.checked })} /> {form.calificado ? 'Sí' : 'No'}</span></label>
        <label className="re-f wide"><span>Empresa / Persona</span>
          <input value={form.proveedor_nombre} onChange={(e) => setForm({ ...form, proveedor_nombre: e.target.value.toUpperCase() })} placeholder="Nombre del proveedor" /></label>
        <label className="re-f wide"><span>Producto / Ingrediente</span>
          <input value={form.ingrediente} onChange={(e) => setForm({ ...form, ingrediente: e.target.value.toUpperCase() })} placeholder="Ej. ALCOHOL, JUGO, AGUA…" /></label>
        <label className="re-f s"><span>Cantidad</span>
          <input type="number" step="0.0001" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} /></label>
        <label className="re-f s"><span>Unidad</span>
          <input list="re-und-list" value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} />
          <datalist id="re-und-list"><option value="ml" /><option value="L" /><option value="cc" /><option value="g" /><option value="kg" /></datalist></label>
        <label className="re-f s"><span>Densidad (g/ml)</span>
          <input type="number" step="0.001" value={form.densidad} onChange={(e) => setForm({ ...form, densidad: e.target.value })} title="Para convertir masa (g/kg) a litros. Agua/líquidos ≈ 1" /></label>
        <button className="re-btn primary" onClick={agregar}>＋ Agregar</button>
        <button type="button" className="re-btn" onClick={() => setPasteOpen((v) => !v)} title="Pegar varias filas desde Excel">📋 Pegar de Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" style={{ display: 'none' }} onChange={(e) => cargarArchivo(e.target.files?.[0])} />
        <button type="button" className="re-btn" onClick={() => fileRef.current?.click()} title="Subir .xlsx/.csv">⬆ Subir archivo</button>
        <button type="button" className="re-btn" onClick={verificarTodos} title="Verificar en el Ministerio todos los RUC de este producto">✅ Verificar todos</button>
      </div>

      {pasteOpen && (
        <div className="re-paste">
          <p className="re-paste-hint">Pega filas desde Excel (con o sin encabezado). Columnas: <strong>RUC · Proveedor · Ingrediente · Cantidad · Unidad · Densidad</strong></p>
          <textarea value={pasteTxt} onChange={(e) => setPasteTxt(e.target.value)} rows={6}
            placeholder={'1790000000001\tDESTILERÍA X\tALCOHOL\t700\tml\t0.79\n—\t—\tAGUA\t250\tml\t1'} />
          <div className="re-paste-actions">
            <button className="re-btn primary" onClick={cargarPegado}>Cargar {parsePaste(pasteTxt).length || ''} filas</button>
            <button className="re-btn" onClick={() => { setPasteTxt(''); setPasteOpen(false) }}>Cancelar</button>
          </div>
        </div>
      )}

      <div
        className={`re-drop${dragOver ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
      >
        📥 Arrastra aquí un archivo .xlsx/.csv de componentes (o haz clic para elegirlo)
      </div>

      {busy && <div className="re-busy">⏳ {busy}</div>}
      {verif && <div className={`re-verif-res ${verif.estado}`}>{verif.texto}</div>}

      <div className="re-table-wrap">
        <table className="re-table">
          <thead><tr>
            <th className="r">#</th><th>RUC</th><th>Cumple</th><th>Empresa / Persona</th><th>Producto</th>
            <th className="r">Cantidad</th><th className="r">Litros</th><th className="r">%</th><th></th>
          </tr></thead>
          <tbody>
            {ings.length === 0 ? (
              <tr><td colSpan={9} className="re-empty">Sin componentes. Agrégalos uno por uno, pegando de Excel o subiendo un archivo.</td></tr>
            ) : ings.map((i, idx) => {
              const agua = esAgua(i.ingrediente)
              return (
                <tr key={i.id} className={agua ? 'agua' : ''}>
                  <td className="r re-rownum">{idx + 1}</td>
                  <td>{i.ruc_proveedor || '—'}</td>
                  <td>
                    <span className={`re-badge ${i.calificado ? 'ok' : 'no'}`}>{i.calificado ? 'Cumple' : 'No cumple'}</span>
                    {i.ruc_proveedor && <a className="re-vlink" href={MINPROD} target="_blank" rel="noreferrer" title="Verificar en Min. Producción">🔎</a>}
                  </td>
                  <td>{i.proveedor_nombre || '—'}</td>
                  <td>{i.ingrediente}{agua && <em> (no cuenta)</em>}</td>
                  <td className="r">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</td>
                  <td className="r">{litros(i).toFixed(4)}</td>
                  <td className="r strong">{incidencia(i).toFixed(2)}%</td>
                  <td><button className="re-del" onClick={() => borrar(i.id)}>✕</button></td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="re-foot">
              <td colSpan={5}>
                TOTAL · <span className={`re-cumple ${resumen.cumple ? 'ok' : 'no'}`}>{resumen.cumple ? `✔ Cumple (≥ ${UMBRAL}%)` : `✗ No cumple (mín. ${UMBRAL}%)`}</span>
              </td>
              <td></td>
              <td className="r">{resumen.total.toFixed(4)} L</td>
              <td className="r">{resumen.pct.toFixed(2)}%</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

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
                  </li>
                </ul>
              )
            })()}
            <p className="re-normas-nota">Estos datos se aplican automáticamente al calcular la <strong>Declaración ICE</strong>. Consulta los textos legales en <strong>Información útil → Normativa</strong>.</p>
          </div>
        </div>
      )}
    </div>
  )
}
