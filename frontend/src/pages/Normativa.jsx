import { useState, useEffect, useRef, useCallback } from 'react'
import { normativaAPI } from '../services/api'
import './Normativa.css'

/* Biblioteca de normativa: cuerpos legales presentados como libro.
   - Texto por página con navegación (◀ ▶, ir a página)
   - Búsqueda dentro del cuerpo legal (páginas + extracto, clic = ir)
   - Documentos reemplazables: subir nueva versión cuando la normativa cambie */

const fmtFecha = (iso) => {
  if (!iso) return ''
  try { return new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return '' }
}

export default function Normativa() {
  const [docs, setDocs] = useState([])
  const [doc, setDoc] = useState(null)        // documento abierto (slug)
  const [pagina, setPagina] = useState(1)
  const [contenido, setContenido] = useState(null) // { texto, num_paginas, titulo }
  const [irA, setIrA] = useState('')
  const [q, setQ] = useState('')
  const [resultados, setResultados] = useState(null) // null = sin búsqueda
  const [buscando, setBuscando] = useState(false)
  const [subiendo, setSubiendo] = useState('')
  const fileRef = useRef(null)
  const slugSubir = useRef(null)

  const cargarDocs = useCallback(() => {
    normativaAPI.list().then((r) => setDocs(r.data?.data || [])).catch(() => setDocs([]))
  }, [])
  useEffect(() => { cargarDocs() }, [cargarDocs])

  // Cargar página del libro abierto
  useEffect(() => {
    if (!doc) { setContenido(null); return }
    normativaAPI.pagina(doc, pagina)
      .then((r) => setContenido(r.data))
      .catch((e) => setContenido({ texto: 'No se pudo cargar la página: ' + (e.response?.data?.detail || e.message), num_paginas: 0 }))
  }, [doc, pagina])

  const abrir = (d) => {
    if (!d.num_paginas) { alert('Este documento aún no está cargado. Usa "Subir/Reemplazar PDF".'); return }
    setDoc(d.slug); setPagina(1); setResultados(null); setQ('')
  }
  const cerrar = () => { setDoc(null); setContenido(null); setResultados(null); setQ('') }

  const buscar = async () => {
    const term = q.trim()
    if (term.length < 2 || !doc) return
    setBuscando(true)
    try {
      const r = await normativaAPI.buscar(doc, term)
      setResultados(r.data)
    } catch (e) {
      alert('Error en la búsqueda: ' + (e.response?.data?.detail || e.message))
    } finally { setBuscando(false) }
  }

  const abrirPdf = async (slug) => {
    try {
      const r = await normativaAPI.pdfUrl(slug)
      if (r.data?.url) window.open(r.data.url, '_blank', 'noreferrer')
    } catch (e) { alert('PDF no disponible: ' + (e.response?.data?.detail || e.message)) }
  }

  const elegirArchivo = (slug) => { slugSubir.current = slug; fileRef.current?.click() }
  const subirArchivo = async (file) => {
    const slug = slugSubir.current
    if (!slug || !file) return
    setSubiendo(slug)
    try {
      const r = await normativaAPI.reemplazar(slug, file)
      alert(`✔ Documento actualizado: ${r.data?.titulo} (${r.data?.num_paginas} páginas).`)
      cargarDocs()
      if (doc === slug) { setPagina(1); setResultados(null) }
    } catch (e) {
      alert('Error al subir: ' + (e.response?.data?.detail || e.message))
    } finally {
      setSubiendo('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const numPag = contenido?.num_paginas || 0
  const docAbierto = docs.find((d) => d.slug === doc)

  // Resalta el término buscado en el texto de la página
  const resaltar = (texto) => {
    const term = (resultados?.q || '').trim()
    if (!term) return texto
    const partes = String(texto || '').split(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
    return partes.map((p, i) => p.toLowerCase() === term.toLowerCase() ? <mark key={i}>{p}</mark> : p)
  }

  return (
    <div className="nv-page">
      <header className="nv-header">
        <div>
          <h1>📖 Normativa</h1>
          <p className="nv-sub">Cuerpos legales consultables: busca dentro de cada documento y navega como un libro. Los textos pueden reemplazarse cuando la normativa se actualice.</p>
        </div>
      </header>

      <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files?.[0]) subirArchivo(e.target.files[0]) }} />

      {!doc ? (
        <div className="nv-grid">
          {docs.map((d) => (
            <div key={d.slug} className={`nv-card ${d.num_paginas ? '' : 'vacio'}`}>
              <div className="nv-card-icon">{d.slug === 'normativa-vigente' ? '📜' : '📕'}</div>
              <h2>{d.titulo}</h2>
              <p className="nv-card-desc">{d.descripcion}</p>
              <p className="nv-card-meta">
                {d.num_paginas
                  ? <>{d.num_paginas} páginas · actualizado {fmtFecha(d.updated_at)}{d.slug === 'normativa-vigente' && ' · vigente, sujeta a cambios'}</>
                  : 'Aún no cargado — sube el PDF'}
              </p>
              <div className="nv-card-btns">
                <button className="nv-btn primary" onClick={() => abrir(d)} disabled={!d.num_paginas}>📖 Leer y buscar</button>
                <button className="nv-btn" onClick={() => abrirPdf(d.slug)} disabled={!d.num_paginas}>⬇ PDF</button>
                <button className="nv-btn ghost" onClick={() => elegirArchivo(d.slug)} disabled={subiendo === d.slug}>
                  {subiendo === d.slug ? 'Subiendo…' : d.num_paginas ? '🔁 Reemplazar' : '⬆ Subir PDF'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="nv-libro">
          <div className="nv-libro-head">
            <button className="nv-btn ghost" onClick={cerrar}>← Documentos</button>
            <h2>{docAbierto?.titulo || contenido?.titulo}</h2>
            <button className="nv-btn" onClick={() => abrirPdf(doc)}>⬇ PDF original</button>
          </div>

          <div className="nv-buscador">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscar()}
              placeholder='🔍 Buscar en este cuerpo legal… ej: "rebaja", "Art. 199.5", "cupo anual"'
            />
            <button className="nv-btn primary" onClick={buscar} disabled={buscando || q.trim().length < 2}>
              {buscando ? 'Buscando…' : 'Buscar'}
            </button>
            {resultados && <button className="nv-btn ghost" onClick={() => { setResultados(null); setQ('') }}>✕ Limpiar</button>}
          </div>

          {resultados && (
            <div className="nv-resultados">
              <p className="nv-res-head">{resultados.total} página(s) con «{resultados.q}»{resultados.total >= 60 ? ' (primeras 60)' : ''}:</p>
              {resultados.total === 0 ? (
                <p className="nv-res-vacio">Sin coincidencias. Prueba con otra palabra (el texto se busca tal como aparece en el documento).</p>
              ) : (
                <ul>
                  {resultados.data.map((r) => (
                    <li key={r.pagina} onClick={() => setPagina(r.pagina)} className={r.pagina === pagina ? 'activo' : ''}>
                      <span className="nv-res-pag">pág. {r.pagina}</span>
                      <span className="nv-res-snippet">{r.snippet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="nv-pagina-nav">
            <button className="nv-btn" onClick={() => setPagina((p) => Math.max(1, p - 1))} disabled={pagina <= 1}>◀ Anterior</button>
            <span className="nv-pag-info">Página <strong>{pagina}</strong> de {numPag || '…'}</span>
            <button className="nv-btn" onClick={() => setPagina((p) => Math.min(numPag || p + 1, p + 1))} disabled={numPag > 0 && pagina >= numPag}>Siguiente ▶</button>
            <span className="nv-ir">
              Ir a: <input value={irA} onChange={(e) => setIrA(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const n = parseInt(irA, 10)
                  if (n >= 1 && (!numPag || n <= numPag)) { setPagina(n); setIrA('') }
                }} placeholder="N°" />
            </span>
          </div>

          <div className="nv-hoja">
            <pre>{resaltar(contenido?.texto || 'Cargando…')}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
