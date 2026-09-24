/* ------------------------------------------------------------
 * Desarrollado por Marco Antonio Posligua San Martín
 * ------------------------------------------------------------ */

/**
 * Manual de uso para el CLIENTE.
 *
 * Cada sección se muestra solo si la persona tiene ese módulo y esa pantalla:
 * el manual es de lo que ESTA persona puede hacer, no de todo lo que existe.
 * Explicarle a alguien una pantalla que no puede abrir solo genera llamadas
 * preguntando por qué no le aparece.
 *
 * Está escrito para quien usa el sistema, no para quien lo administra: nada de
 * módulos, submódulos ni permisos, sino «sube el archivo del SRI» y «revisa el
 * valor a pagar».
 *
 * REGLA DE LO QUE ENTRA: una pantalla se documenta si el CLIENTE hace algo en
 * ella con sus propios datos. No basta con que la tenga habilitada. Quedan
 * fuera, aunque el módulo «gestion» venga en todos los planes:
 *   · Informe general → resumen de gestión del despacho, de todos sus clientes.
 *   · Honorarios del mes, emitir y cruce con Odoo → el cobro que hace el
 *     despacho. Del lado del cliente solo se documenta CONSULTAR las facturas
 *     que se le emitieron, que sí es suyo.
 *   · Clientes pendientes, claves del SRI, activaciones, usuarios y permisos →
 *     trabajo interno.
 * Al administrador se le muestra el manual entero (es el que leen sus clientes,
 * y tiene que poder revisarlo) con una nota que lo dice.
 *
 * Se puede guardar en PDF con el botón de imprimir: hay clientes que lo quieren
 * a mano, impreso al lado del computador.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAccess } from '../context/AccessContext'
import './Manual.css'

export default function Manual() {
  const navigate = useNavigate()
  const { has, hasSub, isSuperAdmin, role } = useAccess()
  // Quien es del despacho (lo administra o trabaja en él) ve el mismo manual
  // del cliente, con una nota que se lo aclara: así no busca aquí cómo activar
  // un cobro ni cómo repartir permisos, que no están ni van a estar.
  const esDelDespacho = isSuperAdmin || ['admin', 'socio', 'trabajador'].includes(role)

  // Cada sección declara qué hace falta para verla. `ver: true` = siempre.
  const secciones = useMemo(() => [
    {
      id: 'empezar',
      titulo: 'Para empezar',
      ico: '🚪',
      ver: true,
      intro: 'Lo básico para moverte por el sistema.',
      pasos: [
        'Entra con tu correo y tu clave. Si la olvidaste, usa «¿Olvidaste tu clave?» en la pantalla de ingreso, o pídesela a quien te administra el servicio.',
        'A la izquierda está el menú: cada ícono es un módulo y, al tocarlo, se abre su lista de pantallas. Solo verás los módulos incluidos en tu plan.',
        'En «Clientes» está tu RUC. Si manejas más de uno, ahí eliges sobre cuál vas a trabajar: todo lo que hagas después se guarda para ese RUC y ese mes.',
        'Arriba de cada pantalla eliges el mes y el año del período que estás trabajando. Revísalo siempre antes de empezar: es el error más común.',
        'En «Mi cuenta» (abajo a la izquierda) cambias tu clave, tus datos y revisas tu plan.',
      ],
    },
    {
      id: 'pagos',
      titulo: 'Tu plan y tus pagos',
      ico: '💳',
      ver: true,
      intro: 'Cómo pagar la mensualidad y avisar de tu pago para que te activen el acceso.',
      pasos: [
        'Entra a «Mi cuenta» → «Mi plan y pagos». Ahí ves tu plan, el valor mensual y hasta qué día tienes acceso.',
        'Haz la transferencia por el valor que indica la pantalla (el valor mostrado ya incluye IVA).',
        'Pulsa «Ya pagué: enviar comprobante» y llena los datos: período que pagas, valor, fecha, banco y número de comprobante.',
        'Adjunta la foto o el PDF de la transferencia. Si pagaste en varias transferencias, adjúntalas TODAS en el mismo envío y escribe en el valor el total sumado.',
        'Envía. Tu comprobante queda «En revisión» y al administrador le llega el aviso.',
        'Cuando lo aprueben, tu acceso se activa y se corre la fecha del próximo pago. Si tenías la pantalla abierta, recárgala o usa el botón «Ya me activaron: entrar».',
        'Si algo no cuadra con tu pago, el comprobante aparece como «No confirmado» con el motivo escrito, y puedes enviarlo de nuevo corregido.',
      ],
      nota: 'Si tu acceso se pausa por falta de pago, la misma pantalla de aviso te deja enviar el comprobante: no necesitas llamar a nadie para volver a entrar.',
      ir: '/mi-cuenta',
    },
    {
      id: 'gastos',
      titulo: 'Gastos (compras)',
      ico: '💸',
      ver: has('gastos') && hasSub('gastos_facturas'),
      intro: 'Cargar las facturas de compra que te emitieron, para que entren a tu declaración.',
      pasos: [
        'Elige tu RUC y el mes que vas a trabajar.',
        'Descarga del portal del SRI el archivo de comprobantes recibidos. El menú «Bajador-GASTOS (SRI)» te da el atajo que hace esa descarga por ti.',
        'Sube el archivo TXT o los XML en la pantalla «Gastos». El sistema lee cada factura: proveedor, fecha, subtotales, IVA y retenciones.',
        'Revisa el resumen: total de facturas, base imponible e IVA. Si algo falta, vuelve a bajar el archivo del SRI y súbelo otra vez.',
        'En «Datos guardados» ves todo lo que quedó registrado, puedes buscar, corregir y volver a descargar los XML originales.',
      ],
      ir: '/',
    },
    {
      id: 'clasificador',
      titulo: 'Clasificar los gastos',
      ico: '🏷️',
      ver: has('gastos') && hasSub('gastos_clasificar'),
      intro: 'Decir a qué rubro va cada compra, que es lo que arma bien tu declaración y tu anexo.',
      pasos: [
        'Abre «Clasificador de Gastos». Verás las facturas que subiste, agrupadas por proveedor.',
        'A cada proveedor le asignas su rubro una sola vez: el sistema recuerda esa decisión y clasifica solo las compras siguientes de ese mismo RUC.',
        'Revisa los que quedaron sin clasificar (aparecen marcados) y complétalos.',
        'Puedes seleccionar varias filas a la vez y clasificarlas juntas.',
      ],
      ir: '/clasificador',
    },
    {
      id: 'retenciones',
      titulo: 'Retenciones que te hicieron',
      ico: '🧾',
      ver: has('retenciones'),
      intro: 'Las retenciones que tus clientes te aplicaron y que descuentas en tu declaración.',
      pasos: [
        'Elige tu RUC y el mes.',
        'Sube el archivo de retenciones del SRI (el mismo atajo «Bajador-GASTOS» te permite bajarlas).',
        'Revisa el total retenido de IVA y de Renta: son los valores que se descuentan de lo que tienes que pagar.',
      ],
      ir: '/retenciones',
    },
    {
      id: 'ingresos_iva',
      titulo: 'Ingresos (ventas)',
      ico: '📈',
      ver: has('ingresos_ice') && hasSub('ice_ingresos_iva'),
      intro: 'Cargar tus ventas del mes para que se declaren correctamente.',
      pasos: [
        'Elige tu RUC y el mes.',
        'Sube los XML de las facturas que emitiste, o usa el atajo «Bajador-INGRESOS (SRI)» para bajarlas del portal.',
        'Revisa el resumen de ventas por tarifa (15 %, 5 %, 0 %) antes de declarar.',
      ],
      ir: '/ingresos-iva',
    },
    {
      id: 'ice',
      titulo: 'ICE: cálculo y anexos',
      ico: '🥃',
      ver: has('ingresos_ice') && (hasSub('ice_calculo') || hasSub('ice_xml') || hasSub('ice_anexo')),
      intro: 'Para quien produce o comercializa bienes con Impuesto a los Consumos Especiales.',
      pasos: [
        'En «Catálogo de productos» registras cada producto una vez: grado, capacidad, categoría y su código ICE.',
        'En «Cálculo previo ICE» pones cuánto vas a vender y el sistema calcula el ICE específico, el ad valórem y el precio sugerido, antes de facturar.',
        'En «Rebajas y exenciones» registras los ingredientes nacionales y sus proveedores calificados, que es lo que te da derecho a la rebaja.',
        'En «Ingresos ICE - XML» subes las ventas efectivamente facturadas del mes.',
        'En «Anexo PVP+ICE» generas el anexo con el formato que pide el SRI para subirlo a su portal.',
      ],
      ir: hasSub('ice_calculo') ? '/calculo-ice' : '/ice',
    },
    {
      id: 'declaraciones',
      titulo: 'Declaraciones',
      ico: '📋',
      ver: has('declaraciones') && (hasSub('decl_iva') || hasSub('decl_ice')),
      intro: 'Armar la declaración del mes con lo que ya cargaste, y presentarla en el SRI.',
      pasos: [
        'Elige tu RUC y el período. El sistema arma la declaración con tus gastos, ventas y retenciones ya cargados.',
        'Revisa casillero por casillero. Los valores se calculan solos, pero puedes ajustar el crédito tributario del mes anterior y las ventas si hiciera falta.',
        'Mira el valor a pagar y, si corresponde, elige diferir el pago en los meses permitidos.',
        'Guarda la declaración. Desde ahí puedes cargarla en el portal del SRI con un clic y marcarla como presentada.',
        'Una vez presentada queda cerrada como constancia de lo declarado ese mes.',
      ],
      nota: 'Guardar la declaración aquí no la presenta ante el SRI: la presentación se hace en el portal, y el sistema te lleva hasta ahí con los datos cargados.',
      ir: hasSub('decl_iva') ? '/declaracion-iva' : '/declaracion-ice',
    },
    {
      id: 'devoluciones',
      titulo: 'Devolución de IVA',
      ico: '💰',
      ver: has('declaraciones') && hasSub('decl_devoluciones'),
      intro: 'Para adultos mayores y personas con discapacidad: armar la solicitud de devolución.',
      pasos: [
        'Elige al beneficiario —tú o la persona a tu cargo— y el período (mensual o semestral, según corresponda).',
        'El sistema toma tus facturas de gasto del período y arma el detalle de comprobantes.',
        'Revisa el rubro de cada comprobante y el valor de IVA a solicitar.',
        'Guarda la solicitud y preséntala en el portal del SRI; el sistema te ayuda a subirla y registra lo que el SRI procesó.',
      ],
      ir: '/devoluciones-iva/tercera-edad',
    },
    {
      id: 'agente_ret',
      titulo: 'Retenciones que tú efectúas',
      ico: '🧷',
      ver: has('agente_retencion') && hasSub('agret_retenciones'),
      intro: 'Si eres agente de retención: las retenciones que tú le haces a tus proveedores.',
      pasos: [
        'Elige tu RUC y el mes.',
        'Sube o registra las retenciones emitidas del período.',
        'Con eso se arma tu declaración 103 de Renta.',
      ],
      ir: '/retenciones-efectuadas',
    },
    {
      id: 'compradores',
      titulo: 'Compradores',
      ico: '👥',
      ver: has('datos') && hasSub('dat_compradores'),
      intro: 'La ficha de a quién le vendes, para los anexos que piden identificar al comprador.',
      pasos: [
        'Registra el RUC o cédula, el nombre y los datos del comprador.',
        'Quedan disponibles para los anexos y reportes que los necesiten.',
      ],
      ir: '/compradores',
    },
    {
      id: 'honorarios',
      titulo: 'Tus facturas de honorarios',
      ico: '🧾',
      ver: has('gestion') && hasSub('gest_facturacion'),
      intro: 'Consultar las facturas que te hemos emitido por el servicio.',
      pasos: [
        'Abre «Facturación» y entra a la pestaña de facturas.',
        'Ahí ves las facturas emitidas a tu nombre, con su fecha, su valor y su estado.',
        'Es solo para consulta: verás únicamente los documentos de tu propio RUC.',
      ],
      nota: 'Esto es lo que se te factura por el servicio, y no tiene que ver con tus propias ventas: esas van en «Ingresos».',
      ir: '/facturacion',
    },
    {
      id: 'capacitaciones',
      titulo: 'Capacitación y acompañamiento',
      ico: '🎓',
      ver: has('gestion') && hasSub('gest_capacitaciones'),
      intro: 'Pedir una hora de acompañamiento cuando necesites ayuda con algo puntual.',
      pasos: [
        'Entra a «Capacitaciones» y crea tu solicitud: tema, si la prefieres en línea o presencial, y la fecha que te vendría bien.',
        'Tu solicitud queda pendiente hasta que se confirme.',
        'Cuando la confirmen, recibes el aviso con la fecha y hora definitivas.',
      ],
      ir: '/capacitaciones',
    },
    {
      id: 'normativa',
      titulo: 'Normativa y material de consulta',
      ico: '📖',
      ver: true,
      intro: 'La ley y los documentos de apoyo, disponibles dentro del sistema.',
      pasos: [
        'En «Normativa» consultas la LRTI y demás cuerpos legales, con buscador.',
        'En los módulos de ICE encuentras además la presentación y los códigos vigentes.',
      ],
      ir: '/normativa',
    },
    {
      id: 'problemas',
      titulo: 'Si algo no funciona',
      ico: '🆘',
      ver: true,
      intro: 'Lo que puedes resolver tú mismo antes de pedir ayuda.',
      pasos: [
        'No puedo entrar: revisa que el correo esté bien escrito. Si la clave no funciona, usa «¿Olvidaste tu clave?» en la pantalla de ingreso.',
        'Dice que mi acceso está en pausa: es falta de pago. En esa misma pantalla puedes enviar tu comprobante y se reactiva al revisarlo.',
        'No veo una pantalla que antes usaba: puede que ese módulo no esté incluido en tu plan. Consúltalo con quien te administra el servicio.',
        'Subí un archivo y no aparece: confirma que estás en el mes correcto y en el RUC correcto.',
        'La página se ve rara o no carga: recarga con Ctrl+F5. Si aparece el aviso «Nueva versión disponible», pulsa «Actualizar».',
      ],
    },
  ], [has, hasSub])

  const visibles = secciones.filter((s) => s.ver)

  return (
    <div className="man-wrap">
      <header className="man-header">
        <h1>📘 Manual de uso</h1>
        <p className="man-sub">
          Guía de lo que puedes hacer en el sistema, paso a paso. Muestra únicamente
          las pantallas que tienes habilitadas.
        </p>
        <button className="man-print" onClick={() => window.print()}>
          🖨 Imprimir o guardar en PDF
        </button>
      </header>

      {esDelDespacho && (
        <div className="man-admin-nota">
          <strong>Estás viendo el manual del cliente.</strong> Es el mismo que lee cada
          cliente, y a ti te sale completo porque tienes todos los módulos: cada uno ve
          solo las secciones de lo que tiene contratado.
          <br />
          Lo tuyo no está aquí a propósito. Administrar cobros y activaciones, crear
          usuarios, repartir permisos, las claves del SRI, los honorarios del despacho y
          el informe de gestión son trabajo interno y no se documentan en un manual que
          leen los clientes.
        </div>
      )}

      <nav className="man-indice">
        {visibles.map((s) => (
          <a key={s.id} href={`#${s.id}`}>{s.ico} {s.titulo}</a>
        ))}
      </nav>

      {visibles.map((s) => (
        <section key={s.id} id={s.id} className="man-sec">
          <h2>{s.ico} {s.titulo}</h2>
          <p className="man-intro">{s.intro}</p>
          <ol>
            {s.pasos.map((p, i) => <li key={i}>{p}</li>)}
          </ol>
          {s.nota && <p className="man-nota">💡 {s.nota}</p>}
          {s.ir && (
            <button className="man-ir" onClick={() => navigate(s.ir)}>
              Ir a {s.titulo} →
            </button>
          )}
        </section>
      ))}

      <footer className="man-pie">
        ¿Te quedó una duda que el manual no resuelve? Escríbenos y la resolvemos —
        y si es algo que se repite, la agregamos aquí.
      </footer>
    </div>
  )
}
