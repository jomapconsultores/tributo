import { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import ClientSwitcher from '../components/ClientSwitcher'
import './CatalogoProductos.css'

const EMPTY = {
  nombre: '', cod_prod_ice: '', cod_prod_pvp: '',
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

  const guardar = async () => {
    if (!form.nombre.trim()) { alert('El nombre del producto es obligatorio.'); return }
    try {
      if (editId) await productsAPI.update(editId, form)
      else await productsAPI.create({ identificacion: ident, ...form })
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

      {/* Formulario */}
      <div className="cp-form">
        <label className="cp-f wide"><span>Producto *</span>
          <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value.toUpperCase() })} placeholder="Nombre del producto" /></label>
        <label className="cp-f"><span>Cód. Prod. ICE</span>
          <input value={form.cod_prod_ice} onChange={(e) => setForm({ ...form, cod_prod_ice: e.target.value })} placeholder="3031-057-…" /></label>
        <label className="cp-f"><span>Cód. Prod. PVP</span>
          <input value={form.cod_prod_pvp} onChange={(e) => setForm({ ...form, cod_prod_pvp: e.target.value })} /></label>
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

      {/* Tabla */}
      <div className="cp-table-wrap">
        {loading ? <div className="cp-empty">Cargando…</div> : rows.length === 0 ? (
          <div className="cp-empty">Sin productos. Agrega el primero con el formulario.</div>
        ) : (
          <div className="cp-scroll">
            <table className="cp-table">
              <thead><tr>
                <th>Producto</th><th>Cód. ICE</th><th>Cód. PVP</th><th className="r">Cap.</th><th className="r">Grado</th>
                <th className="r">Pres.</th><th className="r">Und</th><th className="r">Bot/Caja</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={editId === p.id ? 'cp-editing' : ''}>
                    <td>{p.nombre}</td>
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
