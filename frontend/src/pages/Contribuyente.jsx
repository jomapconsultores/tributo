import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { compradoresAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import './Contribuyente.css'

const TIPO_ID = { '04': 'RUC', '05': 'Cédula', '06': 'Pasaporte', '07': 'Consumidor final', '08': 'Id. exterior' }

export default function Contribuyente() {
  const { clients } = useClients()
  const [searchParams, setSearchParams] = useSearchParams()
  const identParam = searchParams.get('ident') || ''

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [busqueda, setBusqueda] = useState('')
  const [fRuc, setFRuc] = useState('')
  const [fCliente, setFCliente] = useState('')
  const [fContrib, setFContrib] = useState('')
  const [abiertos, setAbiertos] = useState(() => new Set(identParam ? [identParam] : []))

  // Nombre del contribuyente por RUC (desde la tabla clients)
  const nombreContrib = useMemo(() => {
    const m = {}
    for (const c of clients) if (!m[c.identificacion]) m[c.identificacion] = c.nombre || ''
    return m
  }, [clients])

  const cargar = async () => {
    setLoading(true)
    try {
      const r = await compradoresAPI.list()
      setRows(r.data?.data || [])
    } catch { setRows([]) }
    finally { setLoading(false) }
  }
  useEffect(() => { cargar() }, [])

  useEffect(() => {
    if (identParam) setAbiertos((s) => new Set([...s, identParam]))
  }, [identParam])

  const sincronizar = async () => {
    try {
      const r = await compradoresAPI.sync()
      await cargar()
      alert(`✔ ${r.data?.total ?? 0} cliente(s) sincronizados desde las ventas ICE.`)
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const borrar = async (id) => {
    if (!window.confirm('¿Eliminar este cliente guardado?')) return
    try { await compradoresAPI.delete(id); await cargar() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  // Filtros: buscador global + por encabezado (ruc, cliente, contribuyente)
  const filtradas = useMemo(() => {
    const q = busqueda.trim().toUpperCase()
    const fr = fRuc.trim().toUpperCase()
    const fc = fCliente.trim().toUpperCase()
    const ft = fContrib.trim().toUpperCase()
    return rows.filter((r) => {
      const contribTxt = `${r.identificacion} ${nombreContrib[r.identificacion] || ''}`.toUpperCase()
      if (identParam && r.identificacion !== identParam) return false
      if (fr && !String(r.ruc || '').toUpperCase().includes(fr)) return false
      if (fc && !String(r.nombre || '').toUpperCase().includes(fc)) return false
      if (ft && !contribTxt.includes(ft)) return false
      if (q && !(`${r.ruc} ${r.nombre} ${contribTxt}`.toUpperCase().includes(q))) return false
      return true
    })
  }, [rows, busqueda, fRuc, fCliente, fContrib, identParam, nombreContrib])

  // Clasificado por contribuyente (grupos desplegables), clientes ordenados
  const grupos = useMemo(() => {
    const g = new Map()
    for (const r of filtradas) {
      if (!g.has(r.identificacion)) g.set(r.identificacion, [])
      g.get(r.identificacion).push(r)
    }
    const lista = [...g.entries()].map(([ident, items]) => ({
      ident,
      nombre: nombreContrib[ident] || '(contribuyente no registrado)',
      items: items.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || '')),
    }))
    lista.sort((a, b) => a.nombre.localeCompare(b.nombre))
    return lista
  }, [filtradas, nombreContrib])

  const toggle = (ident) => setAbiertos((s) => {
    const n = new Set(s)
    if (n.has(ident)) n.delete(ident)
    else n.add(ident)
    return n
  })

  const hayFiltro = busqueda || fRuc || fCliente || fContrib

  return (
    <div className="ct-page">
      <header className="ct-header">
        <div>
          <h1>👥 Contribuyente — Clientes importados</h1>
          <p className="ct-sub">
            Clientes (compradores) guardados automáticamente al importar las ventas, clasificados por contribuyente.
            Se usan en el Anexo PVP+ICE cuando se requieren.
          </p>
        </div>
        <button className="ct-btn teal" onClick={sincronizar}>↻ Sincronizar desde ventas ICE</button>
      </header>

      {/* Buscador superior */}
      <div className="ct-search">
        <input
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="🔍 Buscar al cliente por RUC, nombre o contribuyente…"
        />
        {identParam && (
          <button className="ct-chip" onClick={() => setSearchParams({})} title="Quitar filtro de contribuyente">
            Contribuyente: {nombreContrib[identParam] || identParam} ✕
          </button>
        )}
      </div>

      {/* Filtros por encabezado */}
      <div className="ct-filters">
        <label><span>RUC (cliente)</span>
          <input value={fRuc} onChange={(e) => setFRuc(e.target.value)} placeholder="Filtrar RUC…" /></label>
        <label><span>Cliente</span>
          <input value={fCliente} onChange={(e) => setFCliente(e.target.value)} placeholder="Filtrar cliente…" /></label>
        <label><span>Contribuyente</span>
          <input value={fContrib} onChange={(e) => setFContrib(e.target.value)} placeholder="Filtrar contribuyente…" /></label>
      </div>

      {loading ? (
        <div className="ct-empty">Cargando…</div>
      ) : grupos.length === 0 ? (
        <div className="ct-empty">
          {rows.length === 0
            ? 'Aún no hay clientes guardados. Importa ventas ICE (XML) o usa "↻ Sincronizar desde ventas ICE".'
            : 'Ningún cliente coincide con la búsqueda o los filtros.'}
        </div>
      ) : (
        grupos.map((g) => {
          const abierto = abiertos.has(g.ident) || Boolean(hayFiltro)
          return (
            <div key={g.ident} className="ct-grupo">
              <button className="ct-grupo-head" onClick={() => toggle(g.ident)}>
                <span className={`ct-caret ${abierto ? 'open' : ''}`}>▸</span>
                <span className="ct-grupo-nombre">{g.nombre}</span>
                <span className="ct-grupo-ruc">RUC {g.ident}</span>
                <span className="ct-grupo-count">{g.items.length} cliente(s)</span>
              </button>
              {abierto && (
                <table className="ct-table">
                  <thead>
                    <tr><th>RUC</th><th>Cliente</th><th>Contribuyente</th><th>Tipo ID</th><th></th></tr>
                  </thead>
                  <tbody>
                    {g.items.map((r) => (
                      <tr key={r.id}>
                        <td className="ct-mono">{r.ruc}</td>
                        <td>{r.nombre || '—'}</td>
                        <td>{g.nombre} <span className="ct-dim">({g.ident})</span></td>
                        <td>{TIPO_ID[r.tipo_id] || r.tipo_id || '—'}</td>
                        <td><button className="ct-del" onClick={() => borrar(r.id)} title="Eliminar">✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
