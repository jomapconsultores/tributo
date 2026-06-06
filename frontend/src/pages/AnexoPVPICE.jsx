import { useState, useRef, useMemo, useEffect } from 'react'
import { iceAPI, productsAPI, anexosAPI } from '../services/api'
import { useClients } from '../context/ClientContext'
import { periodoCorto } from '../utils/periodo'
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
  const [rucSel, setRucSel] = useState('')
  const [clientSel, setClientSel] = useState('')
  const [catalogo, setCatalogo] = useState([])
  const [catSel, setCatSel] = useState('')
  const [saved, setSaved] = useState([])
  const fileRef = useRef(null)

  // Contribuyentes únicos (RUC) y períodos del RUC elegido
  const contribs = []
  const vistosR = new Set()
  for (const c of clients) { if (!vistosR.has(c.identificacion)) { vistosR.add(c.identificacion); contribs.push(c) } }
  contribs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''))
  const periodosRuc = clients.filter((c) => c.identificacion === rucSel)
    .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))
  const clientIdsRuc = new Set(periodosRuc.map((c) => c.id))

  const cambiarRuc = (ident) => {
    setRucSel(ident)
    const list = clients.filter((c) => c.identificacion === ident)
      .sort((a, b) => (b.periodo_anio - a.periodo_anio) || (b.periodo_mes - a.periodo_mes))
    setClientSel(list[0]?.id || '')
  }

  // Catálogo del cliente (período) elegido
  useEffect(() => {
    if (!clientSel) { setCatalogo([]); return }
    productsAPI.byClient(clientSel).then((r) => setCatalogo(r.data?.data || [])).catch(() => setCatalogo([]))
  }, [clientSel])

  // Anexos del RUC (todos sus períodos) → "ver por RUC los anexos en general"
  const cargarAnexos = () => {
    if (!rucSel) { setSaved([]); return }
    anexosAPI.list().then((r) => {
      const all = r.data?.data || []
      setSaved(all.filter((a) => clientIdsRuc.has(a.client_id)))
    }).catch(() => setSaved([]))
  }
  useEffect(() => { cargarAnexos() }, [rucSel, clients.length])

  const guardarAnexo = async () => {
    if (!clientSel) { alert('Elige un cliente (RUC y período) para guardar.'); return }
    if (!tipo) { alert('No hay anexo para guardar.'); return }
    try {
      await anexosAPI.save(clientSel, tipo, { tipo, header, rows })
      cargarAnexos()
      alert('✔ Anexo guardado para el período seleccionado.')
    } catch (e) { alert('Error al guardar: ' + (e.response?.data?.detail || e.message)) }
  }

  const recuperarAnexo = (a) => {
    const d = a.datos || {}
    setTipo(d.tipo || a.tipo)
    setHeader(d.header || {})
    setRows(d.rows || [])
  }

  const borrarAnexo = async (id) => {
    if (!window.confirm('¿Eliminar este anexo guardado?')) return
    try { await anexosAPI.delete(id); cargarAnexos() }
    catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

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
        <button className="ax-btn teal" onClick={guardarAnexo} disabled={!tipo || !clientSel}>🗄 Guardar anexo</button>
      </div>

      {/* Relacionar productos */}
      <div className="ax-relate">
        <div className="ax-relate-group">
          <span className="ax-relate-lbl">RUC:</span>
          <select value={rucSel} onChange={(e) => cambiarRuc(e.target.value)}>
            <option value="">Contribuyente…</option>
            {contribs.map((c) => <option key={c.identificacion} value={c.identificacion}>{c.identificacion} — {c.nombre}</option>)}
          </select>
          <span className="ax-relate-lbl">Mes/Año:</span>
          <select value={clientSel} onChange={(e) => setClientSel(e.target.value)} disabled={!rucSel}>
            <option value="">Período…</option>
            {periodosRuc.map((c) => <option key={c.id} value={c.id}>{periodoCorto(c)}</option>)}
          </select>
          <button className="ax-btn teal" onClick={importarICEXML} disabled={!clientSel}>↪ Importar ventas ICE</button>
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

      {/* Anexos guardados del RUC (todos sus períodos) */}
      {rucSel && saved.length > 0 && (
        <div className="ax-saved">
          <span className="ax-saved-lbl">Anexos guardados del RUC:</span>
          {saved.map((a) => {
            const cli = clients.find((c) => c.id === a.client_id)
            return (
              <span key={a.id} className="ax-saved-item">
                <button className="ax-saved-load" onClick={() => recuperarAnexo(a)} title="Recuperar">
                  {a.tipo} · {cli ? periodoCorto(cli) : '—'} · {(a.datos?.rows?.length ?? 0)} filas
                </button>
                <button className="ax-saved-del" onClick={() => borrarAnexo(a.id)} title="Eliminar">✕</button>
              </span>
            )
          })}
        </div>
      )}

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
