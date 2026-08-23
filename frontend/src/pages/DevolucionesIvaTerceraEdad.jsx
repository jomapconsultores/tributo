import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useClients } from '../context/ClientContext'
import { devolucionesIvaAPI, invoicesAPI, downloadBlob } from '../services/api'
import { fmtMoney, msgFueraPeriodo, msgIdentAjena } from '../utils/format'
import { nombreMes } from '../utils/periodo'
import ClientSwitcher from '../components/ClientSwitcher'
import ClientPickerScreen from '../components/ClientPickerScreen'
import UploadPanel from '../components/UploadPanel'
import WorkflowGuide from '../components/WorkflowGuide'
import { setEnviadorDevolucionHref, urlDevolucion } from '../utils/enviadorDevolucion'
import BajadorSRI from '../components/BajadorSRI'
import './DevolucionesIva.css'

const DV_STEPS = [
  { icon: '📥', label: 'Gastos (subir TXT/XML)', path: '/' },
  { icon: '📄', label: 'Declaraciones IVA', path: '/declaracion-iva' },
  { icon: '👵', label: 'Devolución IVA', current: true },
  { icon: '📑', label: 'Reportes y cobros', path: '/reportes' },
]

// El portal del SRI puede entregar su listado directamente a esta pantalla:
// abre la app y se lo pasa por `postMessage`. Solo se acepta de ahí.
const ES_PORTAL_SRI = /^https:\/\/([a-z0-9-]+\.)*sri\.gob\.ec$/i

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
  const idents_con_servicio = identsForSvc('devolucion_iva')
  const cfg = BENEFICIARIOS[beneficiario] || BENEFICIARIOS.tercera_edad

  // Esta pantalla lista SOLO a los suyos: adultos mayores y discapacidad son
  // trámites distintos, y mezclarlos obliga a buscar entre contribuyentes que
  // no van. El backend devuelve los marcados con este tipo más los que todavía
  // no tienen solicitud —de esos no hay forma de saberlo, y esconderlos de las
  // dos pantallas los dejaría inalcanzables—.
  const [identsDelTipo, setIdentsDelTipo] = useState(null)
  useEffect(() => {
    let vigente = true
    devolucionesIvaAPI.contribuyentes(beneficiario)
      .then((r) => { if (vigente) setIdentsDelTipo(r.data?.identificaciones ?? null) })
      .catch(() => { if (vigente) setIdentsDelTipo(null) })
    return () => { vigente = false }
  }, [beneficiario])

  const idents_svc = useMemo(() => {
    if (!idents_con_servicio || !identsDelTipo) return idents_con_servicio
    const permitidas = new Set(identsDelTipo)
    return new Set([...idents_con_servicio].filter((i) => permitidas.has(i)))
  }, [idents_con_servicio, identsDelTipo])

  if (!selectedClient || idents_svc === null || !idents_svc.has(selectedClient?.identificacion)) {
    return <ClientPickerScreen icon={cfg.icono} title={cfg.titulo} subtitle={cfg.subtitulo} idents_svc={idents_svc} onNewClient={openNewClient} svcLabel="Devolución IVA" />
  }

  // Una pantalla por contribuyente (y por período suyo): la `key` la vuelve a
  // montar al cambiar de cliente, así NADA del anterior sobrevive al cambio.
  //
  // Antes todo vivía en el estado de un componente que nunca se desmontaba:
  // los comprobantes, lo marcado, la solicitud, el mes elegido, el % de
  // discapacidad y los avisos seguían en pantalla al abrir a otra persona.
  // En el mejor caso se veían los datos del anterior hasta que respondiera el
  // servidor; si la carga fallaba se quedaban ahí, y el mes elegido para uno
  // se le aplicaba al siguiente —incluido lo que se guardaba—.
  return (
    <PantallaDevolucion
      key={selectedClient.id}
      beneficiario={beneficiario}
      cfg={cfg}
      idents_svc={idents_svc}
      openNewClient={openNewClient}
      selectedClient={selectedClient}
    />
  )
}

function PantallaDevolucion({ beneficiario, cfg, idents_svc, openNewClient, selectedClient }) {
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
  const portalEnCursoRef = useRef(null) // listado del portal que ya se está ingresando (no entra dos veces)
  const [ocultos, setOcultos] = useState([])  // comprobantes que el usuario sacó de esta devolución
  const [noListado, setNoListado] = useState(0)  // gasto del mes que el SRI no reconoce
  const [soloSinRubro, setSoloSinRubro] = useState(false)  // ver solo lo que falta clasificar
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

  // La grilla que trajo el portal y los comprobantes que se sacaron de esta
  // devolución los guarda el SERVIDOR, junto al resto del trámite. Vivían en el
  // localStorage de cada navegador: el mes traído en la oficina no aparecía en
  // la laptop, limpiar el navegador borraba el listado del SRI —que no está en
  // Gastos y solo existe ahí— y nada de eso quedaba respaldado.

  // El período se cambia con un clic y el servidor tarda lo que tarda: sin
  // llevar cuenta del pedido, la respuesta de un mes que se dejó atrás llegaba
  // después y pisaba la del mes que el usuario acaba de abrir.
  const pedidoRef = useRef(0)

  const cargar = useCallback(async () => {
    if (!clientId) return
    const pedido = ++pedidoRef.current
    setCargando(true)
    setMsg(null)
    try {
      const [rc, rs, rr] = await Promise.all([
        devolucionesIvaAPI.comprobantes(clientId, periodoSel?.mes, periodoSel?.anio),
        devolucionesIvaAPI.solicitudes(clientId),
        devolucionesIvaAPI.reporte(clientId).catch(() => null),
      ])
      if (pedidoRef.current !== pedido) return   // llegó tarde: manda el pedido nuevo
      setResumen(rr?.data?.totales || null)
      // El servidor devuelve la lista ya armada: cuando el portal entregó su
      // grilla del período, son ESOS comprobantes —la devolución se arma con lo
      // que el SRI lista, no con todo el gasto del mes—, menos lo que se sacó de
      // esta devolución (viene aparte, para poder volver a mostrarlo).
      const lista = rc.data.comprobantes || []
      setOcultos(rc.data.ocultos || [])
      setNoListado(rc.data.gasto_no_listado || 0)
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
      if (pedidoRef.current !== pedido) return
      // Se vacía la pantalla: dejar a la vista los comprobantes del período
      // anterior al lado de un error es mostrar datos que no son los pedidos.
      setComps([])
      setOcultos([])
      setSeleccion(new Set())
      setSolicitudActual(null)
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron cargar los comprobantes.' })
    } finally {
      if (pedidoRef.current === pedido) setCargando(false)
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
  // Ingresa un listado del portal (venga del portapapeles o solo, por la
  // extensión). Devuelve `soltar`: si la extensión ya puede olvidarse de ese
  // listado —porque entró, o porque insistir no va a cambiar nada—.
  const ingresarPortal = async (d, { automatico = false } = {}) => {
    if (!d || !Array.isArray(d.filas) || !d.filas.length) {
      setAvisoSubida({ tipo: 'err', texto: 'Eso no es el listado del portal: falta el detalle de comprobantes.' })
      return { ok: false, soltar: true }
    }
    // El listado es DE alguien: entrarlo en el contribuyente que esté abierto
    // sería armarle la devolución a otra persona. Si no coincide se avisa y se
    // deja esperando —al abrir a quien corresponde, entra solo—.
    const suyo = String(d.identificacion || '').replace(/\D/g, '')
    const abierto = String(selectedClient?.identificacion || '').replace(/\D/g, '')
    if (suyo && abierto && suyo !== abierto) {
      setAvisoSubida({
        tipo: 'err',
        texto: `Esos comprobantes del portal son de ${d.identificacion}, y acá está abierto ` +
          `${selectedClient?.identificacion}. Abrí ese contribuyente y entran solos.`,
      })
      return { ok: false, soltar: false }   // que sigan esperando a su contribuyente
    }
    setAvisoSubida({
      tipo: 'work',
      texto: `Ingresando ${d.filas.length} comprobante(s) del portal${automatico ? ' que llegaron del SRI' : ''}…`,
    })
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
      // La grilla queda guardada en el servidor, REEMPLAZANDO la del mes: traer
      // el listado de nuevo no acumula dos, y el mes arranca sin nada excluido
      // —lo sacado del listado anterior taparía lo que acaba de entrar—.
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
      return { ok: true, soltar: true }
    } catch (e) {
      setAvisoSubida({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron ingresar los comprobantes del portal.' })
      // 409 es "ese mes ya está presentado": reintentarlo en cada vuelta a la
      // pestaña solo repetiría el aviso, así que se da por atendido.
      return { ok: false, soltar: e.response?.status === 409 }
    }
  }

  // --- Sacar comprobantes de esta devolución ------------------------------
  // El listado del SRI es el que manda: lo que el contribuyente tenga cargado
  // en Gastos ese mes (bancos, servicios, lo que no califica) solo estorba
  // cuando hay que armar la solicitud. Se quita de la devolución, NO de Gastos.
  const quitarComprobante = async (c) => {
    // Se saca de la pantalla en el acto y se guarda después: la fila se va con
    // el clic, no cuando conteste el servidor.
    const fuera = [...ocultos.map((o) => o.id), c.id]
    setComps((cs) => cs.filter((x) => x.id !== c.id))
    setOcultos((os) => [...os, c])
    setSeleccion((sel) => {
      if (!sel.has(c.id)) return sel
      const s = new Set(sel); s.delete(c.id); return s
    })
    try {
      await devolucionesIvaAPI.excluidos({ client_id: clientId, mes: mesPeriodo, anio, ids: fuera })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo sacar el comprobante de la devolución.' })
      cargar()
    }
  }

  const mostrarOcultos = async () => {
    try {
      await devolucionesIvaAPI.excluidos({ client_id: clientId, mes: mesPeriodo, anio, ids: [] })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudieron volver a mostrar.' })
    }
    cargar()
  }

  // Vaciar el mes para empezar de nuevo: borra la solicitud, olvida la grilla
  // que se trajo del portal y saca de la devolución lo que quedaba en pantalla.
  // Es lo que hace falta para volver a traer el listado del SRI desde cero.
  const limpiarPeriodo = async () => {
    const etiqueta = periodoSel ? `${nombreMes(periodoSel.mes)} ${periodoSel.anio}` : (periodo || 'el período')
    const presentada = solicitudActual && ['presentada', 'aprobada'].includes(solicitudActual.estado)
    const aviso = presentada
      ? `La solicitud de ${etiqueta} figura como ${solicitudActual.estado.toUpperCase()}: al limpiar se borra ` +
        'también el registro del envío (fecha de carga, monto y comprobantes). ¿Seguir?'
      : `¿Vaciar la devolución de ${etiqueta}? Se borra la solicitud en borrador y el listado que se ` +
        'trajo del portal. Las facturas siguen en Gastos: esto no las elimina.'
    if (!window.confirm(aviso)) return
    setMsg(null)
    try {
      await devolucionesIvaAPI.limpiarPeriodo({ client_id: clientId, mes: mesPeriodo, anio })
      setSeleccion(new Set())
      portalEnCursoRef.current = null
      setAvisoSubida({
        tipo: 'ok',
        texto: `${etiqueta} quedó en blanco. Traé el listado del portal del SRI: los comprobantes ` +
          'entran solos (o usá «📥 Pegar comprobantes del portal»).',
      })
      await cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo limpiar el período.' })
    }
  }

  const pegarPortal = async () => {
    setMsg(null)
    let texto = null
    try {
      texto = await navigator.clipboard.readText()
    } catch {
      // El navegador puede negar la lectura del portapapeles (permiso denegado,
      // pestaña sin foco, navegador endurecido) y eso no se distingue de "no hay
      // nada copiado": decirlo evita mandar a buscar el problema al SRI.
      setAvisoSubida({
        tipo: 'err',
        texto: 'El navegador no dejó leer el portapapeles. Pero no hace falta copiar ni ' +
          'pegar: en el portal, después de «Traer comprobantes al sistema», tocá «Enviar al ' +
          'sistema» y entran solos.',
      })
      return
    }
    let d = null
    try {
      d = JSON.parse(texto)
    } catch {
      setAvisoSubida({ tipo: 'err', texto: 'En el portapapeles no hay comprobantes del portal. En el SRI, tocá «Traer comprobantes al sistema» en el enviador.' })
      return
    }
    await ingresarPortal(d)
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

  // Un mes ya presentado al SRI no se vuelve a presentar: ofrecerlo era invitar
  // a rehacer un trámite hecho. Sale del selector —sigue estando en las
  // solicitudes guardadas, con su constancia— y solo quedan los que faltan.
  const yaPresentados = useMemo(
    () => periodosDisp.filter((p) => p.estado === 'presentada' || p.estado === 'aprobada'),
    [periodosDisp],
  )
  const periodosPorHacer = useMemo(
    () => periodosDisp.filter((p) => p.estado !== 'presentada' && p.estado !== 'aprobada'),
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

  // Lo que el SRI no admite enviar vacío. Se mira acá, en la misma tabla donde
  // se resuelve: el aviso al intentar enviar decía cuáles faltaban, pero había
  // que ir a buscarlos a ojo entre todas las filas.
  const sinRubro = useMemo(
    () => comps.filter((c) => !(rubroDe[c.id] ?? c.rubro_sugerido ?? '')),
    [comps, rubroDe],
  )
  const visibles = soloSinRubro ? sinRubro : comps

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
      // Sin tipo de gasto no se va al SRI. El combo del portal no admite vacío:
      // el enviador marca los comprobantes, llega a la fila sin clasificar y no
      // tiene qué elegir, así que el trámite queda trabado a mitad de camino —y
      // desde afuera parece que el marcador se colgó—. Se corta acá, que es
      // donde el usuario puede resolverlo con un clic.
      const faltan = r.data.faltan_rubro || []
      if (faltan.length) {
        setSoloSinRubro(true)     // la tabla queda mostrando lo que hay que resolver
        setMsg({
          tipo: 'err',
          texto: `Falta el tipo de gasto en ${faltan.length} comprobante(s): ` +
            faltan.slice(0, 4).join('; ') + (faltan.length > 4 ? '…' : '') +
            '. Elegilo en la tabla (el SRI no admite enviarlos vacíos) y volvé a guardar.',
        })
        return
      }
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
      // A la sección que le toca a esta solicitud, no a la portada: entrar por
      // la de adultos mayores con una solicitud de discapacidad (o al revés) es
      // un viaje perdido, y el enviador ahí no tiene nada que hacer.
      window.open(urlDevolucion(r.data.beneficiario?.tipo), '_blank', 'noopener')
      // La constancia se toma de la pantalla de confirmación del portal, que es
      // la que dice cuántos comprobantes procesó y por cuánto. Puede no coincidir
      // con lo marcado acá: el SRI trabaja con su propio listado filtrado.
      setEnvioDe({ sol, paquete: r.data })
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo preparar el envío.' })
    }
  }

  // El tipo de gasto elegido A MANO se graba en el acto, no al guardar.
  //
  // Antes la decisión vivía solo en la pantalla hasta que alguien tocara
  // "Guardar solicitud": clasificar quince comprobantes y salir sin guardar
  // tiraba las quince, y al volver había que repetirlas. Se guarda por
  // proveedor, que es como se reusa después.
  //
  // Va sin await y sin bloquear: si el guardado del aprendizaje falla, el
  // usuario sigue clasificando y la solicitud igual lo persiste al guardarse.
  // Y alcanza a TODAS las filas de ese proveedor. El tipo de gasto es del
  // proveedor, no del comprobante —así se aprende y así se reusa—, y Coral
  // aparece seis veces en un mes: elegirlo seis veces era repetir la misma
  // decisión. Se puede corregir una fila suelta después, que el último cambio
  // manda.
  const elegirRubro = (comprobante, rubro) => {
    const prov = comprobante.nombre_proveedor
    const hermanos = prov ? comps.filter((c) => c.nombre_proveedor === prov) : [comprobante]
    setRubroDe((prev) => {
      const next = { ...prev }
      hermanos.forEach((c) => { next[c.id] = rubro })
      return next
    })
    if (!rubro || !prov) return
    devolucionesIvaAPI.aprenderRubro(prov, rubro)
      .catch(() => { /* que no se aprenda no puede frenar la clasificación */ })
  }

  // Trae del SRI la actividad económica de los proveedores. Es la mejor pista
  // del tipo de gasto: la razón social no dice el giro y la actividad sí. Va
  // como acción explícita porque el SRI responde de a un RUC por vez y tarda;
  // hacerlo en cada carga de la pantalla la volvería lenta.
  const [sincronizando, setSincronizando] = useState(false)
  const sincronizarActividades = async () => {
    if (!clientId) return
    setSincronizando(true)
    setMsg(null)
    setAvisoSubida({ tipo: 'work', texto: 'Consultando el catastro del SRI…' })
    try {
      const r = await devolucionesIvaAPI.sincronizarActividades(clientId)
      const d = r.data
      const partes = [`${d.actualizados} actividad(es) traída(s) del SRI`]
      if (d.pendientes) partes.push(`quedan ${d.pendientes} para la próxima vuelta`)
      if (d.sin_ruc) {
        partes.push(`${d.sin_ruc} proveedor(es) sin RUC en el sistema: al SRI no se le ` +
          'puede preguntar por nombre, así que esos se resuelven cuando el proveedor ' +
          'aparezca en Gastos con su RUC')
      }
      // En su propio renglón y no en `msg`: `cargar()` empieza limpiando `msg`,
      // así que el resultado se borraba antes de que nadie llegara a leerlo.
      setAvisoSubida({ tipo: d.actualizados ? 'ok' : 'err', texto: partes.join(' · ') })
      cargar()
    } catch (e) {
      setAvisoSubida({
        tipo: 'err',
        texto: e.response?.data?.detail || 'No se pudo consultar al SRI.',
      })
    } finally {
      setSincronizando(false)
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

  // La clave del portal del SRI, a mano. El trámite se hace DENTRO del portal
  // con la sesión del contribuyente, así que tenerla que ir a buscar a otra
  // pantalla en cada devolución es fricción pura. El backend la entrega con la
  // misma autorización que el módulo de claves y deja registro del acceso.
  const [claveSri, setClaveSri] = useState(null)
  const [verClave, setVerClave] = useState(false)
  useEffect(() => {
    setVerClave(false)
    if (!clientId) { setClaveSri(null); return }
    let vigente = true
    devolucionesIvaAPI.claveSri(clientId)
      .then((r) => { if (vigente) setClaveSri(r.data) })
      .catch(() => { if (vigente) setClaveSri(null) })
    return () => { vigente = false }
  }, [clientId])

  // Quién está abierto en el sistema, a la vista del enviador.
  //
  // El marcador, tocado dentro de la app, leía la solicitud del PORTAPAPELES, y
  // ahí queda la del último "Enviar al SRI" —de cualquier contribuyente y de
  // cualquier día—. Resultado: se abría el panel de Judith y mostraba la
  // solicitud de otro, con sus comprobantes y sus montos. Publicando acá quién
  // está abierto, el enviador puede descartar lo que no le corresponde.
  //
  // Es una variable de la página, no un `postMessage`: eso último lo escucha la
  // extensión y le dispararía una presentación en el portal.
  useEffect(() => {
    if (!selectedClient) return undefined
    window.__jomapDevolucionContexto = {
      identificacion: selectedClient.identificacion || '',
      nombre: selectedClient.nombre || '',
      mes: mesPeriodo,
      anio,
    }
    return () => { delete window.__jomapDevolucionContexto }
  }, [selectedClient, mesPeriodo, anio])

  // Y la solicitud del contribuyente abierto, para que el enviador la tome de
  // acá en vez del portapapeles. Sin `auto`: se deja a la vista, no se autoriza
  // nada —autorizar sigue siendo tocar "Enviar al SRI"—.
  useEffect(() => {
    let vigente = true
    if (!solicitudActual?.id) {
      delete window.__jomapDevolucionPaquete
      return () => { vigente = false }
    }
    devolucionesIvaAPI.envio(solicitudActual.id)
      .then((r) => { if (vigente) window.__jomapDevolucionPaquete = r.data })
      .catch(() => { if (vigente) delete window.__jomapDevolucionPaquete })
    return () => {
      vigente = false
      delete window.__jomapDevolucionPaquete
    }
  }, [solicitudActual?.id])

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
      // El portal manda sobre el estado. Si dice que ese período YA está en
      // trámite, el mes está presentado —lo haya hecho el enviador o alguien a
      // mano, hoy o el mes pasado— y así queda registrado, con esa constancia y
      // sin inventar cifras: el SRI no las muestra en ese aviso.
      if (c.ya_en_tramite) {
        registrarEnvio(sol, {
          comprobantes: null, monto: null, fecha_carga: null, mensaje: c.mensaje,
        })
        setMsg({
          tipo: 'ok',
          texto: 'El portal del SRI informa que ese período ya estaba en trámite: ' +
            'quedó marcado como presentado. Los montos son los del sistema; el SRI no ' +
            'los detalla en ese aviso.',
        })
        return
      }
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
        // El RUC de cada proveedor, que solo aparece en el detalle del SRI: con
        // él se puede pedir su actividad económica, que es de donde sale el
        // tipo de gasto propuesto.
        proveedores: c.proveedores || null,
      })
    }
    window.addEventListener('message', alLlegarConstancia)
    return () => window.removeEventListener('message', alLlegarConstancia)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solicitudes])

  // Y el listado del portal llega solo, por el mismo camino: el enviador lo
  // publica al traerlo, la extensión lo guarda y lo entrega al volver a esta
  // pestaña. Antes había que copiarlo y pegarlo a mano —«Traer comprobantes al
  // sistema» dejaba el trabajo a medias en el portapapeles, y el mes se perdía
  // cada vez que la copia fallaba o alguien cerraba la pestaña sin pegar—.
  // Sin extensión sigue estando «📥 Pegar comprobantes del portal».
  useEffect(() => {
    const alLlegarComprobantes = async (ev) => {
      // Dos remitentes posibles: la extensión, que publica en esta misma
      // ventana, y el PORTAL DEL SRI, que abre esta pestaña para entregar el
      // listado sin pasar por el portapapeles. De cualquier otro origen, nada.
      const delPortal = ev.source !== window && ES_PORTAL_SRI.test(String(ev.origin || ''))
      if (ev.source !== window && !delPortal) return
      const d = ev.data
      if (!d || d.tipo !== 'jomap-devolucion-comprobantes-app' || !d.bulto) return
      const b = d.bulto
      const filas = Array.isArray(b.filas) ? b.filas : []
      // La extensión reintenta la entrega cada vez que la pestaña vuelve al
      // frente (no lo suelta hasta que se ingresa): sin esta marca, el mismo
      // listado entraría dos veces.
      const firma = `${b.identificacion || ''}|${b.anio}-${b.mes}|${filas.length}|${filas[0]?.serie || ''}`
      if (portalEnCursoRef.current === firma) return
      portalEnCursoRef.current = firma
      setMsg(null)
      const r = await ingresarPortal(b, { automatico: true })
      if (r.soltar) window.postMessage({ tipo: 'jomap-devolucion-comprobantes-ingresados' }, '*')
      // Al portal se le contesta SIEMPRE —entró o no—: es lo que le permite
      // decir en su panel si el listado llegó, en vez de dejar al usuario
      // adivinando entre dos pestañas.
      if (delPortal && ev.source) {
        try {
          ev.source.postMessage({
            tipo: 'jomap-devolucion-comprobantes-ingresados',
            ok: r.ok, soltar: r.soltar,
          }, ev.origin)
        } catch { /* la pestaña del portal se cerró */ }
      }
      if (!r.ok) portalEnCursoRef.current = null     // que se pueda reintentar
    }
    window.addEventListener('message', alLlegarComprobantes)
    return () => window.removeEventListener('message', alLlegarComprobantes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, selectedClient?.identificacion, tipo, porcentaje])

  // Y al abrir la pantalla (o al cambiar de contribuyente) se pide lo que haya
  // esperando: volver del SRI y navegar acá dentro de la app no dispara ningún
  // `focus`, y entonces el listado se quedaría guardado sin que nadie lo
  // reclame. Va aparte de la escucha para no repetir el pedido con cada tecla
  // del porcentaje de discapacidad.
  useEffect(() => {
    window.postMessage({ tipo: 'jomap-devolucion-comprobantes-pedido' }, '*')
    // Y si a esta pestaña la abrió el portal del SRI para entregar su listado,
    // se lo pedimos a él: sin extensión ese es el único camino, y es el que
    // evita el copiar-y-pegar. El pedido no lleva dato alguno, así que puede ir
    // a cualquier origen; lo que llega de vuelta sí se comprueba.
    try {
      if (window.opener) window.opener.postMessage({ tipo: 'jomap-devolucion-comprobantes-pedido' }, '*')
    } catch { /* la pestaña del portal ya no está */ }
  }, [clientId])

  const eliminar = async (sol) => {
    if (!window.confirm(`¿Eliminar la solicitud de ${String(sol.mes).padStart(2, '0')}/${sol.anio}?`)) return
    try {
      await devolucionesIvaAPI.eliminar(sol.id)
      cargar()
    } catch (e) {
      setMsg({ tipo: 'err', texto: e.response?.data?.detail || 'No se pudo eliminar.' })
    }
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

      {periodosPorHacer.length > 0 && (
        <section className="dv-periodos">
          <div className="dv-periodos-head">
            <h2>📅 ¿Qué mes vas a validar?</h2>
            <p>
              La devolución se presenta <strong>mes a mes</strong> en el portal del SRI.
              Elegí uno para revisarlo comprobante por comprobante, o marcá varios meses
              anteriores y prepararlos de una.
              {yaPresentados.length > 0 && (
                <> {yaPresentados.length} mes(es) ya presentado(s) no se ofrecen acá;
                  están abajo, en las solicitudes guardadas.</>
              )}
            </p>
          </div>
          <div className="dv-periodos-lista">
            <button
              className={`dv-periodo ${!periodoSel ? 'activo' : ''}`}
              onClick={() => setPeriodoSel(null)}
              title="Volver al período configurado del contribuyente"
            >Período del cliente</button>
            {periodosPorHacer.map((p) => (
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
        <button
          className="dv-btn"
          onClick={limpiarPeriodo}
          disabled={!comps.length && !ocultos.length && !solicitudActual}
          title="Vaciar la devolución de este mes (borra la solicitud y el listado traído del portal) para armarla de nuevo. No borra las facturas de Gastos."
        >🧹 Limpiar comprobantes</button>
        {claveSri && (
          <span className="dv-clave-sri" title="Clave del portal del SRI de este contribuyente. Cada vez que se muestra queda registrado en la bitácora de accesos.">
            {claveSri.hay ? (
              <>
                🔑 <strong>{claveSri.usuario || selectedClient?.identificacion}</strong>
                {' · '}
                <code>{verClave ? claveSri.clave : '••••••••'}</code>
                <button className="dv-clave-btn" onClick={() => setVerClave((v) => !v)}>
                  {verClave ? 'ocultar' : 'ver'}
                </button>
                <button
                  className="dv-clave-btn"
                  onClick={() => navigator.clipboard?.writeText(claveSri.clave)
                    .then(() => setAvisoSubida({ tipo: 'ok', texto: 'Clave del SRI copiada.' }))
                    .catch(() => setAvisoSubida({ tipo: 'err', texto: 'No se pudo copiar la clave.' }))}
                >copiar</button>
              </>
            ) : (
              <em title={claveSri.motivo}>🔑 sin clave cargada</em>
            )}
          </span>
        )}
        <button
          className="dv-btn"
          onClick={sincronizarActividades}
          disabled={sincronizando}
          title="Consulta al SRI la actividad económica de los proveedores: es de donde sale la propuesta de tipo de gasto"
        >{sincronizando ? '⏳ Consultando al SRI…' : '🔄 Actividades del SRI'}</button>
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
        {/* La base gravada no se muestra: el portal del SRI no la informa, así
            que con el flujo normal marcaba $0,00 siempre. Lo que se devuelve, y
            lo único que el trámite mira, es el IVA. */}
        <div className="dv-res-card"><span>IVA marcado</span><strong>{fmtMoney(totales.iva)}</strong></div>
        <div className={`dv-res-card destacado ${totales.excedente > 0 ? 'alerta' : ''}`}>
          <span>IVA a solicitar</span><strong>{fmtMoney(totales.solicitar)}</strong>
          {totales.excedente > 0 && <em>supera el tope en {fmtMoney(totales.excedente)}</em>}
        </div>
        <button className="dv-btn primary" onClick={guardar} disabled={guardando || !seleccion.size}>
          {guardando ? 'Guardando…' : (solicitudActual ? '💾 Actualizar solicitud' : '💾 Guardar solicitud')}
        </button>
      </div>

      {sinRubro.length > 0 && (
        <p className="dv-fuera dv-falta-rubro">
          ⚠ <strong>{sinRubro.length} comprobante(s) sin tipo de gasto.</strong> El SRI no
          admite enviarlos vacíos: el trámite se traba en el portal al llegar a esas filas.{' '}
          <button className="dv-fuera-btn" onClick={() => setSoloSinRubro((v) => !v)}>
            {soloSinRubro ? 'ver todos' : 'mostrar solo esos'}
          </button>
          {' · '}
          <button className="dv-fuera-btn" onClick={sincronizarActividades} disabled={sincronizando}>
            {sincronizando ? 'consultando…' : 'proponer con la actividad del SRI'}
          </button>
        </p>
      )}

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
                <th><input type="checkbox" checked={seleccion.size === comps.length && comps.length > 0} onChange={toggleTodos} title="Marcar/desmarcar todos (los del período, no solo los que se ven)" /></th>
                <th>Fecha</th>
                <th>Proveedor</th>
                <th>Tipo de gasto</th>
                <th>Clasificación</th>
                {/* Ni base gravada ni total: la grilla del portal no los informa
                    —solo el IVA del comprobante— y quedaban dos columnas de
                    guiones. Lo que se solicita al SRI es el IVA. */}
                <th className="num">IVA</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id} className={seleccion.has(c.id) ? 'sel' : ''} onClick={() => toggle(c.id)}>
                  <td><input type="checkbox" checked={seleccion.has(c.id)} onChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} /></td>
                  <td>{c.fecha}</td>
                  <td title={c.ruc_sri || c.ruc_proveedor}>{c.nombre_proveedor}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className={`dv-rubro ${!(rubroDe[c.id] || c.rubro_sugerido) ? 'sin-asignar' : ''}`}
                      value={rubroDe[c.id] ?? c.rubro_sugerido ?? ''}
                      onChange={(e) => elegirRubro(c, e.target.value)}
                      title="Tipo de gasto al que se direcciona este comprobante (es el mismo combo del portal del SRI)"
                    >
                      <option value="">— Elegí el tipo de gasto —</option>
                      {rubros.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                    </select>
                  </td>
                  {/* La clasificación es la ACTIVIDAD ECONÓMICA del SRI: es el
                      dato que dice a qué se dedica el proveedor y de donde sale
                      la propuesta de tipo de gasto. La de Gastos queda de
                      respaldo para los comprobantes que no vienen del portal. */}
                  <td className="dv-clasif">
                    {c.actividad ? (
                      <span className="dv-actividad"
                        title={`Actividad económica en el SRI${c.ruc_sri ? ` · RUC ${c.ruc_sri}` : ''}`}>
                        {c.actividad}
                      </span>
                    ) : c.origen === 'portal' ? (
                      <span className="dv-chip-portal"
                        title="Lo lista el portal del SRI. Sin actividad: ese proveedor todavía no figura con RUC en el sistema">
                        SRI · sin actividad
                      </span>
                    ) : (c.clasificacion || 'SIN CLASIFICAR')}
                  </td>
                  <td className="num">{fmtMoney(c.iva)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="dv-quitar" onClick={() => quitarComprobante(c)}
                      title="Sacar este comprobante de la devolución (sigue en Gastos)">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {noListado > 0 && (
        <p className="dv-fuera">
          Esta devolución lleva <strong>solo lo que el SRI lista</strong>: {noListado} comprobante(s)
          más del mes están cargados en Gastos y el portal no los reconoce (bancos, seguros,
          lo que no califica), así que no van en la solicitud. Siguen en Gastos, intactos.
        </p>
      )}

      {ocultos.length > 0 && (
        <p className="dv-fuera">
          {ocultos.length} comprobante(s) que sacaste de esta devolución (siguen en Gastos).{' '}
          <button className="dv-fuera-btn" onClick={mostrarOcultos}>volver a mostrarlos</button>
        </p>
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
            <strong> «Traer comprobantes al sistema»</strong>: elige el mes y lee la grilla.</li>
          <li>Ahí mismo, tocá <strong>«Enviar al sistema»</strong>: los comprobantes
            <strong> entran solos</strong>, sin copiar ni pegar. Con la extensión instalada
            entran igual con solo volver a esta pantalla.</li>
        </ol>
        <button className="dv-btn primary" onClick={onPegarPortal}>
          📥 Pegar comprobantes del portal
        </button>
        <p className="dv-vacio-nota">
          El botón es el respaldo: sirve si copiaste el listado desde el portal con
          «Copiar para el sistema».
        </p>
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
