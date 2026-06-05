import { useState, useRef, useMemo, useEffect } from 'react'
import { iceAPI, productsAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import './AnexoPVPICE.css'

// Columnas de detalle (ventas/vta) según el esquema SRI
const COLS = {
  ICE: ['codProdICE', 'gramoAzucar', 'tipoIdCliente', 'idCliente', 'tipoVentaICE', 'ventaICE', 'devICE', 'cantProdBajaICE'],
  PVP: ['codProdPVP', 'gramoAzucar', 'precioExPVP', 'precioPVP', 'fechaInPVP', 'fechaFinPVP'],
}

// Campos de cabecera (orden exacto exigido por el SRI)
const HEADER = {
  ICE: ['TipoIDInformante', 'IdInformante', 'razonSocial', 'Anio', 'Mes', 'actImport', 'codigoOperativo'],
  PVP: ['TipoIDInformante', 'IdInformante', 'razonSocial', 'Anio', 'Mes', 'tipoCarga', 'codigoOperativo'],
}

const DEFAULT_ROW = (tipo) => {
  const r = {}
  COLS[tipo].forEach((c) => {
    if (['devICE', 'cantProdBajaICE'].includes(c)) r[c] = '0'
    else if (['ventaICE', 'precioPVP', 'precioExPVP'].includes(c)) r[c] = '0.00'
    else r[c] = ''
  })
  return r
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const childText = (parent, tag) => {
  for (const el of parent.children) if (el.tagName === tag) return el.textContent || ''
  return ''
}
const childEl = (parent, tag) => {
  for (const el of parent.children) if (el.tagName === tag) return el
  return null
}

export default function AnexoPVPICE() {
  const { clients } = useClients()
  const [tipo, setTipo] = useState(null) // 'ICE' | 'PVP'
  const [header, setHeader] = useState({})
  const [rows, setRows] = useState([])
  const [clientSel, setClientSel] = useState('')
  const [catalogo, setCatalogo] = useState([])
  const [catSel, setCatSel] = useState('')
  const fileRef = useRef(null)

  // El catálogo "desde catálogo" es el del cliente elegido (sus productos guardados)
  useEffect(() => {
    if (!clientSel) { setCatalogo([]); return }
    productsAPI.byClient(clientSel).then((r) => setCatalogo(r.data?.data || [])).catch(() => setCatalogo([]))
  }, [clientSel])

  const importarICEXML = async () => {
    if (!clientSel) { alert('Elige un cliente.'); return }
    try {
      const res = await iceAPI.anexoRows(clientSel, header.actImport || '02')
      const d = res.data
      setTipo('ICE')
      setHeader(d.header || {})
      setRows((d.rows || []).map((v) => ({ ...DEFAULT_ROW('ICE'), ...v })))
      if (d.advertencias?.length) alert('⚠ ' + d.advertencias.join(' '))
    } catch (e) {
      alert('Error al importar: ' + (e.response?.data?.detail || e.message))
    }
  }

  const agregarDelCatalogo = (id) => {
    const p = catalogo.find((c) => c.id === id)
    if (!p) return
    const t = tipo || 'ICE'
    if (!tipo) initVacio('ICE')
    const r = DEFAULT_ROW(t)
    if (t === 'ICE') r.codProdICE = p.cod_prod_ice || '3031'
    else r.codProdPVP = p.cod_prod_pvp || ''
    setRows((rs) => [...rs, r])
    setCatSel('')
  }

  const initVacio = (t) => {
    const h = {}
    HEADER[t].forEach((c) => { h[c] = c === 'codigoOperativo' ? t : '' })
    setTipo(t); setHeader(h); setRows([])
  }

  const cargarXml = async (file) => {
    try {
      const text = await file.text()
      const doc = new DOMParser().parseFromString(text, 'application/xml')
      if (doc.querySelector('parsererror')) throw new Error('XML inválido')
      const root = doc.documentElement
      const t = (root.tagName || '').toUpperCase()
      if (t !== 'ICE' && t !== 'PVP') throw new Error('La raíz debe ser <ice> o <pvp>')
      const h = {}
      HEADER[t].forEach((c) => { h[c] = childText(root, c) })
      const ventas = childEl(root, 'ventas')
      const nuevas = []
      if (ventas) {
        for (const vta of ventas.children) {
          if (vta.tagName !== 'vta') continue
          const r = {}
          COLS[t].forEach((c) => { r[c] = childText(vta, c) })
          nuevas.push(r)
        }
      }
      setTipo(t); setHeader(h); setRows(nuevas)
    } catch (e) {
      alert('Error al leer el XML: ' + e.message)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const setH = (k, v) => setHeader((p) => ({ ...p, [k]: v }))
  const setR = (i, k, v) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const addRow = () => { if (tipo) setRows((rs) => [...rs, DEFAULT_ROW(tipo)]) }
  const delRow = (i) => setRows((rs) => rs.filter((_, idx) => idx !== i))
  const limpiar = () => { if (window.confirm('¿Borrar todo el contenido en pantalla?')) { setTipo(null); setHeader({}); setRows([]) } }

  const xml = useMemo(() => {
    if (!tipo) return ''
    const root = tipo.toLowerCase()
    let s = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    s += `<${root}>\n`
    HEADER[tipo].forEach((c) => { s += `  <${c}>${esc(header[c])}</${c}>\n` })
    s += '  <ventas>\n'
    rows.forEach((r) => {
      s += '    <vta>\n'
      COLS[tipo].forEach((c) => { s += `      <${c}>${esc(r[c])}</${c}>\n` })
      s += '    </vta>\n'
    })
    s += '  </ventas>\n'
    s += `</${root}>`
    return s
  }, [tipo, header, rows])

  const descargar = () => {
    if (!tipo) { alert('No hay datos para generar.'); return }
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${tipo}_MODIFICADO.xml`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="ax-page">
      <header className="ax-header">
        <div>
          <h1>📄 Anexo PVP+ICE</h1>
          <p className="ax-sub">Editor de anexos SRI: carga un XML (ICE o PVP), edita cabecera y productos, y regenera el XML.</p>
        </div>
        {tipo && <span className={`ax-badge ${tipo.toLowerCase()}`}>Anexo {tipo}</span>}
      </header>

      <div className="ax-toolbar">
        <input ref={fileRef} type="file" accept=".xml" style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.[0]) cargarXml(e.target.files[0]) }} />
        <button className="ax-btn blue" onClick={() => fileRef.current?.click()}>📂 Cargar XML</button>
        <button className="ax-btn green" onClick={addRow} disabled={!tipo}>➕ Añadir producto</button>
        <button className="ax-btn red" onClick={limpiar}>🧹 Limpiar todo</button>
        <button className="ax-btn yellow" onClick={descargar} disabled={!tipo}>💾 Generar XML SRI</button>
      </div>

      {/* Relacionar productos */}
      <div className="ax-relate">
        <div className="ax-relate-group">
          <span className="ax-relate-lbl">Desde ICE-XML:</span>
          <select value={clientSel} onChange={(e) => setClientSel(e.target.value)}>
            <option value="">Cliente…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.identificacion} — {c.nombre}</option>)}
          </select>
          <button className="ax-btn teal" onClick={importarICEXML}>↪ Importar ventas ICE</button>
        </div>
        <div className="ax-relate-group">
          <span className="ax-relate-lbl">Desde catálogo del cliente:</span>
          <select value={catSel} disabled={!clientSel} onChange={(e) => { setCatSel(e.target.value); if (e.target.value) agregarDelCatalogo(e.target.value) }}>
            <option value="">{clientSel ? (catalogo.length ? 'Agregar producto…' : 'Sin productos en su catálogo') : 'Elige un cliente primero'}</option>
            {catalogo.map((p) => {
              const cod = tipo === 'PVP' ? p.cod_prod_pvp : p.cod_prod_ice
              return <option key={p.id} value={p.id}>{p.nombre}{cod ? '' : ' (sin código)'}</option>
            })}
          </select>
        </div>
      </div>

      {!tipo ? (
        <div className="ax-init">
          <p>Carga un XML existente, o crea un anexo nuevo desde cero:</p>
          <div className="ax-init-btns">
            <button className="ax-btn blue" onClick={() => initVacio('ICE')}>Nuevo Anexo ICE</button>
            <button className="ax-btn blue" onClick={() => initVacio('PVP')}>Nuevo Anexo PVP</button>
          </div>
        </div>
      ) : (
        <>
          <div className="ax-card">
            <h2 className="ax-card-title">Datos generales del contribuyente</h2>
            <div className="ax-grid">
              {HEADER[tipo].map((c) => (
                <label key={c} className="ax-field">
                  <span>{c}</span>
                  <input value={header[c] || ''} onChange={(e) => setH(c, e.target.value)} />
                </label>
              ))}
            </div>
          </div>

          <div className="ax-card">
            <h2 className="ax-card-title">Detalle de productos (ventas) — {rows.length}</h2>
            <div className="ax-scroll">
              <table className="ax-table">
                <thead>
                  <tr>
                    {COLS[tipo].map((c) => <th key={c}>{c}</th>)}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={COLS[tipo].length + 1} className="ax-empty">Sin productos. Usa "➕ Añadir producto".</td></tr>
                  ) : rows.map((r, i) => (
                    <tr key={i}>
                      {COLS[tipo].map((c) => (
                        <td key={c}><input value={r[c] || ''} onChange={(e) => setR(i, c, e.target.value)} /></td>
                      ))}
                      <td><button className="ax-del" onClick={() => delRow(i)} title="Quitar">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="ax-card">
            <h2 className="ax-card-title">Vista previa del XML</h2>
            <pre className="ax-preview">{xml}</pre>
          </div>
        </>
      )}
    </div>
  )
}
