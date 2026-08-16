import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { devolucionesIvaAPI, invoicesAPI, downloadBlob } from '../services/api'
import { fmtMoney, msgFueraPeriodo, msgIdentAjena } from '../utils/format'
import { nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import UploadPanel from '../components/UploadPanel'
import WorkflowGuide from '../components/WorkflowGuide'
import { setEnviadorDevolucionHref, SRI_DEVOLUCION_URL } from '../utils/enviadorDevolucion'
import BajadorSRI from '../components/BajadorSRI'
import './DevolucionesIva.css'

const DV_STEPS = [
  { icon: '📥', label: 'Gastos (subir TXT/XML)', path: '/' },
  { icon: '📄', label: 'Declaraciones IVA', path: '/declaracion-iva' },
  { icon: '👵', label: 'Devolución IVA', current: true },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

const ESTADO_LABEL = {
  borrador: '📝 Borrador',
  presentada: '📤 Presentada',
  aprobada: '✅ Aprobada',
  rechazada: '❌ Rechazada',
}

// Mes (1-12) de un comprobante por su fecha 'dd/mm/aaaa' (o 'aaaa-mm-dd').
function mesDeFecha(fecha) {
  const s = String(fecha || '').trim()
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[3], 10) }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return { mes: parseInt(m[2], 10), anio: parseInt(m[1], 10) }
  return { mes: null, anio: null }
}

// Cada beneficiario tiene su propia pantalla porque el trámite en el SRI también
// son dos aplicaciones distintas, con requisitos propios: la de discapacidad
// valida el registro en el MSP y deja fuera los bienes del art. 96 de la LOD.
const BENEFICIARIOS = {
  tercera_edad: {
    icono: '👵',
    titulo: 'Devolución IVA — Adultos mayores',
    subtitulo: 'Devolución de IVA para personas de la tercera edad',
    baseRbu: '5 RBU de base imponible por mes (LRTI art. 74)',
    avisos: [],
  },
  discapacidad: {
    icono: '♿',
    titulo: 'Devolución IVA — Personas con discapacidad',
    subtitulo: 'Devolución de IVA para personas con discapacidad y sus sustitutos',
    baseRbu: '2 RBU de base imponible por mes, en proporción al grado (LRTI art. 74 / LOD art. 78)',
    avisos: [
      'El SRI toma el porcentaje de discapacidad del registro del MSP: si el contribuyente no está registrado (o el sustituto en el MDT/MIES), el portal no deja ni empezar la solicitud. El porcentaje que se carga acá sirve para calcular el tope, no se envía.',
      'Los bienes del art. 96 de la Ley Orgánica de Discapacidades no van por este canal: se presentan físicamente en un Centro de Atención del SRI.',
    ],
  },
}

export default function DevolucionesIvaTerceraEdad({ beneficiario = 'tercera_edad' }) {
  const { openNewClient } = useOutletContext()
  const { selectedClient, identsForSvc } = useClients()
  const idents_svc = identsForSvc('devolucion_iva')
  const cfg = BENEFICIARIOS[beneficiario] || BENEFICIARIOS.tercera_edad

  const [comps, setComps] = useState([])
  const [periodo, setPeriodo] = useState('')
  const [anio, setAnio] = useState(null)
  const [mesPeriodo, setMesPeriodo] = useState(null)   // mes resuelto del período en pantalla
  const [meses, setMeses] = useState([])          // meses que cubre el período (6 si es semestral)
  const [rubros, setRubros] = useState([])        // catálogo de tipos de gasto
  const [rubroDe, setRubroDe] = useState({})      // invoice_id → rubro elegido
  const [seleccion, setSeleccion] = useState(() => new Set())
  // El beneficiario lo fija la pantalla (hay una por cada trámite del SRI), no
  // es algo que se elija dentro: así no se puede guardar una solicitud de
  // discapacidad desde la pantalla de adultos mayores ni al revés.
  const tipo = beneficiario
  const [porcentaje, setPorcentaje] = useState('')
  const [params, setParams] = useState(null)
  const [solicitudes, setSolicitudes] = useState([])
  const [solicitudActual, setSolicitudActual] = useState(null)
  const [cargando, setCargando] = useState(false)
  const [panelSri, setPanelSri] = useState(null)  // 'gastos' | 'devolucion' — script a llevar al portal
  // Aviso de la subida en su propio renglón: `msg` lo borra cada recarga y el
  // resultado del TXT/XML tiene que quedar a la vista después de recargar.
  const [avisoSubida, setAvisoSubida] = useState(null) // { tipo: 'work'|'ok'|'err', texto }
  const [guardando, setGuardando] = useState(false)
  const [msg, setMsg] = useState(null) // { tipo: 'ok'|'err', texto }

  // Mes a validar: null = el período que tiene configurado el contribuyente.
  const [periodoSel, setPeriodoSel] = useState(null)     // { mes, anio }
  const [periodosDisp, setPeriodosDisp] = useState([])   // meses con gasto cargado
  const [lote, setLote] = useState(() => new Set())      // claves "anio-mes" marcadas
  const [procesandoLote, setProcesandoLote] = useState(false)
  const [resultadoLote, setResultadoLote] = useState(null)
  const [resumen, setResumen] = useState(null)           // totales de lo ya presentado
  const [envioDe, setEnvioDe] = useState(null)           // solicitud en pantalla de constancia
  const [reporteEnvio, setReporteEnvio] = useState(null) // reporte devuelto al registrar

  const clientId = selectedClient?.id
  const clave = (p) => `${p.anio}-${p.mes}`

  // Copia local de la grilla que trajo el portal, por período. Esos
  // comprobantes no están en Gastos: viven en la solicitud, así que si se
  // desmarca uno y se guarda, desaparecería del sistema y habría que volver al
  // SRI a buscarlo. Guardada acá, la fila sigue en pantalla para re-marcarla.
  const clavePortal = (mes, anio) => `devIvaPortal:${clientId}:${anio}-${mes}`
  const guardarPortal = (mes, anio, filas) => {
    try { localStorage.setItem(clavePortal(mes, anio), JSON.stringify(filas)) } catch { /* sin espacio */ }
  }
  const leerPortal = (mes, anio) => {
    try { return JSON.parse(localStorage.getItem(clavePortal(mes, anio))) || [] } catch { return [] }
  }

  const filaDePortal = (f) => ({
    id: `portal:${f.serie}`,
    unique_id: null,
    factura_numero: f.serie,
    fecha: f.fecha || '',
    ruc_proveedor: null,
    nombre_proveedor: f.proveedor || '',
    clasificacion: null,
    base: 0,
    iva: Number(f.iva) || 0,
    total: 0,
    origen: 'portal',
    rubro_sugerido: '',
    rubro: '',
  })

  const mezclarPortal = (lista, mes, anio) => {
    const guardadas = leerPortal(mes, anio)
    if (!guardadas.length) return lista
    const vistas = new Set(lista.map((c) => c.factura_numero).filter(Boolean))
    const extra = guardadas.filter((f) => f.serie && !vistas.has(f.serie)).map(filaDePortal)
    if (!extra.length) return lista
    return [...lista, ...extra].sort((a, b) => {
      const k = (c) => {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(c.fecha || ''))
        return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : String(c.fecha || '')
      }
      return k(b).localeCompare(k(a))
    })
  }

  const cargar = useCallback(async () => {
    if (!clientId) return
    setCargando(true)
    setMsg(null)
    try {
      const [rc, rs, rr] = await Promise.all([
        devolucionesIvaAPI.comprobantes(clientId, periodoSel?.mes, periodoSel?.anio),
        devolucionesIvaAPI.solicitudes(clientId),
        devolucionesIvaAPI.reporte(clientId).catch(() => null),
      ])
      setResumen(rr?.data?.totales || null)
      // A lo que responde el servidor se le suman los comprobantes del portal
      // que se hayan desmarcado: el servidor solo devuelve los que están en la
      // solicitud, y sin esto una fila desmarcada ya no se podría recuperar.
      const lista = mezclarPortal(rc.data.comprobantes || [], rc.data.mes, rc.data.anio)
      setComps(lista)
      setMesPeriodo(rc.data.mes)
      setPeriodo(rc.data.periodo || '')
      setAnio(rc.data.anio)
      setMeses(rc.data.meses || [])
      setRubros(rc.data.rubros || [])
      // Rubro por comprobante: el guardado en la solicitud, o el sugerido por la
      // clasificación del proveedor.
      setRubroDe(Object.fromEntries(lista.map((c) => [c.id, c.rubro || c.rubro_sugerido])))
      setSolicitudes(rs.data.data || [])
      const sol = rc.data.solicitud
      setSolicitudActual(sol || null)
      setSeleccion(new Set(rc.data.seleccionados || []))
      if (sol) {
        // El beneficiario lo fija la pantalla; de la solicitud solo se recupera
        // el porcentaje, que es el dato que el usuario cargó.
        setPorcentaje(sol.porcentaje_discapacidad ?? '')
      }
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron cargar los comprobantes.' })
    } finally {
      setCargando(false)
    }
  }, [clientId, periodoSel])

  useEffect(() => { cargar() }, [cargar])

  // Meses con gasto cargado: es lo que responde «¿qué mes valido?» y lo que se
  // puede marcar para preparar varios de una.
  const cargarPeriodos = useCallback(async () => {
    if (!clientId) return []
    try {
      const r = await devolucionesIvaAPI.periodos(clientId)
      const lista = r.data.periodos || []
      setPeriodosDisp(lista)
      return lista
    } catch {
      setPeriodosDisp([])
      return []
    }
  }, [clientId])

  useEffect(() => { cargarPeriodos() }, [cargarPeriodos])

  // --- Cargar las facturas sin salir de esta pantalla -----------------------
  // Sin comprobantes no hay nada que marcar ni que enviar, así que el TXT/XML se
  // sube acá mismo (va al mismo Gastos del contribuyente) y la pantalla se para
  // sola en el mes que acaba de entrar, lista para marcar.
  const trasCargar = async (d) => {
    const detalle = msgFueraPeriodo(d) + msgIdentAjena(d)
    if (detalle) alert(detalle.trim())
    const lista = await cargarPeriodos()
    const pend = lista.filter((p) => p.estado === 'pendiente')
    if (!comps.length && pend.length) {
      const ultimo = pend.reduce((a, b) => (b.anio * 12 + b.mes > a.anio * 12 + a.mes ? b : a))
      setPeriodoSel({ mes: ultimo.mes, anio: ultimo.anio })
    } else {
      cargar()
    }
  }

  const subirTxt = async (file) => {
    if (!clientId) return
    setMsg(null)
    setAvisoSubida({ tipo: 'work', texto: 'Bajando del SRI las facturas del TXT… puede tardar unos minutos.' })
    try {
      const r = await invoicesAPI.processTxt(clientId, file)
      const d = r.data
      const faltan = d.no_descargadas ?? 0
      setAvisoSubida({
        tipo: faltan > 0 ? 'err' : 'ok',
        texto: `Claves en el archivo: ${d.total_claves} · bajadas del SRI: ${d.descargadas ?? d.processed} · ` +
          `nuevas: ${d.new} · duplicadas: ${d.duplicates}` +
          (faltan > 0
            ? `. ⚠ ${faltan} no se pudieron bajar: volvé a subir el MISMO archivo y solo reintenta esas.`
            : '.'),
      })
      await trasCargar(d)
    } catch (e) {
      setAvisoSubida({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo procesar el TXT.' })
    }
  }

  // --- Traer al sistema lo que el portal del SRI lista --------------------
  // El trámite no es cargar facturas: el SRI muestra él mismo los comprobantes
  // que califican y lo que hay que hacer es marcarlos, clasificarlos y
  // enviarlos. El enviador copia esa grilla y acá entra tal cual, sin pasar por
  // Gastos. Se guarda además en el navegador para poder desmarcar y volver a
  // marcar sin tener que ir a buscarla de nuevo al portal.
  const pegarPortal = async () => {
    setMsg(null)
    let d = null
    try {
      d = JSON.parse(await navigator.clipboard.readText())
    } catch {
      setAvisoSubida({ tipo: 'err', texto: 'En el portapapeles no hay comprobantes del portal. En el SRI, tocá «Traer comprobantes al sistema» en el enviador.' })
      return
    }
    if (!d || !Array.isArray(d.filas) || !d.filas.length) {
      setAvisoSubida({ tipo: 'err', texto: 'Eso no es el listado del portal: falta el detalle de comprobantes.' })
      return
    }
    setAvisoSubida({ tipo: 'work', texto: `Ingresando ${d.filas.length} comprobante(s) del portal…` })
    try {
      const r = await devolucionesIvaAPI.portal({
        client_id: clientId,
        mes: d.mes,
        anio: d.anio,
        identificacion: d.identificacion || null,
        tipo_beneficiario: tipo,
        porcentaje_discapacidad: tipo === 'discapacidad' ? Number(porcentaje) || null : null,
        filas: d.filas,
      })
      guardarPortal(d.mes, d.anio, d.filas)
      const faltan = r.data.sin_rubro || 0
      setAvisoSubida({
        tipo: 'ok',
        texto: `${r.data.comprobantes} comprobante(s) del portal ingresados en ${r.data.periodo}. ` +
          (faltan > 0
            ? `Revisá el tipo de gasto: quedaron ${faltan} sin clasificar (el SRI no admite enviarlos vacíos).`
            : 'Todos quedaron con tipo de gasto propuesto: revisalo y guardá.'),
      })
      setPeriodoSel({ mes: d.mes, anio: d.anio })
      cargarPeriodos()
    } catch (e) {
      setAvisoSubida({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron ingresar los comprobantes del portal.' })
    }
  }

  const subirXml = async (files) => {
    if (!clientId) return
    setMsg(null)
    setAvisoSubida({ tipo: 'work', texto: `Procesando ${files.length} archivo(s) XML…` })
    try {
      const r = await invoicesAPI.processXml(clientId, files)
      const d = r.data
      setAvisoSubida({
        tipo: 'ok',
        texto: `Nuevas: ${d.new} · duplicadas: ${d.duplicates} · errores: ${d.errors}.`,
      })
      await trasCargar(d)
    } catch (e) {
      setAvisoSubida({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron procesar los XML.' })
    }
  }

  const pendientes = useMemo(
    () => periodosDisp.filter((p) => p.estado === 'pendiente'),
    [periodosDisp],
  )

  const toggleLote = (p) => {
    setLote((prev) => {
      const s = new Set(prev)
      const k = clave(p)
      if (s.has(k)) s.delete(k); else s.add(k)
      return s
    })
  }

  // Prepara en bloque los meses marcados: el sistema propone el tipo de gasto
  // según la clasificación del proveedor y deja para revisión los meses donde
  // algún comprobante quedó sin tipo (el SRI no admite enviarlo vacío).
  const procesarLote = async () => {
    const elegidos = periodosDisp.filter((p) => lote.has(clave(p)))
    if (!elegidos.length) return
    setProcesandoLote(true)
    setMsg(null)
    try {
      const r = await devolucionesIvaAPI.lote({
        client_id: clientId,
        tipo_beneficiario: tipo,
        porcentaje_discapacidad: tipo === 'discapacidad' ? Number(porcentaje) : null,
        periodos: elegidos.map((p) => ({ mes: p.mes, anio: p.anio })),
      })
      setResultadoLote(r.data)
      setLote(new Set())
      cargarPeriodos()
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo preparar el lote.' })
    } finally {
      setProcesandoLote(false)
    }
  }

  // Tope mensual según año del período y tipo de beneficiario
  useEffect(() => {
    if (!anio) return
    devolucionesIvaAPI.parametros(anio, tipo, tipo === 'discapacidad' ? porcentaje || null : null)
      .then((r) => setParams(r.data))
      .catch(() => setParams(null))
  }, [anio, tipo, porcentaje])

  const r2 = (n) => Math.round(n * 100) / 100

  // El tope de la devolución es MENSUAL, así que se aplica mes a mes: un período
  // semestral tiene seis topes y el excedente de un mes no usa el cupo de otro.
  const totales = useMemo(() => {
    const topeMes = params?.tope_mensual ?? 0
    const lista = meses.length ? meses : []
    const ancla = lista.length ? lista[lista.length - 1] : null
    const porMes = new Map(lista.map((m) => [m, { mes: m, comprobantes: 0, base: 0, iva: 0 }]))
    let sueltos = { base: 0, iva: 0 }
    for (const c of comps) {
      if (!seleccion.has(c.id)) continue
      const f = mesDeFecha(c.fecha)
      const destino = (porMes.has(f.mes) && (!anio || f.anio === anio)) ? f.mes : ancla
      if (destino == null) { sueltos.base += c.base; sueltos.iva += c.iva; continue }
      const d = porMes.get(destino)
      d.comprobantes += 1; d.base += c.base; d.iva += c.iva
    }
    const detalle = [...porMes.values()].map((d) => ({
      ...d, base: r2(d.base), iva: r2(d.iva), tope: topeMes,
      solicitar: r2(Math.min(d.iva, topeMes)), excedente: r2(Math.max(0, d.iva - topeMes)),
    }))
    const base = r2(detalle.reduce((s, d) => s + d.base, 0) + sueltos.base)
    const iva = r2(detalle.reduce((s, d) => s + d.iva, 0) + sueltos.iva)
    return {
      detalle, base, iva, topeMes,
      tope: r2(topeMes * (lista.length || 1)),
      solicitar: r2(detalle.reduce((s, d) => s + d.solicitar, 0)),
      excedente: r2(detalle.reduce((s, d) => s + d.excedente, 0)),
    }
  }, [comps, seleccion, params, meses, anio])

  // A qué tipo de gasto se direccionó lo marcado (resumen para revisar antes de enviar).
  const porRubro = useMemo(() => {
    const acc = new Map()
    for (const c of comps) {
      if (!seleccion.has(c.id)) continue
      const k = rubroDe[c.id] ?? c.rubro_sugerido ?? ''
      const a = acc.get(k) || { rubro: k, comprobantes: 0, iva: 0 }
      a.comprobantes += 1; a.iva += c.iva
      acc.set(k, a)
    }
    const orden = rubros.map((r) => r.key)
    return [...acc.values()]
      .map((a) => ({ ...a, iva: r2(a.iva), label: rubros.find((r) => r.key === a.rubro)?.label || 'Sin asignar' }))
      .sort((a, b) => orden.indexOf(a.rubro) - orden.indexOf(b.rubro))
  }, [comps, seleccion, rubroDe, rubros])

  const toggle = (id) => {
    setSeleccion((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id); else s.add(id)
      return s
    })
  }

  const toggleTodos = () => {
    setSeleccion((prev) => (prev.size === comps.length ? new Set() : new Set(comps.map((c) => c.id))))
  }

  const guardar = async () => {
    if (!seleccion.size) {
      setMsg({ tipo: 'err', texto: 'Marca al menos un comprobante.' })
      return
    }
    const ids = [...seleccion]
    // El tipo de gasto va al SRI fila por fila y su combo no admite vacío, así
    // que se corta acá antes de mandar nada al servidor.
    const sinRubro = ids.filter((id) => !(rubroDe[id] ?? comps.find((c) => c.id === id)?.rubro_sugerido))
    if (sinRubro.length) {
      setMsg({ tipo: 'err', texto: `Falta elegir el tipo de gasto en ${sinRubro.length} comprobante(s) marcado(s).` })
      return
    }
    setGuardando(true)
    setMsg(null)
    try {
      // Los del portal no están en Gastos: se mandan con su detalle, porque el
      // servidor no tiene de dónde sacarlos si no es de la solicitud anterior.
      const portalFilas = ids
        .filter((id) => String(id).startsWith('portal:'))
        .map((id) => comps.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({
          serie: c.factura_numero, fecha: c.fecha,
          proveedor: c.nombre_proveedor, iva: c.iva,
        }))
      const r = await devolucionesIvaAPI.guardar({
        client_id: clientId,
        tipo_beneficiario: tipo,
        porcentaje_discapacidad: tipo === 'discapacidad' ? Number(porcentaje) : null,
        invoice_ids: ids,
        rubros: Object.fromEntries(ids.map((id) => [id, rubroDe[id] ?? ''])),
        mes: periodoSel?.mes ?? null,
        anio: periodoSel?.anio ?? null,
        portal_filas: portalFilas.length ? portalFilas : null,
      })
      const extra = r.data.excedente > 0
        ? ` OJO: el IVA marcado supera el tope en ${fmtMoney(r.data.excedente)}; se solicita el tope.`
        : ''
      // Primero la recarga y DESPUÉS el aviso: cargar() limpia los mensajes al
      // arrancar, así que anunciar antes deja al usuario sin confirmación de
      // que guardó —que es justo lo que vino a hacer a esta pantalla—.
      await cargar()
      setMsg({ tipo: 'ok', texto: `Solicitud guardada: ${fmtMoney(r.data.monto_solicitado)} a solicitar.${extra}` })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo guardar la solicitud.' })
    } finally {
      setGuardando(false)
    }
  }

  const exportar = async (sol) => {
    try {
      const r = await devolucionesIvaAPI.exportExcel(sol.id)
      const sufijo = selectedClient.periodicidad === 'semestral'
        ? `${sol.anio}-S${sol.mes <= 6 ? 1 : 2}`
        : `${sol.anio}-${String(sol.mes).padStart(2, '0')}`
      downloadBlob(r.data, `DevolucionIVA_${selectedClient.identificacion}_${sufijo}.xlsx`)
    } catch {
      setMsg({ tipo: 'err', texto: 'No se pudo exportar el Excel.' })
    }
  }

  const cambiarEstado = async (sol, estado) => {
    try {
      await devolucionesIvaAPI.cambiarEstado(sol.id, estado)
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo cambiar el estado.' })
    }
  }

  // Enviar al SRI: el envío ocurre DENTRO del portal (sesión del contribuyente),
  // así que la app deja el paquete de la solicitud en el portapapeles para el
  // enviador que corre allá, abre el portal y registra el envío.
  const enviar = async (sol) => {
    setMsg(null)
    try {
      const r = await devolucionesIvaAPI.envio(sol.id)
      // La autorización se da ACÁ, con los números delante. Si el usuario acepta,
      // el paquete viaja marcado como `auto` y el marcador, al abrirse en el
      // portal, hace el recorrido entero sin volver a preguntar nada. Preguntar
      // dos veces lo mismo —una acá y otra allá— no agregaba control.
      const seguir = window.confirm(
        `📤 Presentar al SRI la devolución de ${r.data.periodo.etiqueta}\n` +
        `${r.data.contribuyente.nombre} (${r.data.contribuyente.identificacion})\n` +
        `${r.data.items.length} comprobante(s) · a solicitar ${fmtMoney(r.data.totales.solicitado)}\n\n` +
        'Al ACEPTAR se abre el portal del SRI y, en cuanto toques el marcador\n' +
        '"📤 Enviador-DEVOLUCIÓN", él solo marca los comprobantes, les pone el\n' +
        'tipo de gasto, procesa, guarda y PRESENTA la solicitud, sin preguntar\n' +
        'más. Presentar no se puede deshacer (art. 298 del COIP).\n\n' +
        'CANCELAR también copia la solicitud, pero el marcador se detendrá\n' +
        'antes de presentar para que revises el resumen del portal.'
      )
      const solicitud = { ...r.data, auto: seguir }
      // Para quien tenga instalada la extensión: se publica en la propia
      // ventana y ella la recoge, así el portal arranca sin tocar el marcador.
      // Sin extensión no pasa nada —nadie escucha— y sigue el camino del
      // portapapeles, que es el de siempre.
      window.postMessage({ tipo: 'jomap-devolucion-paquete', paquete: solicitud }, window.location.origin)
      const paquete = JSON.stringify(solicitud)
      let copiado = true
      try {
        await navigator.clipboard.writeText(paquete)
      } catch { copiado = false }
      if (!copiado) {
        alert('⚠ No se pudo copiar la solicitud al portapapeles. Abrí el marcador en el ' +
          'portal y usá "Pegar el paquete de una solicitud", o exportá el Excel como respaldo.')
      }
      window.open(SRI_DEVOLUCION_URL, '_blank', 'noopener')
      // La constancia se toma de la pantalla de confirmación del portal, que es
      // la que dice cuántos comprobantes procesó y por cuánto. Puede no coincidir
      // con lo marcado acá: el SRI trabaja con su propio listado filtrado.
      setEnvioDe({ sol, paquete: r.data })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo preparar el envío.' })
    }
  }

  // Ya se presentó en el portal, pero el sistema no se enteró: se abre la
  // ventana de constancia SIN publicar el paquete, sin copiarlo y sin abrir el
  // portal. Es la diferencia que importa: pasar por «Enviar al SRI» solo para
  // llegar a esta ventana volvería a soltar la solicitud en el portal y, con la
  // extensión instalada, presentaría el trámite POR SEGUNDA VEZ.
  const registrarConstancia = async (sol) => {
    setMsg(null)
    try {
      const r = await devolucionesIvaAPI.envio(sol.id)   // solo lectura
      setEnvioDe({ sol, paquete: r.data })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo abrir la constancia.' })
    }
  }

  // Registra lo que confirmó el SRI y guarda el reporte del envío.
  const registrarEnvio = async (sol, datos) => {
    try {
      const r = await devolucionesIvaAPI.marcarEnviada(sol.id, datos)
      setEnvioDe(null)
      setReporteEnvio(r.data.reporte)
      cargar()
      cargarPeriodos()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo registrar el envío.' })
    }
  }

  // La constancia vuelve sola desde el portal: el enviador la publica al
  // terminar y la extensión la trae hasta acá. Sin este camino de vuelta, el
  // recorrido automático dejaba la solicitud PRESENTADA en el SRI y en Borrador
  // en el sistema, porque marcarla dependía de que alguien regresara a esta
  // pestaña a pegar la constancia a mano —y con el envío automático ya nadie
  // regresa—. Sin extensión sigue estando el botón «Pegar constancia».
  useEffect(() => {
    const alLlegarConstancia = (ev) => {
      if (ev.source !== window) return              // nada de otras ventanas
      const d = ev.data
      if (!d || d.tipo !== 'jomap-devolucion-constancia' || !d.constancia) return
      const c = d.constancia
      const sol = solicitudes.find((s) => s.id === d.solicitud_id)
      if (!sol) return
      if (sol.estado === 'presentada' || sol.estado === 'aprobada') return
      // Sin el «Carga de archivo realizada exitosamente» del portal no se da
      // nada por presentado: el enviador llegó al final pero el SRI no confirmó,
      // y marcarlo igual sería registrar un envío que puede no existir.
      if (!c.mensaje) {
        setMsg({
          tipo: 'err',
          texto: 'El enviador terminó sin la confirmación del portal' +
            (c.meses > 1 ? ' en alguno de los meses' : '') +
            '. Revisá el SRI: la solicitud queda en Borrador hasta que se confirme.',
        })
        return
      }
      registrarEnvio(sol, {
        comprobantes: c.comprobantes ?? null,
        monto: c.monto ?? null,
        fecha_carga: c.fecha_carga || null,
        mensaje: c.mensaje || null,
      })
    }
    window.addEventListener('message', alLlegarConstancia)
    return () => window.removeEventListener('message', alLlegarConstancia)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solicitudes])

  const eliminar = async (sol) => {
    if (!window.confirm(`¿Eliminar la solicitud de ${String(sol.mes).padStart(2, '0')}/${sol.anio}?`)) return
    try {
      await devolucionesIvaAPI.eliminar(sol.id)
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo eliminar.' })
    }
  }

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon={cfg.icono} title={cfg.titulo} subtitle={cfg.subtitulo} idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Devolución IVA" />
  }

  return (
    <div className="dv-page">
      <WorkflowGuide steps={DV_STEPS} />
      <header className="dv-header">
        <div>
          <h1>{cfg.icono} {cfg.titulo}</h1>
          <p className="dv-sub"><strong>{selectedClient.identificacion}</strong> — {selectedClient.nombre} · Período {periodo || '—'}</p>
          <p className="dv-sub">{cfg.baseRbu}</p>
        </div>
      </header>

      <ClientSwitcher onNewClient={openNewClient} idents_svc={idents_svc} />

      {msg && <div className={`dv-msg ${msg.tipo}`}>{msg.texto}</div>}

      {periodosDisp.length > 0 && (
        <section className="dv-periodos">
          <div className="dv-periodos-head">
            <h2>📅 ¿Qué mes vas a validar?</h2>
            <p>
              La devolución se presenta <strong>mes a mes</strong> en el portal del SRI.
              Elegí uno para revisarlo comprobante por comprobante, o marcá varios meses
              anteriores y prepararlos de una.
            </p>
          </div>
          <div className="dv-periodos-lista">
            <button
              className={`dv-periodo ${!periodoSel ? 'activo' : ''}`}
              onClick={() => setPeriodoSel(null)}
              title="Volver al período configurado del contribuyente"
            >Período del cliente</button>
            {periodosDisp.map((p) => (
              <div key={clave(p)} className={`dv-periodo-card estado-${p.estado}`}>
                <label className="dv-periodo-check" title="Marcar para preparar en lote">
                  <input
                    type="checkbox"
                    disabled={p.estado !== 'pendiente'}
                    checked={lote.has(clave(p))}
                    onChange={() => toggleLote(p)}
                  />
                </label>
                <button
                  className={`dv-periodo ${periodoSel && periodoSel.mes === p.mes && periodoSel.anio === p.anio ? 'activo' : ''}`}
                  onClick={() => setPeriodoSel({ mes: p.mes, anio: p.anio })}
                >
                  <strong>{p.etiqueta}</strong>
                  <span>{p.comprobantes} comprob. · IVA {fmtMoney(p.iva)}</span>
                  <em className={`dv-estado ${p.estado}`}>
                    {p.estado === 'pendiente' ? 'sin preparar' : ESTADO_LABEL[p.estado] || p.estado}
                    {p.comprobantes_enviados != null && ` · ${p.comprobantes_enviados} enviados`}
                  </em>
                </button>
              </div>
            ))}
          </div>
          {lote.size > 0 && (
            <div className="dv-lote-barra">
              <span>{lote.size} mes(es) marcado(s) para preparar automáticamente</span>
              <button className="dv-btn primary" onClick={procesarLote} disabled={procesandoLote}>
                {procesandoLote ? 'Preparando…' : '⚙️ Preparar los meses marcados'}
              </button>
              <button className="dv-btn" onClick={() => setLote(new Set())}>Desmarcar</button>
            </div>
          )}
          {pendientes.length > 0 && lote.size === 0 && (
            <button
              className="dv-btn"
              onClick={() => setLote(new Set(pendientes.map(clave)))}
            >Marcar los {pendientes.length} meses sin preparar</button>
          )}
        </section>
      )}

      {cfg.avisos.length > 0 && (
        <div className="dv-avisos">
          {cfg.avisos.map((a, i) => <p key={i}>⚠️ {a}</p>)}
        </div>
      )}

      <div className="dv-toolbar">
        {tipo === 'discapacidad' && (
          <label>
            % discapacidad:{' '}
            <input type="number" min="30" max="100" value={porcentaje}
              onChange={(e) => setPorcentaje(e.target.value)} style={{ width: 70 }} />
          </label>
        )}
        <button
          className="dv-btn primary"
          onClick={pegarPortal}
          title="Ingresar el listado que el portal del SRI muestra del período (copialo con el enviador, en el SRI)"
        >📥 Pegar comprobantes del portal</button>
        <a
          ref={setEnviadorDevolucionHref}
          className="dv-enviador"
          draggable="true"
          onClick={(e) => { e.preventDefault(); setPanelSri('devolucion') }}
          title="Script que carga la solicitud dentro del portal del SRI: tocalo para copiarlo o instalarlo."
        >📤 Enviador-DEVOLUCIÓN (SRI)</a>
        {params && (
          <span className="dv-tope">
            Tope mensual {anio}: <strong>{fmtMoney(params.tope_mensual)}</strong>
            {' '}(IVA {Math.round(params.iva_tarifa * 100)}% de hasta {params.base_max_rbu} RBU de {fmtMoney(params.rbu)})
            {meses.length > 1 && (
              <> · período de {meses.length} meses → tope total <strong>{fmtMoney(totales.tope)}</strong></>
            )}
          </span>
        )}
      </div>

      <div className="dv-resumen">
        <div className="dv-res-card"><span>Comprobantes marcados</span><strong>{seleccion.size} / {comps.length}</strong></div>
        <div className="dv-res-card"><span>Base gravada</span><strong>{fmtMoney(totales.base)}</strong></div>
        <div className="dv-res-card"><span>IVA marcado</span><strong>{fmtMoney(totales.iva)}</strong></div>
        <div className={`dv-res-card destacado ${totales.excedente > 0 ? 'alerta' : ''}`}>
          <span>IVA a solicitar</span><strong>{fmtMoney(totales.solicitar)}</strong>
          {totales.excedente > 0 && <em>supera el tope en {fmtMoney(totales.excedente)}</em>}
        </div>
        <button className="dv-btn primary" onClick={guardar} disabled={guardando || !seleccion.size}>
          {guardando ? 'Guardando…' : (solicitudActual ? '💾 Actualizar solicitud' : '💾 Guardar solicitud')}
        </button>
      </div>

      {seleccion.size > 0 && porRubro.length > 0 && (
        <div className="dv-rubros-resumen">
          <span className="dv-rubros-lbl">Direccionado a:</span>
          {porRubro.map((r) => (
            <span key={r.rubro} className="dv-rubro-chip" title={`${r.comprobantes} comprobante(s)`}>
              {r.label} · <strong>{fmtMoney(r.iva)}</strong>
            </span>
          ))}
        </div>
      )}

      {meses.length > 1 && seleccion.size > 0 && (
        <div className="dv-tabla-wrap dv-meses">
          <table className="dv-tabla">
            <thead>
              <tr>
                <th>Mes</th><th className="num">Comprobantes</th><th className="num">Base</th>
                <th className="num">IVA</th><th className="num">Tope del mes</th>
                <th className="num">A solicitar</th><th className="num">Excedente</th>
              </tr>
            </thead>
            <tbody>
              {totales.detalle.map((d) => (
                <tr key={d.mes} className={d.excedente > 0 ? 'alerta' : (d.comprobantes === 0 ? 'dv-mes-vacio' : '')}>
                  <td>{nombreMes(d.mes)}</td>
                  <td className="num">{d.comprobantes}</td>
                  <td className="num">{fmtMoney(d.base)}</td>
                  <td className="num">{fmtMoney(d.iva)}</td>
                  <td className="num">{fmtMoney(d.tope)}</td>
                  <td className="num"><strong>{fmtMoney(d.solicitar)}</strong></td>
                  <td className="num">{d.excedente > 0 ? fmtMoney(d.excedente) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dv-nota-meses">
            El tope es <strong>mensual</strong>: se aplica mes a mes y lo que sobra en un mes no
            usa el cupo de otro. Los comprobantes sin fecha legible se imputan al último mes del período.
          </p>
        </div>
      )}

      {avisoSubida && (
        <div className={`dv-msg ${avisoSubida.tipo === 'work' ? '' : avisoSubida.tipo}`}>
          {avisoSubida.tipo === 'work' ? '⏳ ' : ''}{avisoSubida.texto}
        </div>
      )}

      {cargando ? (
        <p className="dv-cargando">Cargando comprobantes…</p>
      ) : comps.length === 0 ? (
        <SinComprobantes
          cliente={selectedClient}
          periodo={periodoSel ? `${nombreMes(periodoSel.mes)} ${periodoSel.anio}` : (periodo || 'el período')}
          anio={anio}
          conGasto={periodosDisp}
          onElegirPeriodo={(p) => setPeriodoSel({ mes: p.mes, anio: p.anio })}
          onPegarPortal={pegarPortal}
          onTxt={subirTxt}
          onXml={subirXml}
        />
      ) : (
        <div className="dv-tabla-wrap">
          <table className="dv-tabla">
            <thead>
              <tr>
                <th><input type="checkbox" checked={seleccion.size === comps.length && comps.length > 0} onChange={toggleTodos} title="Marcar/desmarcar todos" /></th>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Tipo de gasto</th>
                <th>Clasificación</th>
                <th className="num">Base gravada</th>
                <th className="num">IVA</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c) => (
                <tr key={c.id} className={seleccion.has(c.id) ? 'sel' : ''} onClick={() => toggle(c.id)}>
                  <td><input type="checkbox" checked={seleccion.has(c.id)} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>{c.fecha}</td>
                  <td title={c.ruc_proveedor}>{c.nombre_proveedor}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className={`dv-rubro ${!(rubroDe[c.id] || c.rubro_sugerido) ? 'sin-asignar' : ''}`}
                      value={rubroDe[c.id] ?? c.rubro_sugerido ?? ''}
                      onChange={(e) => setRubroDe((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      title="Tipo de gasto al que se direcciona este comprobante (es el mismo combo del portal del SRI)"
                    >
                      <option value="">— Elegí el tipo de gasto —</option>
                      {rubros.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </td>
                  <td>
                    {c.origen === 'portal'
                      ? <span className="dv-chip-portal" title="Lo lista el portal del SRI; no está en Gastos">SRI</span>
                      : (c.clasificacion || 'SIN CLASIFICAR')}
                  </td>
                  <td className="num">{c.origen === 'portal' ? '—' : fmtMoney(c.base)}</td>
                  <td className="num">{fmtMoney(c.iva)}</td>
                  <td className="num">{c.origen === 'portal' ? '—' : fmtMoney(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {solicitudes.length > 0 && (
        <section className="dv-historial">
          <h2>📚 Solicitudes guardadas</h2>
          {resumen && (
            <div className="dv-reporte-cifras">
              <div>
                <span>Presentadas al SRI</span>
                <strong>{resumen.presentadas} de {resumen.solicitudes}</strong>
              </div>
              <div>
                <span>Comprobantes procesados</span>
                <strong>{resumen.comprobantes}</strong>
              </div>
              <div>
                <span>Valor procesado</span>
                <strong>{fmtMoney(resumen.monto)}</strong>
              </div>
              {resumen.pendiente > 0 && (
                <div>
                  <span>En borrador, sin presentar</span>
                  <strong>{fmtMoney(resumen.pendiente)}</strong>
                </div>
              )}
            </div>
          )}
          <table className="dv-tabla">
            <thead>
              <tr>
                <th>Período</th><th>Beneficiario</th><th className="num">IVA marcado</th>
                <th className="num">Tope</th><th className="num">Solicitado</th>
                <th className="num">Procesado en el SRI</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {solicitudes.map((s) => (
                <tr key={s.id}>
                  <td>{selectedClient.periodicidad === 'semestral'
                    ? `${s.mes <= 6 ? '1er' : '2do'} semestre ${s.anio}`
                    : `${nombreMes(s.mes)} ${s.anio}`}</td>
                  <td>{s.tipo_beneficiario === 'discapacidad' ? `Discapacidad ${s.porcentaje_discapacidad || ''}%` : 'Adulto mayor'}</td>
                  <td className="num">{fmtMoney(s.total_iva)}</td>
                  <td className="num">{fmtMoney(s.tope_mensual)}</td>
                  <td className="num"><strong>{fmtMoney(s.monto_solicitado)}</strong></td>
                  <td className="num" title={s.fecha_carga_sri ? `Carga en el SRI: ${s.fecha_carga_sri}` : ''}>
                    {s.comprobantes_enviados != null
                      ? <>{s.comprobantes_enviados} comprob. · <strong>{fmtMoney(s.monto_enviado ?? s.monto_solicitado)}</strong></>
                      : '—'}
                  </td>
                  <td>
                    <select value={s.estado} onChange={(e) => cambiarEstado(s, e.target.value)}>
                      {Object.entries(ESTADO_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </td>
                  <td className="dv-acciones">
                    <button className="dv-btn primary" onClick={() => enviar(s)}
                      title="Preparar el envío al portal del SRI y registrarlo">📤 Enviar al SRI</button>
                    {s.estado === 'borrador' && (
                      <button className="dv-btn" onClick={() => registrarConstancia(s)}
                        title="Ya la presentaste en el portal: cargá acá la constancia sin volver a enviar">
                        📋 Ya presentada
                      </button>
                    )}
                    <button className="dv-btn" onClick={() => exportar(s)} title="Exportar Excel">📥 Excel</button>
                    <button className="dv-btn" onClick={() => eliminar(s)} title="Eliminar">🗑️</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {panelSri && <BajadorSRI which={panelSri} onClose={() => setPanelSri(null)} />}

      {envioDe && (
        <ConstanciaEnvio
          paquete={envioDe.paquete}
          onCancel={() => setEnvioDe(null)}
          onConfirm={(datos) => registrarEnvio(envioDe.sol, datos)}
        />
      )}

      {reporteEnvio && (
        <ReporteEnvio reporte={reporteEnvio} onClose={() => setReporteEnvio(null)} />
      )}

      {resultadoLote && (
        <ResultadoLote resultado={resultadoLote} onClose={() => setResultadoLote(null)} />
      )}
    </div>
  )
}

// --- Sin comprobantes -------------------------------------------------------
// El trámite se hace acá: si el mes está vacío, la pantalla tiene que resolver
// la carga en el momento (bajar del SRI o soltar el TXT/XML) y quedar lista para
// marcar y enviar, en vez de mandar al usuario a otra pantalla o a una consola.
function SinComprobantes({ cliente, periodo, anio, conGasto, onElegirPeriodo, onPegarPortal, onTxt, onXml }) {
  return (
    <div className="dv-vacio">
      <h2>No hay comprobantes en {periodo}</h2>
      <p className="dv-vacio-intro">
        La devolución se arma con <strong>el listado que muestra el propio SRI</strong>: solo
        bienes y servicios de primera necesidad de establecimientos verificados. Traelo del
        portal y acá lo marcás, lo clasificás y lo enviás.
      </p>

      <div className="dv-vacio-portal">
        <ol>
          <li>En el SRI, entrá a <em>Devolución de IVA → Ingresar facturas electrónicas</em>.</li>
          <li>Tocá el marcador <strong>📤 Enviador-DEVOLUCIÓN</strong> y después
            <strong> «Traer comprobantes al sistema»</strong>: elige el mes y copia la grilla.</li>
          <li>Volvé acá y pegala:</li>
        </ol>
        <button className="dv-btn primary" onClick={onPegarPortal}>
          📥 Pegar comprobantes del portal
        </button>
      </div>

      {conGasto.length > 0 && (
        <div className="dv-vacio-otros">
          <span>Ya hay gasto cargado en otros meses:</span>
          <div className="dv-vacio-meses">
            {conGasto.map((p) => (
              <button key={`${p.anio}-${p.mes}`} className="dv-btn" onClick={() => onElegirPeriodo(p)}>
                {p.etiqueta} · {p.comprobantes} comprob. · IVA {fmtMoney(p.iva)}
              </button>
            ))}
          </div>
        </div>
      )}

      <details className="dv-vacio-carga">
        <summary>Otra vía: cargar las facturas del mes (TXT del SRI o XML)</summary>
        <UploadPanel onProcessTxt={onTxt} onProcessXml={onXml} />
        <p className="dv-vacio-nota">
          Van a los gastos de {cliente.identificacion}, igual que en Gastos. Sirve para
          contabilidad, pero para la devolución manda el listado del portal: el SRI solo
          devuelve lo que él reconoce, y ahí puede haber comprobantes que no cargaste
          —y faltar otros que sí tenés.
        </p>
      </details>

      <details className="dv-vacio-avanzado">
        <summary>Otra vía: descargador local (equipo con Python instalado)</summary>
        <code>python descargar.py comprobantes --ruc {cliente.identificacion} --anio {anio || 'AAAA'} --mes MM --upload</code>
      </details>
    </div>
  )
}

// --- Constancia del envío ---------------------------------------------------
// Lo que el portal del SRI muestra al presentar ("Carga de archivo realizada
// exitosamente", con el detalle y el Total solicitado). Se carga acá para que
// quede guardado: es la única prueba de qué aceptó el SRI, y no tiene por qué
// coincidir con lo que se marcó en el sistema.
function ConstanciaEnvio({ paquete, onCancel, onConfirm }) {
  const [comprobantes, setComprobantes] = useState(String(paquete.items.length))
  const [monto, setMonto] = useState(String(paquete.totales.solicitado))
  const [fecha, setFecha] = useState('')
  const [mensaje, setMensaje] = useState('Carga de archivo realizada exitosamente')
  const [pegado, setPegado] = useState('')

  const distinto = Number(comprobantes) !== paquete.items.length ||
    Math.abs(Number(monto) - paquete.totales.solicitado) > 0.005

  // El enviador deja la constancia copiada al terminar en el portal: se pega
  // acá en vez de volver a tipear lo que el SRI ya contestó.
  const pegarConstancia = async () => {
    try {
      const d = JSON.parse(await navigator.clipboard.readText())
      if (d.comprobantes == null && d.monto == null) throw new Error('otra cosa')
      if (d.comprobantes != null) setComprobantes(String(d.comprobantes))
      if (d.monto != null) setMonto(String(d.monto))
      if (d.fecha_carga) setFecha(d.fecha_carga)
      if (d.mensaje) setMensaje(d.mensaje)
      setPegado('ok')
    } catch {
      setPegado('err')
    }
  }

  return (
    <div className="dv-modal-fondo" onClick={onCancel}>
      <div className="dv-modal" onClick={(e) => e.stopPropagation()}>
        <h2>📋 Constancia del envío al SRI</h2>
        <p className="dv-modal-sub">
          {paquete.contribuyente.nombre} · {paquete.periodo.etiqueta}
        </p>
        <p className="dv-modal-ayuda">
          Lo que muestra la pantalla de confirmación del portal. En el sistema se
          marcaron <strong>{paquete.items.length}</strong> comprobante(s) por{' '}
          <strong>{fmtMoney(paquete.totales.solicitado)}</strong>.
        </p>
        <div className="dv-modal-pegar">
          <button className="dv-btn" onClick={pegarConstancia}>
            📋 Pegar constancia del enviador
          </button>
          {pegado === 'ok' && <em className="ok">Constancia cargada.</em>}
          {pegado === 'err' && (
            <em className="err">
              En el portapapeles no hay una constancia: copiala en el enviador con
              «Copiar constancia para la app».
            </em>
          )}
        </div>
        <label>
          Comprobantes que procesó el SRI
          <input type="number" min="0" value={comprobantes}
            onChange={(e) => setComprobantes(e.target.value)} />
        </label>
        <label>
          Total solicitado (USD)
          <input type="number" step="0.01" min="0" value={monto}
            onChange={(e) => setMonto(e.target.value)} />
        </label>
        <label>
          Fecha y hora de carga
          <input type="text" placeholder="06-08-2026 13:52:14" value={fecha}
            onChange={(e) => setFecha(e.target.value)} />
        </label>
        <label>
          Mensaje del portal
          <input type="text" value={mensaje} onChange={(e) => setMensaje(e.target.value)} />
        </label>
        {distinto && (
          <p className="dv-modal-alerta">
            Lo que informás no coincide con lo marcado en el sistema. Se guardan los dos
            valores para que la diferencia quede a la vista en el reporte.
          </p>
        )}
        <div className="dv-modal-botones">
          <button className="dv-btn primary" onClick={() => onConfirm({
            comprobantes: Number(comprobantes),
            monto: Number(monto),
            fecha_carga: fecha || null,
            mensaje: mensaje || null,
          })}>Guardar como PRESENTADA</button>
          <button className="dv-btn" onClick={onCancel}>Todavía no</button>
        </div>
      </div>
    </div>
  )
}

// --- Reporte del envío ------------------------------------------------------
function ReporteEnvio({ reporte, onClose }) {
  return (
    <div className="dv-modal-fondo" onClick={onClose}>
      <div className="dv-modal" onClick={(e) => e.stopPropagation()}>
        <h2>✅ Solicitud presentada — {reporte.periodo.etiqueta}</h2>
        <div className="dv-reporte-cifras">
          <div><span>Comprobantes procesados</span><strong>{reporte.comprobantes_procesados}</strong></div>
          <div><span>Valor procesado</span><strong>{fmtMoney(reporte.monto_procesado)}</strong></div>
        </div>
        {reporte.diferencia !== 0 && (
          <p className="dv-modal-alerta">
            En el sistema se habían marcado {reporte.comprobantes_marcados} comprobante(s)
            por {fmtMoney(reporte.monto_solicitado)}: hay una diferencia de{' '}
            {fmtMoney(Math.abs(reporte.diferencia))}. Suele ser porque el SRI no lista
            comprobantes que no califican (bienes que no son de primera necesidad o
            establecimientos no verificados).
          </p>
        )}
        {reporte.por_rubro?.length > 0 && (
          <table className="dv-tabla">
            <thead><tr><th>Tipo de gasto</th><th className="num">Comprobantes</th><th className="num">IVA</th></tr></thead>
            <tbody>
              {reporte.por_rubro.map((r) => (
                <tr key={r.rubro || 'sin'}>
                  <td>{r.label}</td>
                  <td className="num">{r.comprobantes}</td>
                  <td className="num">{fmtMoney(r.iva)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {reporte.fecha_carga && <p className="dv-modal-ayuda">Carga en el SRI: {reporte.fecha_carga}</p>}
        {reporte.mensaje && <p className="dv-modal-ayuda">«{reporte.mensaje}»</p>}
        <div className="dv-modal-botones">
          <button className="dv-btn primary" onClick={onClose}>Listo</button>
        </div>
      </div>
    </div>
  )
}

// --- Resultado del lote -----------------------------------------------------
function ResultadoLote({ resultado, onClose }) {
  return (
    <div className="dv-modal-fondo" onClick={onClose}>
      <div className="dv-modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ Meses preparados</h2>
        <div className="dv-reporte-cifras">
          <div><span>Meses listos</span><strong>{resultado.preparadas.length}</strong></div>
          <div><span>Comprobantes</span><strong>{resultado.total_comprobantes}</strong></div>
          <div><span>A solicitar</span><strong>{fmtMoney(resultado.total_solicitado)}</strong></div>
        </div>
        {resultado.preparadas.length > 0 && (
          <ul className="dv-lote-lista">
            {resultado.preparadas.map((p) => (
              <li key={p.etiqueta}>
                <strong>{p.etiqueta}</strong> — {p.comprobantes} comprob. ·{' '}
                {fmtMoney(p.monto_solicitado)}
              </li>
            ))}
          </ul>
        )}
        {resultado.revisar.length > 0 && (
          <>
            <p className="dv-modal-alerta">
              Estos meses quedaron sin preparar y hay que revisarlos a mano
              (el tipo de gasto se declara al SRI, así que no se adivina):
            </p>
            <ul className="dv-lote-lista">
              {resultado.revisar.map((p) => (
                <li key={p.etiqueta}><strong>{p.etiqueta}</strong> — {p.motivo}</li>
              ))}
            </ul>
          </>
        )}
        <p className="dv-modal-ayuda">
          Quedaron en <strong>borrador</strong>: cada uno se presenta por separado en el
          portal del SRI, mes por mes.
        </p>
        <div className="dv-modal-botones">
          <button className="dv-btn primary" onClick={onClose}>Listo</button>
        </div>
      </div>
    </div>
  )
}
