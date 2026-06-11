import { useState, useRef, useMemo, useEffect } from 'react'
import { iceAPI, productsAPI, anexosAPI, compradoresAPI, downloadBlob } from '../services/api'
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

const DEFAULT_ROW = (tipo) => {
  const r = {}
  COLS[tipo].forEach((c) => {
    if (['devICE', 'cantProdBajaICE', 'ventaICE'].includes(c)) r[c] = '0' // el SRI exige enteros (botellas)
    else if (['precioPVP', 'precioExPVP', 'gramoAzucar'].includes(c)) r[c] = '0.00'
    else if (c === 'tipoVentaICE') r[c] = '1'
    else r[c] = ''
  })
  return r
}

// El validador del SRI rechaza vocales con tilde/diéresis (la Ñ sí es válida)
const sinTildes = (s) => String(s ?? '')
  .replace(/[ÁÀÂÄ]/g, 'A').replace(/[ÉÈÊË]/g, 'E').replace(/[ÍÌÎÏ]/g, 'I')
  .replace(/[ÓÒÔÖ]/g, 'O').replace(/[ÚÙÛÜ]/g, 'U')
  .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i')
  .replace(/[óòôö]/g, 'o').replace(/[úùûü]/g, 'u')

const esc = (s) => sinTildes(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const childText = (parent, tag) => {
  for (const el of parent.children) if (el.tagName === tag) return el.textContent || ''
  return ''
}
const childEl = (parent, tag) => {
  for (const el of parent.children) if (el.tagName === tag) return el
  return null
}

// tipoIdentificacionComprador (factura) → tipoIdCliente (anexo ICE)
const TIPO_ID_LETRA = { '04': 'R', '05': 'C', '06': 'P', '07': 'F', '08': 'F' }

// '12.00' → '12' en los campos de cantidad del anexo ICE (el SRI exige enteros)
const normalizarCantidades = (tipo, r) => {
  if (tipo !== 'ICE') return r
  const out = { ...r }
  for (const c of ['ventaICE', 'devICE', 'cantProdBajaICE']) {
    const m = String(out[c] ?? '').trim().match(/^(\d+)(?:[.,]0+)?$/)
    if (m) out[c] = m[1]
  }
  return out
}

const dig = (v) => String(v || '').replace(/\D/g, '')
const pad = (v, n) => dig(v).padStart(n, '0')
const sinCeros = (v) => String(parseInt(dig(v) || '0', 10))

// Arma el código completo: impuesto-clasificación-marca-presentación-capacidad-unidad-país-grado
const armarCodigo = (p) =>
  `${dig(p.impuesto) || '3031'}-${pad(p.clasificacion || '57', 3)}-${pad(p.marca, 6)}-${pad(p.presentacion || '13', 3)}-${pad(p.capacidad || '750', 6)}-${dig(p.unidad) || '66'}-${pad(p.pais || '593', 3)}-${pad(p.grado || '15', 6)}`

// Descompone un código completo en sus 8 partes; si no tiene el formato, inicia con defaults
const descomponerCodigo = (cod) => {
  const seg = String(cod || '').trim().split('-')
  if (seg.length === 8) {
    return { impuesto: seg[0], clasificacion: seg[1], marca: seg[2], presentacion: seg[3], capacidad: seg[4], unidad: seg[5], pais: seg[6], grado: seg[7] }
  }
  return { impuesto: dig(cod) || '3031', clasificacion: '057', marca: '', presentacion: '013', capacidad: '000750', unidad: '66', pais: '593', grado: '000015' }
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
  const [compradores, setCompradores] = useState([])
  const [compSel, setCompSel] = useState('')
  const [tipoImport, setTipoImport] = useState('ICE')
  const [saved, setSaved] = useState([])
  const [savedId, setSavedId] = useState(null) // anexo guardado en edición (para actualizar, no duplicar)
  const [filtro, setFiltro] = useState('')
  const [busqCod, setBusqCod] = useState('')
  const [resCod, setResCod] = useState([])
  const [selRow, setSelRow] = useState(null) // fila cuyo código se descompone abajo
  const [partes, setPartes] = useState(null)
  const [marcaInfo, setMarcaInfo] = useState(null)
  const [lk, setLk] = useState({ presentacion: [], capacidad: [], unidad: [], pais: [], grado: [] })
  const fileRef = useRef(null)

  const codField = tipo === 'PVP' ? 'codProdPVP' : 'codProdICE'

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

  // Clientes importados (compradores) del contribuyente elegido
  useEffect(() => {
    if (!rucSel) { setCompradores([]); return }
    compradoresAPI.list(rucSel).then((r) => setCompradores(r.data?.data || [])).catch(() => setCompradores([]))
  }, [rucSel])

  // Listas auxiliares de la base oficial (presentación, capacidad, unidad, país, grado)
  useEffect(() => {
    productsAPI.lookups().then((r) => setLk(r.data || {})).catch(() => {})
  }, [])

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
      if (savedId) {
        await anexosAPI.update(savedId, tipo, { tipo, header, rows })
        alert('✔ Anexo actualizado en la base de datos.')
      } else {
        const res = await anexosAPI.save(clientSel, tipo, { tipo, header, rows })
        if (res.data?.id) setSavedId(res.data.id)
        alert('✔ Anexo guardado en la base de datos para el período seleccionado.')
      }
      cargarAnexos()
    } catch (e) { alert('Error al guardar: ' + (e.response?.data?.detail || e.message)) }
  }

  const recuperarAnexo = (a) => {
    const d = a.datos || {}
    const t = d.tipo || a.tipo
    setTipo(t)
    setHeader(d.header || {})
    setRows((d.rows || []).map((r) => normalizarCantidades(t, r)))
    setSavedId(a.id)
    cerrarPanel()
  }

  const borrarAnexo = async (id) => {
    if (!window.confirm('¿Eliminar este anexo guardado?')) return
    try {
      await anexosAPI.delete(id)
      if (id === savedId) setSavedId(null)
      cargarAnexos()
    } catch (e) { alert('Error: ' + (e.response?.data?.detail || e.message)) }
  }

  const importarVentas = async () => {
    if (!clientSel) { alert('Elige un cliente.'); return }
    try {
      const res = await iceAPI.anexoRows(clientSel, header.actImport || '02', tipoImport)
      const d = res.data
      const t = d.tipo || tipoImport
      setTipo(t)
      setHeader(d.header || {})
      setRows((d.rows || []).map((v) => ({ ...DEFAULT_ROW(t), ...v })))
      setSavedId(null)
      cerrarPanel()
      if (d.advertencias?.length) {
        alert('⚠ ' + d.advertencias.join(' ') + '\nUsa el buscador de códigos o haz clic en el código para corregirlo aquí mismo.')
      }
    } catch (e) {
      alert('Error al importar: ' + (e.response?.data?.detail || e.message))
    }
  }

  // Añade una fila y la deja seleccionada: lo siguiente que se elija
  // (producto o cliente) se junta en esa MISMA línea.
  const agregarFilaActiva = (datos, t) => {
    setRows((rs) => {
      setSelRow(rs.length)
      return [...rs, { ...DEFAULT_ROW(t), ...datos }]
    })
    setPartes(null); setMarcaInfo(null)
  }

  // Producto del catálogo del cliente: llena la fila seleccionada o crea una nueva
  const agregarDelCatalogo = (id) => {
    const p = catalogo.find((c) => c.id === id)
    if (!p) return
    const t = tipo || 'ICE'
    if (!tipo) initVacio('ICE')
    const datos = t === 'ICE'
      ? { codProdICE: p.cod_prod_ice || '3031', nombreProducto: p.nombre || '' }
      : { codProdPVP: p.cod_prod_pvp || '', nombreProducto: p.nombre || '' }
    if (selRow != null && tipo) {
      setRows((rs) => rs.map((r, idx) => (idx === selRow ? { ...r, ...datos } : r)))
      if (partes) setPartes(descomponerCodigo(datos[codField]))
    } else {
      agregarFilaActiva(datos, t)
    }
    setCatSel('')
  }

  // Cliente importado: completa idCliente/tipoIdCliente en la fila seleccionada
  // (misma línea que el producto) o crea una fila nueva y la deja activa
  const aplicarComprador = (id) => {
    const c = compradores.find((x) => x.id === id)
    if (!c) return
    const letra = TIPO_ID_LETRA[c.tipo_id] || (['R', 'C', 'P', 'F'].includes(c.tipo_id) ? c.tipo_id : 'F')
    if (tipo === 'PVP') { alert('El anexo PVP no lleva cliente por fila.'); setCompSel(''); return }
    if (selRow != null && tipo) {
      setRows((rs) => rs.map((r, idx) => (idx === selRow ? { ...r, idCliente: c.ruc, tipoIdCliente: letra } : r)))
    } else {
      if (!tipo) initVacio('ICE')
      agregarFilaActiva({ idCliente: c.ruc, tipoIdCliente: letra }, 'ICE')
    }
    setCompSel('')
  }

  const initVacio = (t) => {
    const h = {}
    HEADER[t].forEach((c) => { h[c] = c === 'codigoOperativo' ? t : '' })
    h.TipoIDInformante = 'R'
    if (t === 'ICE') h.actImport = '02'
    const contrib = clients.find((c) => c.identificacion === rucSel)
    if (contrib) { h.IdInformante = contrib.identificacion; h.razonSocial = sinTildes(contrib.nombre || '') }
    const per = clients.find((c) => c.id === clientSel)
    if (per) { h.Anio = String(per.periodo_anio || ''); h.Mes = String(per.periodo_mes || '').padStart(2, '0') }
    setTipo(t); setHeader(h); setRows([])
    setSavedId(null)
    cerrarPanel()
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
          nuevas.push(normalizarCantidades(t, r))
        }
      }
      setTipo(t); setHeader(h); setRows(nuevas)
      setSavedId(null)
      cerrarPanel()

      // Relación automática con la base de datos: si el XML trae IdInformante
      // (RUC) y/o razonSocial, se busca el contribuyente y su período y se
      // seleccionan, para que el anexo quede ligado al cliente correcto.
      const rucXml = String(h.IdInformante || '').replace(/\D/g, '').trim()
      const razonXml = sinTildes(String(h.razonSocial || '')).toUpperCase().trim()
      let contrib = rucXml && clients.find((c) => String(c.identificacion || '').replace(/\D/g, '') === rucXml)
      if (!contrib && razonXml) {
        contrib = clients.find((c) => sinTildes(String(c.nombre || '')).toUpperCase().trim() === razonXml)
      }
      if (contrib) {
        setRucSel(contrib.identificacion)
        const anioXml = String(h.Anio || '').trim()
        const mesXml = String(h.Mes || '').replace(/\D/g, '').padStart(2, '0')
        const periodos = clients.filter((c) => c.identificacion === contrib.identificacion)
        const per = periodos.find((c) => String(c.periodo_anio) === anioXml &&
          String(c.periodo_mes).padStart(2, '0') === mesXml) || periodos[0]
        setClientSel(per?.id || '')
      } else if (rucXml || razonXml) {
        alert('ℹ El RUC/razón social del XML no coincide con ningún contribuyente guardado. '
          + 'El anexo se cargó igual; selecciona el RUC manualmente si deseas guardarlo ligado a un cliente.')
      }
    } catch (e) {
      alert('Error al leer el XML: ' + e.message)
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const setH = (k, v) => setHeader((p) => ({ ...p, [k]: v }))
  const setR = (i, k, v) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)))
  const addRow = () => { if (tipo) setRows((rs) => [...rs, DEFAULT_ROW(tipo)]) }
  const delRow = (i) => {
    setRows((rs) => rs.filter((_, idx) => idx !== i))
    if (selRow === i) cerrarPanel()
    else if (selRow != null && i < selRow) setSelRow(selRow - 1)
  }
  const limpiar = () => {
    if (window.confirm('¿Borrar todo el contenido en pantalla?')) {
      setTipo(null); setHeader({}); setRows([]); setSavedId(null); setFiltro('')
      cerrarPanel()
    }
  }

  // Selecciona la fila activa (sin abrir el panel de partes): el producto o
  // cliente que se elija arriba se junta en esta línea
  const seleccionarFila = (i) => {
    if (i === selRow) return
    setSelRow(i)
    setPartes(null)
    setMarcaInfo(null)
  }

  // ── Panel de partes constitutivas del código ──────────────────────────────
  const abrirPanel = (i) => {
    setSelRow(i)
    setPartes(descomponerCodigo(rows[i]?.[codField]))
  }
  const cerrarPanel = () => { setSelRow(null); setPartes(null); setMarcaInfo(null) }
  const setParte = (k, v) => setPartes((p) => ({ ...p, [k]: v }))
  const codigoArmado = partes ? armarCodigo(partes) : ''
  const aplicarPartes = () => {
    if (selRow == null || !partes) return
    setR(selRow, codField, codigoArmado)
  }

  // Nombre oficial de la marca/clasificación/impuesto según la BD de Códigos ICE
  useEffect(() => {
    if (selRow == null || !partes) { setMarcaInfo(null); return }
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
  }, [selRow, partes?.marca, partes?.impuesto])

  const lkDesc = (key, val) => {
    const f = (lk[key] || []).find((x) => sinCeros(x.codigo) === sinCeros(val))
    return f?.descripcion || ''
  }

  // ── Buscador en el catálogo oficial de Códigos ICE ────────────────────────
  useEffect(() => {
    const q = busqCod.trim()
    if (q.length < 2) { setResCod([]); return }
    const t = setTimeout(() => {
      productsAPI.searchCodigos(q, '').then((r) => setResCod(r.data?.data || [])).catch(() => setResCod([]))
    }, 250)
    return () => clearTimeout(t)
  }, [busqCod])

  const elegirOficial = (m) => {
    if (selRow != null && partes) {
      // Panel abierto: aplica impuesto/clasificación/marca a las partes
      setPartes((p) => ({ ...p, impuesto: m.impuesto || '3031', clasificacion: m.clasif_cod || '57', marca: m.marca || '' }))
    } else if (selRow != null && tipo) {
      // Fila seleccionada: junta el producto en esa misma línea
      setRows((rs) => rs.map((r, idx) => {
        if (idx !== selRow) return r
        const nuevo = { ...r }
        if (tipo === 'ICE') {
          nuevo.codProdICE = armarCodigo({ ...descomponerCodigo(r.codProdICE), impuesto: m.impuesto || '3031', clasificacion: m.clasif_cod || '57', marca: m.marca || '' })
        } else {
          nuevo.codProdPVP = m.marca || ''
        }
        if (!nuevo.nombreProducto) nuevo.nombreProducto = (m.descripcion || '').toUpperCase()
        return nuevo
      }))
    } else {
      // Sin fila seleccionada: crea una nueva y la deja activa
      const t = tipo || 'ICE'
      if (!tipo) initVacio('ICE')
      const cod = armarCodigo({ impuesto: m.impuesto, clasificacion: m.clasif_cod, marca: m.marca, presentacion: '13', capacidad: '750', unidad: '66', pais: '593', grado: '15' })
      const datos = t === 'ICE'
        ? { codProdICE: cod, nombreProducto: (m.descripcion || '').toUpperCase() }
        : { codProdPVP: m.marca || '', nombreProducto: (m.descripcion || '').toUpperCase() }
      agregarFilaActiva(datos, t)
    }
    setBusqCod(''); setResCod([])
  }

  // ── Filtro de filas (busca en códigos, cliente y nombre de producto) ──────
  const visibles = useMemo(() => {
    const todas = rows.map((r, i) => ({ r, i }))
    const f = filtro.trim().toUpperCase()
    if (!f || !tipo) return todas
    const campos = [...COLS[tipo], 'nombreProducto']
    return todas.filter(({ r }) => campos.some((c) => String(r[c] || '').toUpperCase().includes(f)))
  }, [rows, filtro, tipo])

  const hayNombre = rows.some((r) => r.nombreProducto)
  const codInvalido = (r) => !(String(r[codField] || '').includes('-'))

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

  // Validación previa: el validador del SRI rechaza elementos vacíos y
  // cantidades con decimales (ventaICE/devICE/cantProdBajaICE son enteros)
  const validar = () => {
    const errs = []
    HEADER[tipo].forEach((c) => {
      if (c === 'tipoCarga') return // opcional en el esquema PVP
      if (!String(header[c] || '').trim()) errs.push(`Cabecera: «${c}» está vacío`)
    })
    if (String(header.Anio || '').trim() && !/^\d{4}$/.test(String(header.Anio).trim()))
      errs.push('Cabecera: «Anio» debe tener 4 dígitos (ej. 2026)')
    if (String(header.Mes || '').trim() && !/^(0[1-9]|1[0-2])$/.test(String(header.Mes).trim()))
      errs.push('Cabecera: «Mes» debe ser 01 a 12')
    rows.forEach((r, i) => {
      const n = `Fila ${i + 1}${r.nombreProducto ? ` (${String(r.nombreProducto).slice(0, 30)})` : ''}`
      COLS[tipo].forEach((c) => {
        if (c === 'fechaFinPVP') return // opcional
        if (!String(r[c] || '').trim()) errs.push(`${n}: «${c}» está vacío`)
      })
      if (tipo === 'ICE') {
        for (const c of ['ventaICE', 'devICE', 'cantProdBajaICE']) {
          const v = String(r[c] ?? '').trim()
          if (v && !/^\d+$/.test(v)) errs.push(`${n}: «${c}» debe ser un entero sin decimales (tiene '${v}')`)
        }
      }
    })
    return errs
  }

  const descargar = () => {
    if (!tipo) { alert('No hay datos para generar.'); return }
    const errs = validar()
    if (errs.length) {
      const detalle = errs.slice(0, 15).join('\n') + (errs.length > 15 ? `\n…y ${errs.length - 15} más` : '')
      if (!window.confirm(`⚠ El SRI rechazará este XML:\n\n${detalle}\n\n¿Generar de todas formas?`)) return
    }
    const blob = new Blob([xml], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = nombreArchivo('xml')
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Nombre estándar: Anexo{ICE|PVP}_RUC_nombre_mes_año
  const nombreArchivo = (ext) => {
    const ruc = String(header.IdInformante || '').replace(/\D/g, '')
    const nom = sinTildes(header.razonSocial || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 20)
    const mes = String(header.Mes || '').replace(/\D/g, '').padStart(2, '0')
    return `Anexo${tipo}_${ruc}_${nom}_${mes}_${header.Anio || ''}.${ext}`
  }

  const exportarExcel = async () => {
    if (!tipo) { alert('No hay datos para exportar.'); return }
    try {
      const r = await anexosAPI.exportExcel(tipo, header, rows)
      downloadBlob(r.data, nombreArchivo('xlsx'))
    } catch (e) { alert('Error al exportar Excel: ' + (e.response?.data?.detail || e.message)) }
  }

  const exportarPdf = async () => {
    if (!tipo) { alert('No hay datos para exportar.'); return }
    try {
      const r = await anexosAPI.exportPdf(tipo, header, rows)
      downloadBlob(r.data, nombreArchivo('pdf'))
    } catch (e) { alert('Error al exportar PDF: ' + (e.response?.data?.detail || e.message)) }
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
        <button className="ax-btn teal" onClick={guardarAnexo} disabled={!tipo || !clientSel}>
          {savedId ? '🗄 Actualizar anexo' : '🗄 Guardar anexo'}
        </button>
        <button className="ax-btn green" onClick={exportarExcel} disabled={!tipo}>📊 Exportar Excel</button>
        <button className="ax-btn red" onClick={exportarPdf} disabled={!tipo}>📑 Exportar PDF</button>
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
          <span className="ax-relate-lbl">Importar como:</span>
          <select value={tipoImport} onChange={(e) => setTipoImport(e.target.value)}>
            <option value="ICE">Anexo ICE</option>
            <option value="PVP">Anexo PVP</option>
          </select>
          <button className="ax-btn teal" onClick={importarVentas} disabled={!clientSel}>↪ Importar ventas</button>
        </div>
        <div className="ax-relate-group">
          <span className="ax-relate-lbl">Cliente importado:</span>
          <select value={compSel} disabled={!rucSel} onChange={(e) => { setCompSel(e.target.value); if (e.target.value) aplicarComprador(e.target.value) }}>
            <option value="">{rucSel ? (compradores.length ? (selRow != null ? 'Aplicar a la fila seleccionada…' : 'Añadir fila con cliente…') : 'Sin clientes guardados') : 'Elige un RUC primero'}</option>
            {compradores.map((c) => <option key={c.id} value={c.id}>{c.nombre || c.ruc} — {c.ruc}</option>)}
          </select>
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

      {/* Buscador en el catálogo oficial de Códigos ICE del SRI */}
      <div className="ax-search-official">
        <input
          value={busqCod}
          onChange={(e) => setBusqCod(e.target.value)}
          placeholder="🔍 Buscar producto o código en el catálogo oficial SRI (Códigos ICE)… ej: WHISKY RED DIEZ"
        />
        {resCod.length > 0 && (
          <ul className="ax-results">
            {resCod.map((m) => (
              <li key={`${m.impuesto}-${m.marca}`} onMouseDown={() => elegirOficial(m)}>
                <span className="ax-res-desc">{m.descripcion}</span>
                <span className="ax-res-meta">
                  {m.clasificacion} · marca {m.marca} · imp {m.impuesto}
                  {selRow != null ? ' — clic para aplicar a la fila seleccionada' : ' — clic para añadir fila'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Anexos guardados del RUC (todos sus períodos) */}
      {rucSel && saved.length > 0 && (
        <div className="ax-saved">
          <span className="ax-saved-lbl">Anexos guardados del RUC:</span>
          {saved.map((a) => {
            const cli = clients.find((c) => c.id === a.client_id)
            return (
              <span key={a.id} className={`ax-saved-item${a.id === savedId ? ' activo' : ''}`}>
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
            <div className="ax-detail-head">
              <h2 className="ax-card-title">Detalle de productos (ventas) — {filtro ? `${visibles.length} de ${rows.length}` : rows.length}</h2>
              <input
                className="ax-filter"
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="🔍 Filtrar por producto, código o cliente…"
              />
            </div>
            <p className="ax-hint">
              Haz clic en una fila para seleccionarla: el producto (catálogo o buscador) y el cliente importado que elijas
              se juntan en esa misma línea. Clic en el código de producto para ver y editar sus partes abajo.
            </p>
            <div className="ax-scroll">
              <table className="ax-table">
                <thead>
                  <tr>
                    {hayNombre && <th>Producto (referencia)</th>}
                    {COLS[tipo].map((c) => <th key={c}>{c}</th>)}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.length === 0 ? (
                    <tr><td colSpan={COLS[tipo].length + (hayNombre ? 2 : 1)} className="ax-empty">
                      {rows.length === 0 ? 'Sin productos. Usa "➕ Añadir producto".' : 'Ningún producto coincide con el filtro.'}
                    </td></tr>
                  ) : visibles.map(({ r, i }) => (
                    <tr key={i} className={`${i === selRow ? 'ax-row-sel' : ''} ${codInvalido(r) ? 'ax-row-bad' : ''}`}>
                      {hayNombre && (
                        <td><input value={r.nombreProducto || ''} onFocus={() => seleccionarFila(i)} onChange={(e) => setR(i, 'nombreProducto', e.target.value)} /></td>
                      )}
                      {COLS[tipo].map((c) => (
                        <td key={c} className={c === codField ? 'ax-cod-cell' : ''}>
                          <input
                            value={r[c] || ''}
                            onChange={(e) => setR(i, c, e.target.value)}
                            onFocus={c === codField ? () => abrirPanel(i) : () => seleccionarFila(i)}
                            title={c === codField ? 'Clic para descomponer el código abajo' : undefined}
                          />
                        </td>
                      ))}
                      <td><button className="ax-del" onClick={() => delRow(i)} title="Quitar">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Panel: partes constitutivas del código de producto */}
          {selRow != null && partes && rows[selRow] && (
            <div className="ax-card ax-partes">
              <div className="ax-partes-head">
                <h2 className="ax-card-title">
                  🧩 Partes del código — fila {selRow + 1}
                  {rows[selRow].nombreProducto ? ` · ${rows[selRow].nombreProducto}` : ''}
                </h2>
                <button className="ax-btn ghost" onClick={cerrarPanel}>✕ Cerrar</button>
              </div>
              <div className="ax-partes-grid">
                {PARTES_DEF.map((p) => (
                  <label key={p.key} className="ax-field">
                    <span>{p.label}</span>
                    <input
                      list={p.lk ? `ax-lk-${p.key}` : undefined}
                      value={partes[p.key] || ''}
                      onChange={(e) => setParte(p.key, e.target.value)}
                    />
                    <small className="ax-parte-desc">
                      {p.key === 'impuesto' && (marcaInfo?.impuesto_nombre || (sinCeros(partes.impuesto) === '3031' ? 'ICE BEBIDAS ALCOHÓLICAS' : ''))}
                      {p.key === 'clasificacion' && (marcaInfo?.clasificacion || '')}
                      {p.key === 'marca' && (marcaInfo?.descripcion || (sinCeros(partes.marca) !== '0' ? 'Marca no encontrada en Códigos ICE' : 'Ingresa o busca la marca arriba'))}
                      {p.key === 'pais' && (lkDesc('pais', partes.pais) || (sinCeros(partes.pais) === '593' ? 'ECUADOR' : ''))}
                      {p.lk && p.key !== 'pais' && lkDesc(p.lk, partes[p.key])}
                    </small>
                  </label>
                ))}
              </div>
              <datalist id="ax-lk-presentacion">{(lk.presentacion || []).slice(0, 400).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
              <datalist id="ax-lk-capacidad">{(lk.capacidad || []).slice(0, 600).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
              <datalist id="ax-lk-unidad">{(lk.unidad || []).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
              <datalist id="ax-lk-pais">{(lk.pais || []).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
              <datalist id="ax-lk-grado">{(lk.grado || []).slice(0, 400).map((x) => <option key={x.codigo} value={x.codigo}>{x.descripcion}</option>)}</datalist>
              <div className="ax-partes-foot">
                <div>
                  <span className="ax-partes-lbl">Código armado:</span>
                  <code className="ax-partes-cod">{codigoArmado}</code>
                </div>
                <button className="ax-btn green" onClick={aplicarPartes}>✔ Aplicar a la fila</button>
              </div>
            </div>
          )}

          <div className="ax-card">
            <h2 className="ax-card-title">Vista previa del XML</h2>
            <pre className="ax-preview">{xml}</pre>
          </div>
        </>
      )}
    </div>
  )
}
