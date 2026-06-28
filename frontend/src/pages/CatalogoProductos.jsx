import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import WorkflowGuide from '../components/WorkflowGuide'
import TarifaImpuestoBadge from '../components/TarifaImpuestoBadge'
import { IMPUESTO_LABEL } from '../utils/iceCalc'
import { buildCodProdICE, armarCodigo, descomponerCodigo, sinCeros } from '../utils/codigoICE'
import useDraft from '../hooks/useDraft'
import './CatalogoProductos.css'

const CAT_STEPS = [
  { icon: '📚', label: 'Catálogo Productos', current: true },
  { icon: '🧮', label: 'Cálculo ICE', path: '/calculo-ice' },
  { icon: '⚖️', label: 'Rebajas y Exenciones', path: '/rebajas-exenciones' },
  { icon: '🥃', label: 'ICE XML', path: '/ice' },
  { icon: '📄', label: 'Declaraciones ICE', path: '/declaracion-ice' },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

// Partes constitutivas del código de producto ICE (orden SRI)
const PARTES_DEF = [
  { key: 'impuesto', label: '1. Cód. Impuesto', lk: null },
  { key: 'clasificacion', label: '2. Clasificación', lk: null },
  { key: 'marca', label: '3. Marca (producto)', lk: null },
  { key: 'presentacion', label: '4. Presentación', lk: 'presentacion' },
  { key: 'capacidad', label: '5. Capacidad (ml)', lk: 'capacidad' },
  { key: 'unidad', label: '6. Unidad', lk: 'unidad' },
  { key: 'pais', label: '7. País', lk: 'pais' },
  { key: 'grado', label: '8. Grado alcohólico', lk: 'grado' },
]

const EMPTY = {
  nombre: '', cod_prod_sri: '', cod_prod_ice: '', cod_prod_pvp: '', cod_impuesto: '3031',
  cod_clasificacion: '', cod_pais: '593',
  capacidad: '750', grado: '15', presentacion: '13', unidad: '66', botellas_por_caja: 12,
}

export default function CatalogoProductos() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient, identsForSvc } = useClients()
  const ident = selectedClient?.identificacion
  const idents_svc = identsForSvc('declaracion_ice')

  const [rows, setRows] = useState([])
  const [form, setForm] = useDraft(ident ? `draft:productos:form:${ident}` : null, EMPTY)
  const [editId, setEditId] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!ident) { setRows([]); return }
    setLoading(true)
    try {
      const res = await productsAPI.list(ident)
      setRows(res.data?.data || [])
    } finally { setLoading(false) }
  }, [ident])
  useEffect(() => { load() }, [load])

  const codIce = buildCodProdICE({
    codSri: form.cod_prod_sri, clasificacion: form.cod_clasificacion, presentacion: form.presentacion,
    capacidad: form.capacidad, unidad: form.unidad, pais: form.cod_pais, grado: form.grado, codImpuesto: form.cod_impuesto,
  })

  // Listas auxiliares de la base (presentación, unidad, país, clasificación, etc.)
  const [lk, setLk] = useState({ presentacion: [], unidad: [], pais: [], capacidad: [], grado: [], clasificacion: [] })
  useEffect(() => { productsAPI.lookups?.().then((r) => setLk(r.data || {})).catch(() => {}) }, [])

  // Descripción oficial de la marca del formulario: busca el código en la matriz
  // (Códigos ICE) por código de marca + impuesto y despliega su descripción.
  const [formMarcaInfo, setFormMarcaInfo] = useState(null)
  useEffect(() => {
    const m = sinCeros(form.cod_prod_sri)
    if (!m || m === '0') { setFormMarcaInfo(null); return }
    const t = setTimeout(() => {
      productsAPI.searchCodigos(m, sinCeros(form.cod_impuesto) || '3031')
        .then((r) => {
          const data = r.data?.data || []
          setFormMarcaInfo(data.find((d) => sinCeros(d.marca) === m) || null)
        })
        .catch(() => setFormMarcaInfo(null))
    }, 250)
    return () => clearTimeout(t)
  }, [form.cod_prod_sri, form.cod_impuesto])

  // Descripción legible de la clasificación según su código (filtrada por impuesto)
  const clasifDesc = useCallback((cod, imp) => {
    const lista = lk.clasificacion || []
    const c = sinCeros(cod)
    if (!c || c === '0') return ''
    const found = lista.find((x) => sinCeros(x.codigo) === c && (!imp || String(x.impuesto) === String(imp)))
      || lista.find((x) => sinCeros(x.codigo) === c)
    return found?.descripcion || ''
  }, [lk])

  // Búsqueda en el catálogo oficial SRI (autocompletado, desde 1 letra)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  useEffect(() => {
    const q = busqueda.trim()
    if (q.length < 1) { setResultados([]); return }
    const t = setTimeout(() => {
      productsAPI.searchCodigos(q).then((r) => setResultados(r.data?.data || [])).catch(() => setResultados([]))
    }, 200)
    return () => clearTimeout(t)
  }, [busqueda])

  const elegirCodigo = (m) => {
    setForm((f) => ({
      ...f,
      nombre: (m.descripcion || '').toUpperCase(),
      cod_prod_sri: m.marca,
      cod_impuesto: m.impuesto || '3031',
      cod_clasificacion: m.clasif_cod || '',
    }))
    setBusqueda(''); setResultados([])
  }

  const guardar = async () => {
    if (!form.nombre.trim()) { alert('El nombre del producto es obligatorio.'); return }
    const payload = { ...form, cod_prod_ice: codIce, cod_prod_pvp: form.cod_prod_pvp || form.cod_prod_sri }
    try {
      if (editId) await productsAPI.update(editId, payload)
      else await productsAPI.create({ identificacion: ident, ...payload })
      setForm(EMPTY); setEditId(null)
      await load()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }
  const editar = (p) => { setEditId(p.id); setForm({ ...EMPTY, ...p }) }
  const cancelar = () => { setEditId(null); setForm(EMPTY) }

  // ── Panel de partes del código: clic en el código de un producto lo desglosa ──
  const [partesId, setPartesId] = useState(null)   // producto cuyo código se desglosa
  const [partes, setPartes] = useState(null)       // las 8 partes editables
  const [marcaInfo, setMarcaInfo] = useState(null) // nombre oficial de la marca (Códigos ICE)

  const abrirPartes = (p) => {
    if (partesId === p.id) { cerrarPartes(); return }
    setPartesId(p.id)
    // Desglosa el código completo; si no existe, parte de los campos guardados
    const base = (p.cod_prod_ice || '').includes('-')
      ? descomponerCodigo(p.cod_prod_ice)
      : { impuesto: p.cod_impuesto || '3031', clasificacion: p.cod_clasificacion || '57',
          marca: p.cod_prod_sri || p.cod_prod_pvp || '', presentacion: p.presentacion || '13',
          capacidad: p.capacidad || '750', unidad: p.unidad || '66',
          pais: p.cod_pais || '593', grado: p.grado || '15' }
    setPartes(base)
    setMarcaInfo(null)
  }
  const cerrarPartes = () => { setPartesId(null); setPartes(null); setMarcaInfo(null) }
  const setParte = (k, v) => setPartes((pp) => ({ ...pp, [k]: v }))
  const codigoArmado = partes ? armarCodigo(partes) : ''
  const prodPartes = rows.find((p) => p.id === partesId)

  // Nombre oficial de la marca según la BD de Códigos ICE
  useEffect(() => {
    if (!partes) { setMarcaInfo(null); return }
    const m = sinCeros(partes.marca)
    if (!m || m === '0') { setMarcaInfo(null); return }
    const t = setTimeout(() => {
      productsAPI.searchCodigos(m, sinCeros(partes.impuesto) || '3031')
        .then((r) => {
          const data = r.data?.data || []
          setMarcaInfo(data.find((d) => sinCeros(d.marca) === m) || null)
        })
        .catch(() => setMarcaInfo(null))
    }, 250)
    return () => clearTimeout(t)
  }, [partesId, partes?.marca, partes?.impuesto])

  const lkDesc = (key, val) => {
    const f = (lk[key] || []).find((x) => sinCeros(x.codigo) === sinCeros(val))
    return f?.descripcion || ''
  }

  const guardarPartes = async () => {
    if (!prodPartes || !partes) return
    try {
      await productsAPI.update(prodPartes.id, {
        cod_prod_ice: codigoArmado,
        cod_impuesto: sinCeros(partes.impuesto),
        cod_clasificacion: sinCeros(partes.clasificacion),
        cod_prod_sri: sinCeros(partes.marca),
        cod_prod_pvp: prodPartes.cod_prod_pvp || sinCeros(partes.marca),
        presentacion: sinCeros(partes.presentacion),
        capacidad: sinCeros(partes.capacidad),
        unidad: sinCeros(partes.unidad),
        cod_pais: sinCeros(partes.pais),
        grado: sinCeros(partes.grado),
      })
      await load()
      cerrarPartes()
    } catch (e) { alert('Error al guardar: ' + (e.response?.data?.detail || e.message)) }
  }
  const borrar = async (id) => {
    if (!window.confirm('¿Eliminar este producto del catálogo?')) return
    try { await productsAPI.delete(id); if (editId === id) cancelar(); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon="📚" title="Catálogo de Productos" subtitle="Productos y códigos SRI para la declaración ICE" idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Declaración ICE" />
  }

  return (
    <div className="cp-page">
      <WorkflowGuide steps={CAT_STEPS} />
      <header className="cp-header">
        <div>
          <h1>📚 Catálogo de productos</h1>
          <p className="cp-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre}
            {selectedClient.periodo_anio ? ` · ${selectedClient.periodo_anio}` : ''}</p>
        </div>
        <TarifaImpuestoBadge codImpuesto={form.cod_impuesto} anio={selectedClient.periodo_anio || new Date().getFullYear()} />
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      <p className="cp-note">Los productos se guardan por contribuyente (RUC) y se comparten entre todos sus períodos. Estos códigos se usan al emitir el Anexo PVP+ICE.</p>

      {/* Buscador en el catálogo oficial SRI */}
      <div className="cp-search">
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="🔍 Buscar marca en el catálogo oficial SRI (ICE bebidas alcohólicas)…"
        />
        {resultados.length > 0 && (
          <ul className="cp-results">
            {resultados.map((m) => (
              <li key={`${m.impuesto}-${m.marca}`} onMouseDown={() => elegirCodigo(m)}>
                <span className="cp-res-desc">{m.descripcion}</span>
                <span className="cp-res-meta">{m.clasificacion} · marca {m.marca} · imp {m.impuesto}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Formulario — 8 espacios del código (leídos de la base) en orden */}
      <div className="cp-form">
        <label className="cp-f wide"><span>Producto *</span>
          <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value.toUpperCase() })} placeholder="Nombre del producto" /></label>
        <label className="cp-f s"><span>1. Cód. Impuesto</span>
          <input value={form.cod_impuesto} onChange={(e) => setForm({ ...form, cod_impuesto: e.target.value })} />
          <small className="cp-parte-desc">{IMPUESTO_LABEL[String(form.cod_impuesto || '').trim()] || ''}</small></label>
        <label className="cp-f s"><span>2. Clasificación</span>
          <input list="lk-clasif" value={form.cod_clasificacion} onChange={(e) => setForm({ ...form, cod_clasificacion: e.target.value })} />
          <small className="cp-parte-desc">{clasifDesc(form.cod_clasificacion, form.cod_impuesto) || (sinCeros(form.cod_clasificacion) !== '0' ? 'Clasificación no encontrada' : 'Elige una clasificación')}</small></label>
        <label className="cp-f s"><span>3. Marca</span>
          <input value={form.cod_prod_sri} onChange={(e) => setForm({ ...form, cod_prod_sri: e.target.value })} placeholder="código" />
          <small className="cp-parte-desc">{formMarcaInfo?.descripcion || (sinCeros(form.cod_prod_sri) !== '0' ? 'Marca no encontrada en Códigos ICE' : 'Ingresa o busca la marca arriba')}</small></label>
        <label className="cp-f"><span>4. Presentación</span>
          <input list="lk-pres" value={form.presentacion} onChange={(e) => setForm({ ...form, presentacion: e.target.value })} /></label>
        <label className="cp-f"><span>5. Capacidad (ml)</span>
          <input list="lk-cap" value={form.capacidad} onChange={(e) => setForm({ ...form, capacidad: e.target.value })} /></label>
        <label className="cp-f"><span>6. Unidad</span>
          <input list="lk-und" value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} /></label>
        <label className="cp-f"><span>7. País</span>
          <input list="lk-pais" value={form.cod_pais} onChange={(e) => setForm({ ...form, cod_pais: e.target.value })} /></label>
        <label className="cp-f s"><span>8. Grado %</span>
          <input list="lk-grado" value={form.grado} onChange={(e) => setForm({ ...form, grado: e.target.value })} /></label>
        <label className="cp-f s"><span>Bot/Caja</span>
          <input type="number" value={form.botellas_por_caja} onChange={(e) => setForm({ ...form, botellas_por_caja: e.target.value })} /></label>
        <label className="cp-f"><span>Cód. PVP</span>
          <input value={form.cod_prod_pvp} onChange={(e) => setForm({ ...form, cod_prod_pvp: e.target.value })} placeholder={form.cod_prod_sri || '—'} /></label>
        <datalist id="lk-pres">{(lk.presentacion || []).slice(0, 400).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <datalist id="lk-cap">{(lk.capacidad || []).slice(0, 600).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <datalist id="lk-und">{(lk.unidad || []).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <datalist id="lk-pais">{(lk.pais || []).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <datalist id="lk-grado">{(lk.grado || []).slice(0, 400).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <datalist id="lk-clasif">{(lk.clasificacion || []).filter((x) => !form.cod_impuesto || String(x.impuesto) === String(form.cod_impuesto)).slice(0, 400).map((x) => <option key={`${x.impuesto}-${x.codigo}`} value={x.codigo}>{x.descripcion}</option>)}</datalist>
        <button className="cp-btn primary" onClick={guardar}>{editId ? '💾 Guardar' : '＋ Agregar'}</button>
        {editId && <button className="cp-btn ghost" onClick={cancelar}>Cancelar</button>}
      </div>

      {/* Vista previa del código (se arma solo) */}
      <div className="cp-codes">
        <div><span className="cp-codes-lbl">Código individual:</span> <code>{form.cod_prod_sri || '—'}</code></div>
        <div><span className="cp-codes-lbl">Código completo ICE:</span> <code className="cp-full">{codIce || '— ingresa el código individual —'}</code></div>
      </div>

      {/* Tabla */}
      <div className="cp-table-wrap">
        {loading ? <div className="cp-empty">Cargando…</div> : rows.length === 0 ? (
          <div className="cp-empty">Sin productos. Agrega el primero con el formulario.</div>
        ) : (
          <div className="cp-scroll">
            <table className="cp-table">
              <thead><tr>
                <th className="r">#</th><th>Producto</th><th>Clasificación</th><th>Cód. SRI</th><th>Cód. completo ICE</th><th>Cód. PVP</th><th className="r">Cap.</th><th className="r">Grado</th>
                <th className="r">Pres.</th><th className="r">Und</th><th className="r">Bot/Caja</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr key={p.id} className={`${editId === p.id ? 'cp-editing' : ''} ${partesId === p.id ? 'cp-partes-sel' : ''}`}>
                    <td className="r cp-rownum">{i + 1}</td>
                    <td>{p.nombre}</td>
                    <td className="cp-clasif" title={`Código ${sinCeros(p.cod_clasificacion) || '—'}`}>
                      {clasifDesc(p.cod_clasificacion, p.cod_impuesto)
                        || (sinCeros(p.cod_clasificacion) !== '0' ? sinCeros(p.cod_clasificacion) : <span className="cp-falta">—</span>)}
                    </td>
                    <td className="cp-cod cp-click" title="Clic para desglosar el código en sus 8 partes" onClick={() => abrirPartes(p)}>{p.cod_prod_sri || '—'}</td>
                    <td className="cp-cod cp-click" title="Clic para desglosar el código en sus 8 partes" onClick={() => abrirPartes(p)}>{p.cod_prod_ice || <span className="cp-falta">— clic para armarlo —</span>}</td>
                    <td className="cp-cod">{p.cod_prod_pvp || '—'}</td>
                    <td className="r">{p.capacidad}</td><td className="r">{p.grado}</td>
                    <td className="r">{p.presentacion}</td><td className="r">{p.unidad}</td><td className="r">{p.botellas_por_caja}</td>
                    <td className="cp-actions">
                      <button onClick={() => editar(p)} title="Editar">✏️</button>
                      <button onClick={() => borrar(p.id)} title="Eliminar">🗑</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Panel: partes constitutivas del código del producto seleccionado */}
      {prodPartes && partes && (
        <div className="cp-partes">
          <div className="cp-partes-head">
            <h2>🧩 Partes del código — {prodPartes.nombre}</h2>
            <button className="cp-btn ghost" onClick={cerrarPartes}>✕ Cerrar</button>
          </div>
          <div className="cp-partes-grid">
            {PARTES_DEF.map((pd) => (
              <label key={pd.key} className="cp-f">
                <span>{pd.label}</span>
                <input
                  list={pd.lk ? `lk-${pd.lk === 'presentacion' ? 'pres' : pd.lk === 'capacidad' ? 'cap' : pd.lk === 'unidad' ? 'und' : pd.lk}` : undefined}
                  value={partes[pd.key] || ''}
                  onChange={(e) => setParte(pd.key, e.target.value)}
                />
                <small className="cp-parte-desc">
                  {pd.key === 'impuesto' && (marcaInfo?.impuesto_nombre || (sinCeros(partes.impuesto) === '3031' ? 'ICE BEBIDAS ALCOHÓLICAS' : ''))}
                  {pd.key === 'clasificacion' && (marcaInfo?.clasificacion || '')}
                  {pd.key === 'marca' && (marcaInfo?.descripcion || (sinCeros(partes.marca) !== '0' ? 'Marca no encontrada en Códigos ICE' : 'Ingresa el código de la marca'))}
                  {pd.key === 'pais' && (lkDesc('pais', partes.pais) || (sinCeros(partes.pais) === '593' ? 'ECUADOR' : ''))}
                  {pd.lk && pd.key !== 'pais' && lkDesc(pd.lk, partes[pd.key])}
                </small>
              </label>
            ))}
          </div>
          <div className="cp-partes-foot">
            <div>
              <span className="cp-codes-lbl">Código armado:</span>{' '}
              <code className="cp-full">{codigoArmado}</code>
            </div>
            <button className="cp-btn primary" onClick={guardarPartes}>💾 Guardar en el producto</button>
          </div>
        </div>
      )}
    </div>
  )
}
