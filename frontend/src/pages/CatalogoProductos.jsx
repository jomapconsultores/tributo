import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import { buildCodProdICE } from '../utils/codigoICE'
import './CatalogoProductos.css'

const EMPTY = {
  nombre: '', cod_prod_sri: '', cod_prod_ice: '', cod_prod_pvp: '', cod_impuesto: '3031',
  cod_clasificacion: '', cod_pais: '593',
  capacidad: '750', grado: '15', presentacion: '13', unidad: '66', botellas_por_caja: 12,
}

export default function CatalogoProductos() {
  const { openNewClient } = useOutletContext()
  const { clients, selectedClient, selectClient } = useClients()
  const ident = selectedClient?.identificacion

  const [rows, setRows] = useState([])
  const [form, setForm] = useState(EMPTY)
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

  // Búsqueda en el catálogo oficial SRI (autocompletado)
  const [busqueda, setBusqueda] = useState('')
  const [resultados, setResultados] = useState([])
  useEffect(() => {
    const q = busqueda.trim()
    if (q.length < 2) { setResultados([]); return }
    const t = setTimeout(() => {
      productsAPI.searchCodigos(q).then((r) => setResultados(r.data?.data || [])).catch(() => setResultados([]))
    }, 250)
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
  const borrar = async (id) => {
    if (!window.confirm('¿Eliminar este producto del catálogo?')) return
    try { await productsAPI.delete(id); if (editId === id) cancelar(); await load() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  if (!selectedClient) {
    return (
      <div className="cp-page">
        <div className="cp-welcome">
          <h1>📚 Catálogo de productos</h1>
          <p>Selecciona un contribuyente (RUC) para administrar sus productos y códigos SRI.</p>
          <button className="cp-btn primary" onClick={openNewClient}>＋ Nuevo cliente</button>
        </div>
        {clients.length > 0 && (
          <div className="cp-grid">
            {clients.map((c) => (
              <button key={c.id} className="cp-card" onClick={() => selectClient(c.id)}>
                <div className="cp-card-id">{c.identificacion}</div>
                <div className="cp-card-name">{c.nombre}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="cp-page">
      <header className="cp-header">
        <div>
          <h1>📚 Catálogo de productos</h1>
          <p className="cp-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} />

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

      {/* Formulario */}
      <div className="cp-form">
        <label className="cp-f wide"><span>Producto *</span>
          <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value.toUpperCase() })} placeholder="Nombre del producto" /></label>
        <label className="cp-f"><span>Cód. SRI individual</span>
          <input value={form.cod_prod_sri} onChange={(e) => setForm({ ...form, cod_prod_sri: e.target.value })} placeholder="6 dígitos" /></label>
        <label className="cp-f"><span>Cód. Prod. PVP</span>
          <input value={form.cod_prod_pvp} onChange={(e) => setForm({ ...form, cod_prod_pvp: e.target.value })} placeholder={form.cod_prod_sri || '—'} /></label>
        <label className="cp-f s"><span>Cap. (ml)</span>
          <input value={form.capacidad} onChange={(e) => setForm({ ...form, capacidad: e.target.value })} /></label>
        <label className="cp-f s"><span>Grado %</span>
          <input value={form.grado} onChange={(e) => setForm({ ...form, grado: e.target.value })} /></label>
        <label className="cp-f s"><span>Present.</span>
          <input value={form.presentacion} onChange={(e) => setForm({ ...form, presentacion: e.target.value })} /></label>
        <label className="cp-f s"><span>Unidad</span>
          <input value={form.unidad} onChange={(e) => setForm({ ...form, unidad: e.target.value })} /></label>
        <label className="cp-f s"><span>Bot/Caja</span>
          <input type="number" value={form.botellas_por_caja} onChange={(e) => setForm({ ...form, botellas_por_caja: e.target.value })} /></label>
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
                <th>Producto</th><th>Cód. SRI</th><th>Cód. completo ICE</th><th>Cód. PVP</th><th className="r">Cap.</th><th className="r">Grado</th>
                <th className="r">Pres.</th><th className="r">Und</th><th className="r">Bot/Caja</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={editId === p.id ? 'cp-editing' : ''}>
                    <td>{p.nombre}</td>
                    <td className="cp-cod">{p.cod_prod_sri || '—'}</td>
                    <td className="cp-cod">{p.cod_prod_ice || <span className="cp-falta">— falta —</span>}</td>
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
    </div>
  )
}
