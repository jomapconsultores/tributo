# Devolución de IVA en el portal del SRI — flujo real

Recorrido y verificado en el portal el **6 de agosto de 2026**, presentando una
solicitud real de julio 2026. Este documento existe porque el trámite cambió
respecto de lo que asumía el módulo: el SRI ya no pide cargar comprobante por
comprobante a mano, sino que **presenta él mismo el listado filtrado** y solo
pide confirmar montos y tipo de gasto.

> Sin datos de contribuyentes: el repositorio es público.

## Aplicaciones

| Beneficiario | Ruta |
|---|---|
| Adultos mayores | `devolucionTerceraEdad-internet/pages/terceraEdad/procesarDTE.jsf` |
| Personas con discapacidad | `devolucionTerceraEdad-internet/pages/personasDiscapacidad/procesarPersonasDiscapacidad.jsf` |

Son la **misma aplicación** con dos entradas, bajo el menú *Devoluciones (TAX
refund)*. **La app abre la que le toca a la solicitud** (`urlDevolucion()` en
`frontend/src/utils/enviadorDevolucion.js`, con los parámetros MPT completos):
antes abría la portada del SRI y había que llegar a la sección a mano, con el
riesgo de entrar a la que no era —y ahí el enviador no tiene nada que hacer—.
*Cambiado el 2026-08-16; la URL de discapacidad no está probada contra el portal.* El mismo menú ofrece además *Prevalidación*, *Recuperación código de
confirmación* y *Consulta devolución automática*.

### Acceso

El portal pasa por `tuportal-internet` con `login=true`, así que **cada pestaña
necesita su propia sesión iniciada a mano**. Con la sesión hecha, la navegación
por el menú entra sin rebotar. No se puede automatizar desde el servidor: el
envío ocurre en la sesión del contribuyente.

> **Nunca navegar a la URL directa de la aplicación, ni recargar la página.**
> Comprobado el 2026-08-06: recargar `procesarDTE.jsf` dispara Keycloak con
> `client_id=app-devolucion-iva-tercera-edad-internet&login=true` y **tira la
> sesión abajo**, aunque la pestaña estuviera adentro. Hay que volver a
> autenticarse a mano.
>
> Si la aplicación se cuelga en "Espere por favor" (pasa: el acordeón de
> *Ingresar facturas electrónicas* a veces deja el overlay pegado), la salida
> **no** es recargar: es entrar de nuevo por el menú lateral
> *Devoluciones (TAX refund) → Devolución de IVA - Adultos mayores*, que
> reinicia el asistente conservando la sesión.
>
> Cuidado: eso vale tocando el menú a mano. El 2026-08-11, **navegando por ese
> mismo enlace desde código la sesión se cayó igual**: el enlace apunta a
> `tuportal-internet/accederAplicacion.jspa`, que rebota a Keycloak con
> `login=true`. O sea que un script no puede reiniciar el asistente por su
> cuenta; cuando hace falta reiniciar, tiene que pedirlo.

## Pasos

1. **Aviso legal** → *Aceptar*. Advierte que solo se verán comprobantes de
   *bienes y servicios de primera necesidad, en establecimientos verificados por
   el SRI*, y que las facturas con **devolución automática total** no aparecen.
2. **Cuenta bancaria** de acreditación (radio entre las registradas) → *Aceptar*.
3. **Menú de dos pasos:** *Ingresar facturas electrónicas* · *Envío de solicitud*.
4. **Ingresar facturas electrónicas** → combos *Año solicitado* y *Período
   solicitado* (**un mes**, solo meses cerrados) → *Buscar*.
5. **Grilla "Listado de comprobantes recibidos"**, una fila por factura:
   `No. · RIDE · Razón social · Tipo y serie · Fecha · Monto IVA · IVA solicitado
   · Tipo de gasto · Seleccionar` → *Procesar facturas seleccionadas*.
6. Aparece el **Detalle de comprobantes de venta** (agrupado por RUC de
   proveedor) y el **Total** → *Guardar selección realizada*.
7. **Envío de solicitud** muestra el resumen y la advertencia del art. 298 del
   COIP → *Cargar Información*. Confirma con *"Carga de archivo realizada
   exitosamente"* y un comprobante imprimible con la fecha y hora de carga.

## Reglas que condicionan el enviador

0. **El combo `Período` nace VACÍO.** Trae una sola opción ("Seleccione un
   período") y el portal lo llena por AJAX **recién cuando se elige el año**;
   solo ofrece meses ya cerrados y sus `value` son el número de mes
   (`julio=7`). Llenar año y período seguidos falla siempre.
   *Verificado en el portal el 2026-08-11.*
1. **`IVA solicitado` y `Tipo de gasto` nacen deshabilitados.** Se habilitan al
   marcar la casilla de la fila. El orden es: marcar → esperar el AJAX → llenar.
   Marcar **repinta la fila**: la confirmación y los pasos siguientes hay que
   leerlos sobre el nodo nuevo, buscándolo otra vez por serie.
1a. **La casilla en activo NO prueba que la marca llegó.** El widget se pinta
   activo en el acto y el checkbox interno se marca solo con el click, escuche o
   no el portal; el AJAX que registra la selección viene después. Lo único que
   prueba que llegó es que **`IVA solicitado` y `Tipo de gasto` queden
   habilitados**: hasta entonces la fila está a medias, y llenarla ahí es
   escribir sobre un nodo que el repintado ya va a reemplazar —queda marcada, sin
   tipo de gasto, y el portal no la procesa—. Era esto lo que hacía que "Llenar y
   presentar" pareciera no hacer nada. *Corregido el 2026-08-12.*
1bis. **La grilla pagina de a 10** (`Filas por página` 10/15/20). Hay que
   recorrer las páginas y **comprobar que la página cambió**: el repintado de
   las marcas se come el click en "siguiente", y a ciegas el recorrido se queda
   releyendo la misma página e informa como ausentes comprobantes que sí están.
   *Verificado con 21 comprobantes de julio 2026.*
1ter. **`Buscar` NO reinicia el paginador, y si quedó en una página posterior el
   paginador se muere.** Tras una consulta nueva la grilla sigue en la página en
   la que estaba; en ese estado no responde **nada**: ni *primera*, ni el número
   de página, ni cambiar *Filas por página*. El recorrido va hacia adelante, así
   que leer ahí devuelve solo la última página y da por ausente todo lo anterior.
   El enviador lo detecta —lee "(3 of 3)"— y **se corta pidiendo volver a entrar**
   en vez de armar una solicitud incompleta en silencio.
   *Verificado el 2026-08-11.*
1quater. **El "Tipo de gasto" solo entra ABRIENDO EL DESPLEGABLE Y TOCANDO LA
   OPCIÓN.** Es un `p:selectOneMenu` y hay tres caminos posibles; solo uno sirve.
   Probado contra el portal real el 2026-08-12 con la solicitud de julio:

   | Cómo | Qué muestra el combo | Qué dice el portal al procesar |
   |---|---|---|
   | `select.value='4'` + `change` | "Seleccione" | — |
   | `PF(widget).selectValue('4')` | **"alimentación"** | ✖ *"La factura solicitada … no detalla el tipo de gasto"* |
   | click en el `<li>` del panel | "alimentación" | ✔ procesa sin quejarse |

   O sea que `selectValue` **pinta la etiqueta pero el dato no llega al
   servidor**: mirar el combo no alcanza para darlo por bueno. Y el desplegable
   se ubica **por id** —`…cmbTipoGasto_panel`, colgado del `body`, uno por
   fila—: se vieron cuatro abiertos a la vez, y tomar "el panel visible" hace
   que el click caiga en otra fila.
1quinquies. **Lo que el portal RECLAMA hay que leerlo, y hay que esperarlo.** Al
   tocar *Procesar facturas seleccionadas* el SRI contesta una de dos cosas: el
   detalle (con *Guardar selección realizada*) o un reclamo —el conocido es
   *"La factura solicitada … no detalla el tipo de gasto"*, que aparece cuando el
   tipo de gasto se pintó en el combo pero no llegó al servidor (ver 1quater)—.
   El enviador no los leía nunca: pintaba *"Selección guardada"* pasara lo que
   pasara y seguía hasta presentar. Ahora espera a que llegue **cualquiera de las
   dos** y, si es un reclamo, **corta el mes** con el texto del SRI a la vista y
   sin avisarle a la app —así la solicitud no queda marcada como presentada—.
   Mirar una sola vez apenas vuelve la tapa de *"Espere por favor"* no sirve: el
   ajax tarda más que la tapa y no se ve nada. *Corregido el 2026-08-16.*
2. **Al marcar, el portal auto-rellena el IVA solicitado** con el monto completo
   de la factura. Solo hay que corregirlo cuando el mes supera el tope.
3. **El período es mensual.** Un contribuyente semestral necesita seis
   solicitudes, una por mes.
4. **Los comprobantes se identifican por serie** (`003-301-000089145`), no por
   clave de acceso: es la llave para casar cada fila con `invoices.factura_numero`.

## El listado sale del portal, no de Gastos

La consecuencia de fondo del rediseño del trámite: **no hay que llevarle
facturas al SRI**. El portal muestra las que él reconoce y el trabajo es
marcar, clasificar y enviar. Así que el módulo ya no depende de que esos
comprobantes estén cargados en Gastos:

- El enviador tiene **"Traer comprobantes al sistema"**: recorre la grilla del
  mes y lee el listado (serie, fecha, proveedor, monto IVA).
- **Ese listado viaja SOLO al sistema** (agregado 2026-08-17), por el mismo
  camino que la constancia: el enviador lo publica (`postMessage`
  `jomap-devolucion-comprobantes`), la extensión lo guarda y se lo entrega a la
  pantalla de devoluciones (`jomap-devolucion-comprobantes-app`), que lo ingresa
  sola. Antes terminaba en el **portapapeles** y había que acordarse de pegarlo:
  si la copia fallaba —o alguien cerraba la pestaña, o volvía a la app días
  después— el mes se perdía y había que recorrer la grilla del SRI otra vez.
  - **No se suelta hasta que la app avisa que los ingresó**
    (`jomap-devolucion-comprobantes-ingresados`). La constancia sí se consume al
    entregarla, pero acá volver a la pestaña en el momento equivocado —otra
    pantalla abierta, otro contribuyente— tiraría el mes a la basura.
  - **La app lo pide al abrir la pantalla**
    (`jomap-devolucion-comprobantes-pedido`): navegar dentro de la app no
    dispara ningún `focus`, y sin el pedido el listado se quedaría esperando.
  - **No entra en el contribuyente equivocado**: si el RUC del listado no es el
    que está abierto, la pantalla lo dice y lo deja esperando —al abrir a quien
    corresponde, entra solo—. Es la misma regla que ya frenaba al enviador.
  - **Sin extensión también entra solo** (agregado 2026-08-22): el panel ofrece
    **"Enviar al sistema"**, que abre la app en una pestaña y le pasa el listado
    por `postMessage` cross-origin. La pantalla, al montar, se lo pide a la
    ventana que la abrió (`...-pedido` al `window.opener`) y contesta si entró
    (`...-ingresados` con `ok`), que es lo que el panel del portal muestra. Antes
    quedaba el camino de copiar y pegar, con el mes colgando del portapapeles.
    - La app **solo acepta el bulto de un origen del SRI** (`*.sri.gob.ec`); de
      cualquier otra ventana, nada.
    - **El listado se ofrece hasta que alguien lo toma** (cada 2 s, hasta 2 min).
      Esperar el pedido de la app no alcanzaba: ese pedido sale al montar la
      pantalla de devoluciones, y la pestaña recién abierta puede caer antes en
      el login o en el listado de contribuyentes —ahí no hay nadie escuchando, y
      un `postMessage` a una ventana sin listener se pierde sin error—. Tampoco
      lo suelta si el sistema lo rechaza por tener abierto a otro contribuyente:
      al abrir a quien corresponde, entra solo (igual que con la extensión).
    - El enviador sabe dónde vive la app por dos vías: la extensión lo anota
      (`contenido-app.js` guarda `app_origen` y `contenido-sri.js` lo inyecta
      como `window.__jomapAppOrigen`), y el marcador lo trae incrustado desde la
      app que lo generó (`JOMAP_APP_ORIGEN`, reemplazado en
      `enviadorDevolucion.js` por `location.origin`). Si no hay ninguna, queda
      **"Copiar para el sistema"** y **"📥 Pegar comprobantes del portal"**.
    - Se prueba con `python scripts/test_entrega_al_sistema.py`: dos servidores
      locales en puertos distintos (portal y sistema) para que el `postMessage`
      sea cross-origin de verdad, con `scripts/app_falsa_devolucion.html` de
      pantalla.
- En la app, `POST /devoluciones-iva/portal` crea la solicitud del mes con esas
  filas, proponiendo el tipo de gasto por la clasificación que el proveedor ya
  tenga en Gastos o, si no, por su nombre.
- **La mejor pista es la ACTIVIDAD ECONÓMICA del SRI** (agregado 2026-08-16). El
  orden de la propuesta es: lo que el usuario ya decidió para ese proveedor →
  su actividad económica → su clasificación en Gastos → su nombre. La razón
  social no dice el giro; la actividad sí (*"venta al por menor … productos
  alimenticios"* → alimentación).
  - El catastro del SRI se consulta **por RUC**: los servicios
    `obtenerPorRazonSocial` y `obtenerPorNombreComercial` **no existen** en la API
    pública (probado el 2026-08-16, dan 404). Y la grilla del portal no trae RUC.
  - Por eso la actividad se **hereda casando el nombre** con el mismo proveedor
    en Gastos, que sí tiene RUC, usando la misma normalización con la que se
    aprende el tipo de gasto. El proveedor que nunca pasó por Gastos se queda sin
    actividad: no hay a quién preguntarle por nombre.
  - **🔄 Actividades del SRI** (`POST /devoluciones-iva/actividades`) trae las que
    falten y las guarda en `classification_map`. Es una acción aparte porque el
    SRI responde de a un RUC por vez: va de a 20 por llamada e informa cuántos
    quedaron pendientes y cuántos no tienen RUC.
  - Las pistas se prueban con `python scripts/test_rubros_actividad.py`. Están
    escritas para DOS vocabularios distintos —el del catastro ("ENSEÑANZA",
    "PRENDAS DE VESTIR") y el de los nombres comerciales—, y la comparación va
    sin tildes ni Ñ.
- **La devolución lleva SOLO lo que el SRI lista** (2026-08-22). Traída la
  grilla del período, el gasto que el contribuyente tenga cargado y el portal no
  reconozca —bancos, seguros, servicios— no entra en la lista: no va en la
  solicitud y en pantalla obligaba a sacarlo a mano de a uno. Se informa cuántos
  quedaron fuera (`gasto_no_listado`) para que no parezca que falta algo. Lo ya
  guardado en la solicitud se respeta aunque venga de Gastos.
  - **El mismo comprobante puede estar de los dos lados** (cargado en Gastos y
    listado por el SRI). Es UNO: manda la fila del portal —es la que el SRI
    procesa, con SU monto de IVA— y de la de Gastos hereda RUC, clave y
    clasificación. Antes se descartaba por repetida y con ella se perdía la
    marca: una solicitud guardada se veía como "0 de 36 marcados" y $0,00.
- **Cada período es independiente**: la lista se acota siempre a los meses que
  cubre el período (uno, o seis si es semestral), venga o no el mes en el
  pedido. Antes el filtro solo corría con mes explícito, así que abrir la
  pantalla en el período del cliente mostraba todo el gasto cargado, de
  cualquier mes.
- Esos items van **sin `invoice_id`** —no son facturas de Gastos— y se
  distinguen en la pantalla con el chip `SRI`. Como la grilla no informa la
  base imponible, van con base y total en cero y la pantalla muestra "—".
- **La grilla y lo excluido viven en la BD** (`devoluciones_iva_portal`,
  migración 062, 2026-08-22): una fila por contribuyente y período, con `filas`
  (la grilla tal cual la mostró el portal) y `excluidos` (lo que el usuario sacó
  de esa devolución, que sigue en Gastos). Traer el listado otra vez
  **reemplaza** el anterior y deja el mes sin nada excluido: no se acumulan dos
  grillas del mismo mes, ni tapa lo nuevo lo que se sacó de lo viejo.
  - Estaba en el `localStorage` de cada navegador (`devIvaPortal:` /
    `devIvaFuera:`), así que el mes traído en la oficina no aparecía en la
    laptop, limpiar el navegador borraba el listado —que no está en Gastos y
    solo existe ahí— y nada quedaba respaldado.
  - `GET /comprobantes` devuelve la lista ya armada y `ocultos` aparte;
    `POST /excluidos` guarda la lista completa de lo que queda fuera (reemplaza)
    y `POST /periodo/limpiar` vacía el mes: borra la solicitud, la grilla, y saca
    de la devolución el gasto que quedaba en pantalla.
  - Se prueba con `python scripts/smoke_portal_en_bd.py --api http://127.0.0.1:8010`
    (contra el backend y la BD reales; borra lo que crea).

Sigue funcionando el camino viejo (subir TXT/XML a Gastos), pero es secundario:
el SRI puede listar comprobantes que el contribuyente nunca cargó, y deja fuera
los de devolución automática total aunque estén en Gastos.

## Qué automatiza el enviador

`sri_downloader/bookmarklet_devolucion.js`, botón **"Llenar y presentar en el
portal"**. Desde 2026-08-16 **arranca donde esté el portal**: si hace falta,
camina el asistente entero antes de trabajar —aviso legal → cuenta bancaria →
menú de dos pasos → *Ingresar facturas electrónicas*—, reconociendo cada
pantalla por su TEXTO, porque sus ids son `j_idt` autogenerados. Dos frenos
deliberados: si el portal ofrece **más de una cuenta bancaria** no elige ninguna
—a dónde entra la plata lo decide el contribuyente— y si la sesión caducó, corta
y lo dice. Antes exigía que todo eso estuviera hecho a mano:

0bis. **La solicitud sale del contribuyente abierto, no del portapapeles.** El
   marcador leía el paquete de `navigator.clipboard`, y ahí queda el del último
   *Enviar al SRI* —de cualquier contribuyente y de cualquier día—. Tocándolo
   dentro de la app se abría el panel de un contribuyente mostrando la solicitud,
   los comprobantes y los montos de OTRO. Ahora la pantalla de devoluciones
   publica en la página quién está abierto (`window.__jomapDevolucionContexto`) y
   la solicitud de ese contribuyente (`window.__jomapDevolucionPaquete`, sin
   `auto`: se muestra, no se autoriza); el marcador prefiere eso y **descarta**
   lo que traiga el portapapeles si es de otro, diciéndolo. *Corregido el
   2026-08-16.* Se publica como variable de página y no con `postMessage`: eso
   último lo escucha la extensión y le dispararía una presentación en el portal.
0. **Antes de tocar nada, mira con quién está tratando.** La cabecera del SRI
   dice quién abrió el portal (`0400533824001 CORAL LIDIA MAGOLA`) y la ruta dice
   en qué sección está. Si el contribuyente no es el de la solicitud, o la
   sección no es la del beneficiario, **corta sin tocar una casilla**: presentar
   la solicitud de una persona dentro de la sesión de otra es declarar a nombre
   equivocado, y no se deshace. El caso que lo motivó: cuando la copia al
   portapapeles falla, el marcador lee el paquete **anterior** que quedó ahí, y
   el panel muestra el nombre de otro contribuyente sin que nadie lo note.
   *Agregado el 2026-08-16.* Si el portal no dice quién es, no bloquea: frenar
   por no saber sería frenar siempre.
1. Elige año y mes y toca *Buscar*.
2. Recorre la grilla (y sus páginas) casando cada fila por **serie**: marca la
   casilla, espera el ajax, elige el tipo de gasto y corrige el *IVA solicitado*
   solo cuando el acumulado del mes pasaría el tope.
3. Informa lo que no pudo: comprobantes de la solicitud que el portal no lista
   (no califican), filas del portal ajenas a la solicitud, y los que quedaron
   fuera por tope.
4. *Procesar facturas seleccionadas* → *Guardar selección realizada*.
5. **El envío final va aparte**: *Cargar Información* queda detrás de una
   confirmación con los números a la vista, porque es irreversible.
6. Lee la constancia y la copia como JSON para pegarla en la app
   (`comprobantes`, `monto`, `fecha_carga`, `mensaje`).
7. **Y se la manda de vuelta a la app** (`postMessage`
   `jomap-devolucion-constancia`, con el `solicitud_id`): la extensión la guarda
   y se la entrega a la pantalla cuando el usuario vuelve a esa pestaña, que
   marca la solicitud como **Presentada** sola. *Agregado el 2026-08-16, porque
   el trámite quedaba hecho en el SRI y en Borrador en el sistema: registrar el
   envío dependía de volver a la app a pegar la constancia a mano, y con el
   recorrido automático ya nadie volvía.* Con un semestral son seis
   presentaciones en el portal y **una sola** solicitud acá: la constancia que
   viaja es la suma de los meses, y si alguno no confirmó viaja **sin mensaje**
   —la app avisa y no da nada por presentado—.

La tabla se repinta en cada ajax, así que el script vuelve a buscar la fila por
serie antes de cada paso; los controles se ubican por etiqueta propia y por el
patrón de la serie, nunca por ids `j_idt…`.

**Cuando el portal no coopera** (2026-08-12): marcar se intenta de tres maneras
—la caja del widget, el checkbox interno, la etiqueta— porque el SRI cambia el
control entre versiones y probar una sola es quedarse sin marcar nada sin poder
decir por qué. La que funciona se recuerda para las demás filas. Cada comprobante
se anuncia en el panel ANTES de tocarlo y la línea se cierra con el resultado: un
panel quieto no se distingue de uno colgado, y esperar por fila son segundos. Si
los tres primeros comprobantes no quedan marcados, **corta** en vez de gastar diez
segundos por fila en veinte filas, y ofrece *Copiar diagnóstico*, que ahora
incluye la anatomía de la primera fila (esqueleto de etiquetas, ids y clases; sin
texto, así no arrastra datos del contribuyente).

Se prueba con `python scripts/test_enviador_devolucion.py`, que corre el marcador
**minificado** contra `scripts/portal_devolucion_falso.html` en sus variantes: el
widget escucha / solo escucha el checkbox interno / no escucha nadie / **el
portal rechaza la selección al procesar** (`quejoso`), más el recorrido semestral,
el de la extensión y el de **`traer`** —el listado del portal viajando solo hasta
la app, con su acuse de recibo—. Contra el portal real hay que probarlo con una solicitud
verdadera.

## Tipo de gasto — catálogo cerrado del SRI

| Código | Etiqueta en el portal |
|---|---|
| 1 | vestimenta |
| 2 | vivienda |
| 3 | salud |
| 4 | alimentación |
| 5 | educación |

El módulo usaba antes ocho rubros; *turismo*, *servicios básicos* y *otros* no
existen en el portal. Hoy el catálogo del backend es exactamente este
(`RUBROS` en `backend/routers/devoluciones_iva.py`, con su código `sri`), los
servicios básicos se proponen como *vivienda*, y un comprobante sin tipo de
gasto **no se puede guardar**: el combo del SRI no admite vacío.

## Identificadores del formulario

Prefijo `frmPanelFacturacionElectronicaTerceraEdad:`

| Control | ID |
|---|---|
| Año | `cmbAnio_input` |
| Período (mes) | `cmbPeriodo_input` |
| Buscar | `btnBuscarComprobantesElectronicos` |
| IVA solicitado, fila *i* | `tblFacturas:{i}:txtIvaSolicitado` |
| Tipo de gasto, fila *i* | `tblFacturas:{i}:cmbTipoGasto_input` |
| Marcar, fila *i* | `tblFacturas:{i}:j_idt248_input` ⚠️ id autogenerado |
| Procesar facturas seleccionadas | `btnGuardarFacturasSeleccionadas` |
| Guardar selección realizada | `btnFinalizarCargaComprobantesElectronicos` |
| **Cargar Información** (envío final) | `j_idt91:btnCargarInformacion` |

Los ids `j_idt…` los genera JSF y **cambian entre versiones del portal**: hay que
buscar esos controles por etiqueta o por posición dentro de la fila, no por id.

## Discapacidad

- El **porcentaje no se ingresa**: el SRI lo toma del registro del MSP. Sin
  registro vigente, el portal corta antes de la grilla ("acérquese al Ministerio
  de Salud Pública…"; para sustitutos, MDT o MIES). En el módulo el porcentaje
  se usa solo para calcular el tope propio.
- Los bienes del **art. 96 de la LOD** se presentan **físicamente** en un Centro
  de Atención del SRI, no por este canal.
- La grilla de discapacidad **sigue sin verificarse contra el portal**: hace falta
  un contribuyente con registro vigente. Lo que se hizo (2026-08-16) es que no
  haga falta confiar en que sea igual:
  - **El tipo de gasto se elige por la ETIQUETA, no por el código.** Los códigos
    1..5 son los de adultos mayores; si allá el 4 no fuera *alimentación*, elegir
    por código habría puesto el rubro equivocado sin que nadie se enterara. El
    nombre del gasto es el mismo dato en las dos entradas; el código es una
    suposición. Si código y etiqueta discrepan, el panel lo **avisa** —y ese
    aviso sobrevive a la pantalla de constancia—.
  - **El corte por falta de registro se reconoce.** Sin registro vigente el
    portal manda al MSP (o al MDT/MIES si es sustituto) y nunca llega a la
    grilla; antes eso se informaba como *"no encontré el botón Buscar"*, que
    manda a buscar el problema donde no está.
  - **El diagnóstico trae el catálogo completo del combo** (código y etiqueta de
    cada opción). Son etiquetas fijas del SRI, no arrastran datos del
    contribuyente: es lo que hay que copiar la primera vez que se entre con un
    contribuyente real para dar la grilla por verificada.
  - Las filas se identifican por el **patrón de la serie**, no por columnas, así
    que un orden distinto de columnas no rompe el recorrido.
  - Se prueba con el modo `discapacidad` de `portal_devolucion_falso.html`, que
    simula lo peor plausible: los mismos nombres con los códigos cambiados de
    lugar.

## Parámetros legales

`RBU_POR_ANIO` y `BASE_MAX_RBU` en `backend/routers/devoluciones_iva.py`.
Con RBU 2026 = 482, el tope de adultos mayores es **361.50/mes**
(5 × 482 × 15 %). **Revisar cada enero** contra el acuerdo ministerial y contra
la *Guía para contribuyentes* que el propio portal publica en su primera pantalla.
