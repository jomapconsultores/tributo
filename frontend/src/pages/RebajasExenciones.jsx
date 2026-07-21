import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import { rebajasAPI, productsAPI, classificationAPI, downloadBlob } from '../services/api'
import { useClients } from '../context/ClientContext'
import { useAccess } from '../context/AccessContext'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import ClassifierTable from '../components/ClassifierTable'
import WorkflowGuide from '../components/WorkflowGuide'
import useDraft from '../hooks/useDraft'
import './RebajasExenciones.css'

const RE_STEPS = [
  { icon: '📚', label: 'Catálogo Productos', path: '/catalogo-productos' },
  { icon: '🧮', label: 'Cálculo previo ICE', path: '/calculo-ice' },
  { icon: '⚖️', label: 'Rebajas y Exenciones', current: true },
  { icon: '🥃', label: 'Ingresos ICE XML', path: '/ice' },
  { icon: '📄', label: 'Declaraciones ICE', path: '/declaracion-ice' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

const EMPTY = { ingrediente: '', ruc_proveedor: '', proveedor_nombre: '', cantidad: '', unidad: 'ml', densidad: '1', origen: 'NACIONAL', calificado: false }
const esAgua = (nombre) => (nombre || '').trim().toUpperCase() === 'AGUA'
const MINPROD = 'https://servicios.produccion.gob.ec/rum/publico/consultaCategorizacion.jsf'
const UMBRAL = 70

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
  return c / 1000
}

// Separa "700 ml" -> { cantidad:700, unidad:'ml' }. Respeta unidad en columna aparte.
const splitCantidad = (raw, unidadCol) => {
  let u = (unidadCol || '').trim()
  const s = String(raw || '').trim().replace(',', '.')
  const m = s.match(/^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Zµ]+)?\s*$/)
  let num = 0
  if (m) { num = parseFloat(m[1]) || 0; if (!u && m[2]) u = m[2] }
  else num = parseFloat(s) || 0
  return { cantidad: num, unidad: u || 'ml' }
}

// Pegado: Ingrediente + Cantidad (la cantidad puede traer la unidad). Detecta encabezado.
const parsePaste = (txt) => {
  const lines = (txt || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const delim = lines[0].includes('\t') ? '\t' : (lines[0].includes(';') ? ';' : ',')
  const split = (l) => l.split(delim).map((c) => c.trim())
  const head = split(lines[0]).map((h) => h.toLowerCase())
  const col = (al) => head.findIndex((h) => al.includes(h))
  let m = { ing: col(['ingrediente', 'componente', 'producto', 'materia prima', 'insumo']), cant: col(['cantidad', 'cant', 'volumen', 'peso']), und: col(['unidad', 'und', 'um']), dens: col(['densidad', 'dens']) }
  const hasHeader = m.ing >= 0 || m.cant >= 0
  let data = lines
  if (!hasHeader) m = { ing: 0, cant: 1, und: 2, dens: 3 }
  else data = lines.slice(1)
  const g = (c, i) => (i >= 0 && i < c.length ? c[i] : '')
  return data.map(split).map((c) => {
    const sp = splitCantidad(g(c, m.cant), g(c, m.und))
    return { ingrediente: g(c, m.ing), cantidad: sp.cantidad, unidad: sp.unidad, densidad: g(c, m.dens) || '1' }
  }).filter((it) => (it.ingrediente || '').trim())
}

const hoyISO = () => new Date().toISOString().slice(0, 10)
const estaVencido = (d) => !!d && String(d) < hoyISO()

export default function RebajasExenciones() {
  const { openNewClient } = useOutletContext()
  const { isSuperAdmin } = useAccess()
  const { clients, selectedClient, selectClient, identsForSvc } = useClients()
  const ident = selectedClient?.identificacion
  const idents_svc = identsForSvc('declaracion_ice')

  const [productos, setProductos] = useState([])
  const [producto, setProducto] = useState('')
  const [ings, setIngs] = useState([])
  const [proveedores, setProveedores] = useState([])
  const [form, setForm] = useDraft(ident && producto ? `draft:rebajas:form:${ident}:${producto}` : null, EMPTY)
  const [verif, setVerif] = useState(null)
  const [cond, setCond] = useState({ es_cerveza: false, nueva_marca: false, cupo_anual_sri: false })
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteTxt, setPasteTxt] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState('')
  const fileRef = useRef(null)

  const [provEnr, setProvEnr] = useState('')
  const traerActProv = useCallback(async (idt) => {
    if (!idt) return
    try {
      let restantes = 1
      for (let i = 0; i < 200 && restantes > 0; i++) {
        const r = await rebajasAPI.enriquecerActProveedores(idt)
        restantes = r.data?.restantes ?? 0
        setProvEnr(restantes > 0 ? `Trayendo actividad (SRI)… faltan ${restantes}` : '')
        if ((r.data?.procesados || 0) === 0) break
      }
      setProvEnr('')
      const r = await rebajasAPI.listProveedores(idt)
      setProveedores(r.data?.data || [])
    } catch { setProvEnr('') }
  }, [])
  const loadProv = useCallback(() => {
    if (!ident) { setProveedores([]); return }
    rebajasAPI.listProveedores(ident).then((r) => {
      const rows = r.data?.data || []
      setProveedores(rows)
      // Despliega automáticamente la actividad (SRI) de los proveedores que falten
      if (rows.some((x) => !String(x.actividad || '').trim())) traerActProv(ident)
    }).catch(() => setProveedores([]))
  }, [ident, traerActProv])
  useEffect(() => { loadProv() }, [loadProv])

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
      else if (d.calificado === true) { estado = 'no'; texto = `✗ No cumple · ${nombre} · ${d.categoria} (no es MIPYME)` }
      else if (d.calificado === false) { estado = 'no'; texto = `✗ No cumple · ${nombre} · no categorizado${d.tipo ? ' · ' + d.tipo : ''}` }
      if (d.actividad_economica) texto += ` · Actividad SRI: ${d.actividad_economica}`
      setVerif({ estado, texto })
      try { await rebajasAPI.upsertProveedor({ identificacion: ident, ruc, nombre: d.razon_social || '', calificado: d.cumple === true, categoria: d.categoria || '', actividad: d.actividad_economica || '', vigencia: d.vigencia || '' }); loadProv() } catch { /* */ }
    } catch (e) {
      setVerif({ estado: 'wait', texto: 'Error al verificar: ' + (e.response?.data?.detail || e.message) })
    }
  }

  const verificarTodos = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    setBusy('Verificando todos los RUC del producto en el Ministerio…')
    try {
      const r = await rebajasAPI.verificarTodos(ident, producto)
      await loadIngs(); loadProv()
      setVerif({ estado: 'ok', texto: `✔ ${r.data.verificados} RUC verificados y actualizados` })
    } catch (e) { alert('Error al verificar: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy('') }
  }

  const agregar = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    if (!form.ingrediente.trim()) { alert('Ingresa el ingrediente.'); return }
    try {
      await rebajasAPI.create({ identificacion: ident, producto, ...form, cantidad: parseFloat(form.cantidad) || 0, densidad: parseFloat(form.densidad) || 1 })
      setForm(EMPTY); await loadIngs()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    try { await rebajasAPI.delete(id); await loadIngs() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  // ── Edición por fila (asignar RUC al componente cargado) ──
  const setFila = (id, patch) => setIngs((arr) => arr.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const onRucFila = (row, ruc) => {
    const p = proveedores.find((x) => (x.ruc || '') === ruc.trim())
    setFila(row.id, p ? { ruc_proveedor: ruc, proveedor_nombre: p.nombre || row.proveedor_nombre, calificado: !!p.calificado } : { ruc_proveedor: ruc })
  }
  const guardarFila = (id) => setIngs((arr) => {
    const row = arr.find((x) => x.id === id)
    if (row) rebajasAPI.update(id, { ruc_proveedor: row.ruc_proveedor || '', proveedor_nombre: row.proveedor_nombre || '', calificado: !!row.calificado }).catch(() => {})
    return arr
  })
  const verificarFila = async (row) => {
    const ruc = (row.ruc_proveedor || '').trim()
    if (!ruc) { alert('Escribe el RUC en la fila primero.'); return }
    setBusy(`Verificando ${ruc}…`)
    try {
      const r = await rebajasAPI.verificarRuc(ruc); const d = r.data
      const patch = { calificado: d.cumple === true, proveedor_nombre: d.razon_social || row.proveedor_nombre || '' }
      await rebajasAPI.update(row.id, { ruc_proveedor: ruc, ...patch })
      await rebajasAPI.upsertProveedor({ identificacion: ident, ruc, nombre: d.razon_social || '', calificado: d.cumple === true, categoria: d.categoria || '', actividad: d.actividad_economica || '', vigencia: d.vigencia || '' })
      setFila(row.id, patch); loadProv()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy('') }
  }

  // ── Carga masiva ──
  const cargarPegado = async () => {
    if (!producto) { alert('Elige un producto del catálogo.'); return }
    const items = parsePaste(pasteTxt)
    if (!items.length) { alert('No se detectaron filas. Pega 2 columnas: Ingrediente y Cantidad (la cantidad puede incluir la unidad, ej. "700 ml").'); return }
    setBusy(`Cargando ${items.length} componentes…`)
    try {
      const r = await rebajasAPI.bulk({ identificacion: ident, producto, items })
      setPasteTxt(''); setPasteOpen(false); await loadIngs()
      alert(`✔ ${r.data.insertados} componentes cargados. Ahora asigna el RUC de cada uno en la tabla.`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy('') }
  }
  const cargarArchivo = async (file) => {
    if (!file) return
    if (!producto) { alert('Elige un producto del catálogo antes de subir el archivo.'); return }
    if (!/\.(xlsx|xls|csv|txt)$/i.test(file.name)) { alert('Sube un archivo Excel (.xlsx/.xls) o CSV.'); return }
    setBusy('Leyendo archivo…')
    try {
      const r = await rebajasAPI.parseFile(ident, producto, file); await loadIngs()
      alert(`✔ ${r.data.insertados} componentes cargados desde el archivo.`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(''); if (fileRef.current) fileRef.current.value = '' }
  }
  const onDrop = (e) => { e.preventDefault(); setDragOver(false); cargarArchivo(e.dataTransfer.files?.[0]) }

  const litros = (i) => aLitros(i.cantidad, i.unidad, i.densidad)
  // Un proveedor vencido NO cuenta como calificado
  const provVencido = (ruc) => {
    const p = proveedores.find((x) => (x.ruc || '') === (ruc || '').trim())
    return !!(p && p.vigente_hasta && estaVencido(p.vigente_hasta))
  }
  const efectivoCalif = (i) => !!i.calificado && !provVencido(i.ruc_proveedor)
  const resumen = useMemo(() => {
    const noAgua = ings.filter((i) => !esAgua(i.ingrediente))
    const total = noAgua.reduce((s, i) => s + litros(i), 0)
    const calif = noAgua.filter((i) => efectivoCalif(i)).reduce((s, i) => s + litros(i), 0)
    const pct = total ? (calif / total) * 100 : 0
    return { total, calif, pct, cumple: pct >= UMBRAL }
  }, [ings, proveedores])
  const incidencia = (i) => {
    if (esAgua(i.ingrediente) || !efectivoCalif(i) || !resumen.total) return 0
    return litros(i) / resumen.total * 100
  }

  // ── Panel de proveedores calificados ──
  const [provForm, setProvForm] = useState({ ruc: '', nombre: '', calificado: false, categoria: '', vigente_hasta: '', actividad: '' })
  const [provDragOver, setProvDragOver] = useState(false)
  const provFileRef = useRef(null)
  const [provOpen, setProvOpen] = useState(false)
  const okDoc = (f) => /\.(xlsx|xls|csv|pdf)$/i.test(f.name) || /^image\//.test(f.type)

  // Panel de gastos a clasificar (clasificador de gastos embebido)
  const [gastosOpen, setGastosOpen] = useState(false)
  const [gastosRows, setGastosRows] = useState([])
  const [gfRuc, setGfRuc] = useState('')
  const [gfNombre, setGfNombre] = useState('')
  const [gfAct, setGfAct] = useState('')
  const [gfCat, setGfCat] = useState('')
  const [gfCalif, setGfCalif] = useState('todos')
  const [gfSinClasif, setGfSinClasif] = useState(false)
  const gastosFileRef = useRef(null)
  const [gastosEnr, setGastosEnr] = useState('')
  const traerActGastos = async () => {
    if (gastosEnr) return
    try {
      let restantes = 1
      for (let i = 0; i < 400 && restantes > 0; i++) {
        const r = await classificationAPI.enriquecerActividades()
        restantes = r.data?.restantes ?? 0
        setGastosEnr(`Trayendo actividad del SRI… faltan ${restantes}`)
        if ((r.data?.procesados || 0) === 0) break
      }
      setGastosEnr(''); await loadGastos()
    } catch { setGastosEnr('') }
  }
  const loadGastos = async (auto = false) => {
    if (!ident) { setGastosRows([]); return }
    try {
      const r = await classificationAPI.porContribuyente(ident)
      const rows = r.data || []
      setGastosRows(rows)
      // Despliega automáticamente las actividades del SRI que falten
      if (auto && !gastosEnr && rows.some((x) => !String(x.actividad || '').trim())) traerActGastos()
    } catch { setGastosRows([]) }
  }
  useEffect(() => { if (gastosOpen) loadGastos(true) }, [gastosOpen, ident])
  // Actualización local de una fila (sin recargar toda la tabla → instantáneo)
  const onGastoRowChange = (id, patch) => setGastosRows((arr) => arr.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const onGastoRowDelete = (id) => setGastosRows((arr) => arr.filter((c) => c.id !== id))
  const importarGastos = async (file) => {
    if (!file) return
    try {
      const r = await classificationAPI.import(file)
      await loadGastos()
      const recl = r.data?.reclasificadas ? ` · ${r.data.reclasificadas} factura(s) reclasificadas` : ''
      alert(`Importados: ${r.data?.imported ?? 0} · Actualizados: ${r.data?.updated ?? 0}${recl}`)
    } catch (e) { alert('Error al importar: ' + (e.response?.data?.detail || e.message)) }
  }
  const exportarGastos = async () => {
    try { const r = await classificationAPI.exportExcel(); downloadBlob(r.data, 'clasificador.xlsx') }
    catch (e) { alert('Error al exportar: ' + (e.response?.data?.detail || e.message)) }
  }
  const gInc = (v, t) => String(v || '').toLowerCase().includes(t)
  const gNSinClasif = gastosRows.filter((x) => !String(x.categoria || '').trim()).length
  const gastosFiltrados = gastosRows.filter((x) => {
    const r = gfRuc.trim().toLowerCase(), n = gfNombre.trim().toLowerCase()
    const a = gfAct.trim().toLowerCase(), c = gfCat.trim().toLowerCase()
    const sinCat = !String(x.categoria || '').trim()
    const catSinClasif = c === 'sin clasificar' || c === 'sin clasificación'
    if (gfSinClasif && !sinCat) return false
    if (r && !gInc(x.ruc, r)) return false
    if (n && !gInc(x.nombre_proveedor, n)) return false
    if (a && !gInc(x.actividad, a)) return false
    if (c) { if (catSinClasif) { if (!sinCat) return false } else if (!gInc(x.categoria, c)) return false }
    if (gfCalif === 'si' && !x.calificado) return false
    if (gfCalif === 'no' && x.calificado) return false
    return true
  })
  const gOpc = (k) => {
    const arr = [...new Set(gastosRows.map((x) => String(x[k] || '').trim()).filter((v) => v && v !== '—'))].sort()
    if (k === 'categoria' && gNSinClasif > 0) arr.unshift('SIN CLASIFICAR')
    return arr
  }

  // Guarda el proveedor en la base AL INSTANTE (sin botón). Usa el valor más reciente.
  const provGuardarAuto = (nf) => {
    const ruc = (nf.ruc || '').trim()
    if (!ruc) return
    rebajasAPI.upsertProveedor({ identificacion: ident, ruc, nombre: nf.nombre, calificado: nf.calificado, categoria: nf.categoria || '', actividad: nf.actividad || '', vigente_hasta: nf.vigente_hasta || null })
      .then(() => loadProv()).catch(() => {})
  }
  const provField = (patch, guardar = false) => setProvForm((f) => {
    const nf = { ...f, ...patch }
    if (guardar) provGuardarAuto(nf)
    return nf
  })
  const verProvRuc = async () => {
    const ruc = (provForm.ruc || '').trim(); if (!ruc) { alert('Ingresa el RUC.'); return }
    setBusy('Verificando…')
    try {
      const r = await rebajasAPI.verificarRuc(ruc); const d = r.data
      const nf = { ...provForm, ruc, nombre: d.razon_social || provForm.nombre, calificado: d.cumple === true, categoria: d.categoria || provForm.categoria, actividad: d.actividad_economica || provForm.actividad }
      setProvForm(nf); provGuardarAuto(nf) // se cataloga al instante
      if (d.actividad_economica) setVerif({ estado: d.cumple ? 'ok' : 'no', texto: `${d.cumple ? '✔ Cumple' : '✗ No cumple'} · ${d.razon_social || ruc}${d.categoria ? ' · ' + d.categoria : ''} · Actividad SRI: ${d.actividad_economica}` })
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) } finally { setBusy('') }
  }
  // Subir documentos: EXTRAE los datos del documento (RUC, nombre, calificación,
  // vigencia) y los guarda en la base al instante. No requiere ningún dato previo.
  const subirDocs = async (fileList) => {
    const arr = Array.from(fileList || []).filter(okDoc)
    if (!arr.length) { alert('Solo Excel (.xlsx/.xls/.csv), PDF o imágenes.'); return }
    const ruc = (provForm.ruc || '').trim() // opcional: si lo escribiste se usa; si no, se extrae del documento
    setBusy('Subiendo y extrayendo datos…')
    try {
      for (let k = 0; k < arr.length; k++) {
        setBusy(`Procesando documento ${k + 1} de ${arr.length}…`)
        await rebajasAPI.subirDocProveedor({ identificacion: ident, ruc: ruc || undefined, nombre: provForm.nombre, calificado: provForm.calificado, vigente_hasta: provForm.vigente_hasta || null, file: arr[k] })
      }
      await loadProv()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
    finally { setBusy(''); if (provFileRef.current) provFileRef.current.value = '' }
  }
  const verDoc = async (path) => {
    try { const r = await rebajasAPI.docUrl(path); if (r.data?.url) window.open(r.data.url, '_blank'); else alert('No se pudo abrir el documento.') }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrarProv = async (id) => {
    if (!window.confirm('¿Eliminar este proveedor del catálogo?')) return
    try { await rebajasAPI.deleteProveedor(id); loadProv() } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
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
        <input list="re-prod-list" value={producto} onChange={(e) => setProducto(e.target.value.toUpperCase())}
          placeholder="Escribe el producto o elígelo del catálogo…" />
        <datalist id="re-prod-list">{productos.map((p) => <option key={p.id} value={p.nombre} />)}</datalist>
        <span className="re-hint">Los componentes se guardan ligados a este producto.</span>
      </div>

      <details className="re-normas" open>
        <summary>📖 Cómo funciona</summary>
        <div className="re-normas-body">
          <ul>
            <li><strong>Carga uno por uno</strong> con el formulario, o <strong>📋 Pega de Excel</strong> solo <strong>Ingrediente + Cantidad</strong> (la cantidad puede incluir la unidad, ej. <em>700 ml</em>, <em>50 g</em>).</li>
            <li>Cada cantidad se lleva a su <strong>equivalencia en litros</strong> (las masas en g/kg con su densidad) y se calcula el <strong>%</strong>. El <strong>agua no cuenta</strong>.</li>
            <li>Luego asigna el <strong>RUC del proveedor</strong> en cada fila y pulsa 🔎: se cataloga como <strong>calificado</strong> o no. La suma de los calificados debe ser ≥ {UMBRAL}%.</li>
            <li>En <strong>Proveedores calificados</strong> puedes subir documentos (Excel/foto/PDF) con su <strong>vigencia</strong> como respaldo reutilizable.</li>
          </ul>
        </div>
      </details>

      {/* Formulario uno por uno */}
      <div className="re-form">
        <label className="re-f wide"><span>Ingrediente / Componente</span>
          <input value={form.ingrediente} onChange={(e) => setForm({ ...form, ingrediente: e.target.value.toUpperCase() })} placeholder="Ej. ALCOHOL, JUGO, AGUA…" /></label>
        <label className="re-f s"><span>Cantidad</span>
          <input type="number" step="0.0001" value={form.cantidad} onChange={(e) => setForm({ ...form, cantidad: e.target.value })} /></label>
        <label className="re-f s"><span>Unidad</span>
          <input list="re-und-list" value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} />
          <datalist id="re-und-list"><option value="ml" /><option value="L" /><option value="cc" /><option value="g" /><option value="kg" /></datalist></label>
        <label className="re-f s"><span>Densidad (g/ml)</span>
          <input type="number" step="0.001" value={form.densidad} onChange={(e) => setForm({ ...form, densidad: e.target.value })} title="Para convertir masa (g/kg) a litros. Agua/líquidos ≈ 1" /></label>
        <label className="re-f"><span>RUC proveedor (opcional)</span>
          <input list="re-prov-list" value={form.ruc_proveedor} onChange={(e) => onRucChange(e.target.value)} placeholder="puedes asignarlo luego" /></label>
        <datalist id="re-prov-list">{proveedores.map((p) => <option key={p.id} value={p.ruc}>{p.nombre}{p.calificado ? ' ✔' : ''}</option>)}</datalist>
        <button type="button" className="re-verif" onClick={verificarRuc} title="Verificar en el Ministerio de Producción">🔎 Verificar</button>
        <button className="re-btn primary" onClick={agregar}>＋ Agregar</button>
        <button type="button" className="re-btn" onClick={() => setPasteOpen((v) => !v)}>📋 Pegar de Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.txt" style={{ display: 'none' }} onChange={(e) => cargarArchivo(e.target.files?.[0])} />
        <button type="button" className="re-btn" onClick={() => fileRef.current?.click()}>⬆ Subir archivo</button>
        <button type="button" className="re-btn" onClick={verificarTodos}>✅ Verificar todos</button>
      </div>

      {pasteOpen && (
        <div className="re-paste">
          <p className="re-paste-hint">Pega 2 columnas desde Excel (con o sin encabezado): <strong>Ingrediente · Cantidad</strong>. La cantidad puede traer la unidad (ej. <em>700 ml</em>).</p>
          <textarea value={pasteTxt} onChange={(e) => setPasteTxt(e.target.value)} rows={6}
            placeholder={'ALCOHOL\t700 ml\nJUGO DE CAÑA\t250 ml\nAZÚCAR\t50 g\nAGUA\t100 ml'} />
          <div className="re-paste-actions">
            <button className="re-btn primary" onClick={cargarPegado}>Cargar {parsePaste(pasteTxt).length || ''} filas</button>
            <button className="re-btn" onClick={() => { setPasteTxt(''); setPasteOpen(false) }}>Cancelar</button>
          </div>
        </div>
      )}

      <div className={`re-drop${dragOver ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
        onClick={() => fileRef.current?.click()}>
        📥 Arrastra aquí un archivo .xlsx/.csv (Ingrediente · Cantidad), o haz clic para elegirlo
      </div>

      {busy && <div className="re-busy">⏳ {busy}</div>}
      {verif && <div className={`re-verif-res ${verif.estado}`}>{verif.texto}</div>}

      <div className="re-table-wrap">
        <table className="re-table">
          <thead><tr>
            <th className="r">#</th><th>Ingrediente</th><th className="r">Cantidad</th><th className="r">Litros</th>
            <th>RUC proveedor</th><th>Empresa / Persona</th><th>Cumple</th><th className="r">%</th><th></th>
          </tr></thead>
          <tbody>
            {ings.length === 0 ? (
              <tr><td colSpan={9} className="re-empty">Sin componentes. Agrégalos uno por uno, pegando de Excel o subiendo un archivo.</td></tr>
            ) : ings.map((i, idx) => {
              const agua = esAgua(i.ingrediente)
              return (
                <tr key={i.id} className={agua ? 'agua' : ''}>
                  <td className="r re-rownum">{idx + 1}</td>
                  <td>{i.ingrediente}{agua && <em> (no cuenta)</em>}</td>
                  <td className="r">{(parseFloat(i.cantidad) || 0).toFixed(2)} {i.unidad}</td>
                  <td className="r">{litros(i).toFixed(4)}</td>
                  <td>
                    {agua ? '—' : (
                      <span className="re-ruc-cell">
                        <input className="re-ruc-inp" list="re-prov-list" value={i.ruc_proveedor || ''}
                          onChange={(e) => onRucFila(i, e.target.value)} onBlur={() => guardarFila(i.id)} placeholder="RUC…" />
                        <button className="re-ruc-v" title="Verificar este RUC" onClick={() => verificarFila(i)}>🔎</button>
                      </span>
                    )}
                  </td>
                  <td>{i.proveedor_nombre || '—'}</td>
                  <td>{agua ? '—' : (
                    i.calificado && provVencido(i.ruc_proveedor)
                      ? <span className="re-badge no" title="El documento del proveedor está vencido: no cuenta">Vencido</span>
                      : <span className={`re-badge ${i.calificado ? 'ok' : 'no'}`}>{i.calificado ? 'Cumple' : 'No cumple'}</span>
                  )}</td>
                  <td className="r strong">{incidencia(i).toFixed(2)}%</td>
                  <td><button className="re-del" onClick={() => borrar(i.id)}>✕</button></td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="re-foot">
              <td colSpan={3}>TOTAL · <span className={`re-cumple ${resumen.cumple ? 'ok' : 'no'}`}>{resumen.cumple ? `✔ Cumple (≥ ${UMBRAL}%)` : `✗ No cumple (mín. ${UMBRAL}%)`}</span></td>
              <td className="r">{resumen.total.toFixed(4)} L</td>
              <td colSpan={3}></td>
              <td className="r">{resumen.pct.toFixed(2)}%</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Panel de proveedores calificados con documentos y vigencia */}
      <details className="re-normas" open={provOpen} onToggle={(e) => setProvOpen(e.target.open)}>
        <summary>🗂️ Proveedores calificados (documentos y vigencia)</summary>
        <div className="re-normas-body">
          <p>Base reutilizable de personas/empresas calificadas. Adjunta el documento (Excel/foto/PDF) que respalda la calificación e indica hasta cuándo es válido.</p>
          <p className="re-hint"><strong>Dos procesos:</strong> (1) <strong>Verificar calificación</strong> por RUC en el Ministerio (formulario), y (2) <strong>Cargar documentos</strong> — arrastra un <strong>PDF, foto o Excel</strong> y la <strong>IA lee</strong> el RUC, el nombre, la <strong>calificación</strong> y la <strong>vigencia (inicio–fin)</strong>, y los guarda solos. No necesitas escribir nada; los campos son opcionales (corrección manual).</p>
          {provEnr && <p className="re-hint" style={{ color: '#2563eb' }}>⏳ {provEnr}</p>}
          <div className="re-prov-form">
            <label className="re-f"><span>RUC</span>
              <input value={provForm.ruc}
                onChange={(e) => { const v = e.target.value; const p = proveedores.find((x) => (x.ruc || '') === v.trim()); provField(p ? { ruc: v, nombre: p.nombre || '', calificado: !!p.calificado, categoria: p.categoria || '', vigente_hasta: p.vigente_hasta || '' } : { ruc: v }) }}
                onBlur={() => provField({}, true)} placeholder="RUC" /></label>
            <button type="button" className="re-verif" onClick={verProvRuc}>🔎 Verificar</button>
            <label className="re-f wide"><span>Nombre / Empresa</span>
              <input value={provForm.nombre} onChange={(e) => provField({ nombre: e.target.value.toUpperCase() })} onBlur={() => provField({}, true)} /></label>
            <label className="re-f"><span>¿Calificado?</span>
              <span className="re-check"><input type="checkbox" checked={provForm.calificado} onChange={(e) => provField({ calificado: e.target.checked }, true)} /> {provForm.calificado ? 'Sí' : 'No'}</span></label>
            <label className="re-f"><span>Tipo de calificación</span>
              <input value={provForm.categoria} list="re-tipos" placeholder="MICROEMPRESA, ARTESANO…"
                onChange={(e) => provField({ categoria: e.target.value.toUpperCase() })} onBlur={() => provField({}, true)} /></label>
            <datalist id="re-tipos"><option value="MICROEMPRESA" /><option value="PEQUEÑA EMPRESA" /><option value="MEDIANA EMPRESA" /><option value="ARTESANO" /><option value="ORGANIZACIÓN EPS" /></datalist>
            <label className="re-f"><span>Válido hasta</span>
              <input type="date" value={provForm.vigente_hasta} onChange={(e) => provField({ vigente_hasta: e.target.value }, true)} /></label>
            <div className="re-f wide"><span>Documentos (PDF, foto o Excel — la IA extrae los datos)</span>
              <input ref={provFileRef} type="file" multiple accept=".xlsx,.xls,.csv,.pdf,image/*" style={{ display: 'none' }} onChange={(e) => subirDocs(e.target.files)} />
              <div className={`re-drop sm${provDragOver ? ' over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setProvDragOver(true) }}
                onDragLeave={() => setProvDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setProvDragOver(false); subirDocs(e.dataTransfer.files) }}
                onClick={() => provFileRef.current?.click()}>
                📥 Arrastra el/los documento(s) aquí — se leen y guardan solos (o haz clic)
              </div>
            </div>
          </div>

          <div className="re-table-wrap" style={{ marginTop: 10 }}>
            <table className="re-table">
              <thead><tr><th>RUC</th><th>Nombre / Empresa</th><th>Actividad (SRI)</th><th>Calificación</th><th>Vigencia (inicio – fin)</th><th>Documentos</th><th></th></tr></thead>
              <tbody>
                {proveedores.length === 0 ? (
                  <tr><td colSpan={7} className="re-empty">Sin proveedores guardados aún.</td></tr>
                ) : proveedores.map((p) => (
                  <tr key={p.id}>
                    <td>{p.ruc}</td>
                    <td>{p.nombre || '—'}</td>
                    <td className="actividad-sri" title={p.actividad || ''}>{p.actividad || '—'}</td>
                    <td>
                      <span className={`re-badge ${p.calificado ? 'ok' : 'no'}`}>{p.calificado ? (p.categoria || '✔ Calificado') : 'No'}</span>
                      {p.calificado && !p.categoria && <div className="re-cat" style={{ color: '#b45309' }}>Indica el tipo (microempresa, artesano…) en el formulario</div>}
                    </td>
                    <td>{(p.vigencia_inicio || p.vigente_hasta)
                      ? <span className={`re-badge ${estaVencido(p.vigente_hasta) ? 'no' : 'ok'}`}>{estaVencido(p.vigente_hasta) ? 'Vencido' : 'Vigente'}{(p.vigencia_inicio || p.vigente_hasta) ? ` · ${p.vigencia_inicio || '—'} → ${p.vigente_hasta || '—'}` : ''}</span>
                      : '—'}</td>
                    <td>{(p.documentos || []).length === 0 ? '—' : (p.documentos || []).map((d, k) => (
                      <button key={k} className="re-doclink" onClick={() => verDoc(d.path)} title={d.nombre}>📎 {d.nombre?.slice(0, 18) || 'doc'}</button>
                    ))}</td>
                    <td><button className="re-del" onClick={() => borrarProv(p.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* Gastos a clasificar (clasificador de gastos) */}
      <details className="re-normas" open={gastosOpen} onToggle={(e) => setGastosOpen(e.target.open)}>
        <summary>🏷️ Gastos (clasificados y calificados)</summary>
        <div className="re-normas-body">
          <p className="re-hint"><strong>Solo los gastos de este contribuyente</strong>: los proveedores que aparecen en sus facturas, con su <strong>categoría</strong>, <strong>calificación</strong> (tipo + vigencia) y <strong>actividad económica (SRI)</strong>. Los que faltan salen <strong>SIN CLASIFICAR</strong>. Doble clic en una celda para clasificar; clic para copiar.</p>
          <div className="cl-filters">
            <input list="g-ruc" placeholder="Filtrar RUC…" value={gfRuc} onChange={(e) => setGfRuc(e.target.value)} />
            <input list="g-nom" placeholder="Filtrar proveedor…" value={gfNombre} onChange={(e) => setGfNombre(e.target.value)} />
            <input list="g-act" placeholder="Filtrar actividad…" value={gfAct} onChange={(e) => setGfAct(e.target.value)} />
            <input list="g-cat" placeholder="Filtrar categoría…" value={gfCat} onChange={(e) => setGfCat(e.target.value)} />
            <select value={gfCalif} onChange={(e) => setGfCalif(e.target.value)}>
              <option value="todos">Calificación: todas</option>
              <option value="si">Solo calificados</option>
              <option value="no">No calificados</option>
            </select>
            <button type="button" className={`cl-chip ${gfSinClasif ? 'on' : ''}`} onClick={() => setGfSinClasif((v) => !v)}
              title="Mostrar solo los que faltan clasificar">🏷️ Sin clasificar{gNSinClasif ? ` (${gNSinClasif})` : ''}</button>
            <datalist id="g-ruc">{gOpc('ruc').map((v) => <option key={v} value={v} />)}</datalist>
            <datalist id="g-nom">{gOpc('nombre_proveedor').map((v) => <option key={v} value={v} />)}</datalist>
            <datalist id="g-act">{gOpc('actividad').map((v) => <option key={v} value={v} />)}</datalist>
            <datalist id="g-cat">{gOpc('categoria').map((v) => <option key={v} value={v} />)}</datalist>
            <input ref={gastosFileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => { if (e.target.files?.[0]) importarGastos(e.target.files[0]); e.target.value = '' }} />
            <button className="cl-clear" onClick={() => gastosFileRef.current?.click()}>📥 Importar Excel</button>
            <button className="cl-clear" onClick={exportarGastos}>📤 Exportar</button>
            {gastosEnr && <span className="cl-count" style={{ color: '#2563eb' }}>⏳ {gastosEnr}</span>}
            <span className="cl-count">{gastosFiltrados.length} de {gastosRows.length}</span>
          </div>
          <ClassifierTable classifications={gastosFiltrados} onClassificationsChange={loadGastos}
            onRowChange={onGastoRowChange} onRowDelete={onGastoRowDelete} opcionesCategoria={gOpc('categoria')} isAdmin={isSuperAdmin} />
        </div>
      </details>

      {producto && (
        <div className="re-normas" style={{ marginTop: 14 }}>
          <div className="re-normas-body">
            <p><strong>📋 Condiciones normativas de «{producto}»</strong> — determinan los beneficios en la declaración ICE:</p>
            <p style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <label><input type="checkbox" checked={cond.es_cerveza} onChange={(e) => setCondicion('es_cerveza', e.target.checked)} /> Es cerveza</label>
              <label title="Sin marca primigenia + nueva notificación sanitaria (Art. 199.5 RLRTI)"><input type="checkbox" checked={cond.nueva_marca} onChange={(e) => setCondicion('nueva_marca', e.target.checked)} /> Producto nuevo / nueva marca</label>
              <label title="Cupo anual del SRI (Art. 77.1 LRTI / Art. 199.4 RLRTI)"><input type="checkbox" checked={cond.cupo_anual_sri} onChange={(e) => setCondicion('cupo_anual_sri', e.target.checked)} /> Cupo anual SRI obtenido (exención)</label>
            </p>
            {(() => {
              const marcaOk = !cond.es_cerveza || cond.nueva_marca
              const rebajaOk = resumen.cumple && marcaOk
              const exencionOk = rebajaOk && cond.cupo_anual_sri
              return (
                <ul>
                  <li><span className={`re-badge ${rebajaOk ? 'ok' : 'no'}`}>{rebajaOk ? '✔' : '✗'}</span>{' '}<strong>Rebaja 50% tarifa específica</strong>: {resumen.cumple ? `cumple el ≥${UMBRAL}% nacional` : `no cumple el ≥${UMBRAL}% nacional`}{cond.es_cerveza && (cond.nueva_marca ? '; cerveza con nueva marca ✔' : '; cerveza SIN nueva marca')}.</li>
                  <li><span className={`re-badge ${exencionOk ? 'ok' : 'no'}`}>{exencionOk ? '✔' : '✗'}</span>{' '}<strong>Exención del ICE</strong>: requiere la rebaja y el <strong>cupo anual del SRI</strong>{cond.cupo_anual_sri ? ' ✔' : ' (sin marcar)'}.</li>
                </ul>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
