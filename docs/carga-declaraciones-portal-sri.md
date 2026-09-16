# Cargar declaraciones y anexos en el portal del SRI — cómo funciona

Recorrido en el portal real el **16 de septiembre de 2026**, con sesión de
contribuyente. La carga de una declaración de IVA con valores ficticios se
probó de punta a punta, sin guardar. Los anexos y los formularios de ICE y 103
se recorrieron hasta el punto de carga, sin entregar archivos.

> Sin datos de contribuyentes: el repositorio es público.

## Declaraciones (IVA, ICE, 103)

Aplicación `sri-declaraciones-web-internet`, una sola para todos los formularios:

| Formulario | `identificadorGrupoObligacion` | Obligación (combo) | Concepto del RUC del contador |
|---|---|---|---|
| IVA mensual | `IVA` | `2011 DECLARACION DE IVA` | 2810 |
| IVA semestral | `IVA` | `2021 - DECLARACIÓN SEMESTRAL IVA` | 2810 |
| Retenciones | `RETENC` | `1031 - DECLARACIÓN DE RETENCIONES EN LA FUENTE` | 120 |
| ICE | `ICE` | `3031 - ICE BEBIDAS ALCOHÓLICAS` (y los demás productos) | 80 |

La URL con los parámetros MPT (`services/carga_sri.py::URL_FORMULARIO`) abre el
formulario directo si la sesión está viva; si no, pasa por el login y **vuelve
al formulario**.

### Pasos

1. **Período fiscal**: combo *Obligación* (`p:selectOneMenu`: hay que abrirlo y
   tocar el `<li>`) y, al elegirla, aparece *Período*, un selector de mes
   (`.month-picker`, botones `a.button-1`…`a.button-12`, flechas de año).
   *Siguiente* = `frmFlujoDeclaracion:btnObligacionSiguiente`.
2. **Preguntas**: el cuestionario sí/no y, oculto, `#archivoInput`
   (`accept=".json,.xml"`). Muestra además *Tipo declaración*: ORIGINAL o
   SUSTITUTIVA.
3. **Formulario**: cada casillero es un `<input id="concepto<N>">`.
4. **Pago**: la extensión no llega hasta aquí.

### La carga por archivo del propio SRI

`cargarArchivo(event, rcAvanzarPerfilamientoPorArchivo, {idConceptoRucContador, esquemaAnexoDeclaracion})`:

- lee el archivo (máx. 4 MB). Si es XML toma `<detalle concepto="N">valor</detalle>`;
  si no, lo parsea como JSON `{"detallesDeclaracion": {"N": "valor"}}`;
- lo guarda en `sessionStorage.jsonContenido` y llama al remote command, que
  salta el cuestionario y abre el paso *Formulario*;
- `llenarFormularioConAlmacenamientoLocal` escribe cada valor en
  `concepto<N>`. Los conceptos que no existen se ignoran. En el ICE, además,
  nunca escribe 142, 146 y 450, que son las tarifas.

**El concepto no es el casillero.** El 411 del IVA es `concepto460` y el 303 del
ICE es `concepto140`. Las tablas completas están en `backend/services/carga_sri.py`.
Se leyeron tomando, para cada campo, el número que muestra la celda anterior.
Los campos de solo lectura, que calcula el SRI, no se mandan.

Comprobado: con 401/411/421/500/510/520 cargados, el formulario calculó por su
cuenta 409, 419, 429, 509, 519, 529 y 601.

### Lo que el sistema no traslada solo

El sistema usa algunos números con otro sentido que el formulario, y esos
valores se listan en la confirmación y en el panel para llenarlos a mano:
480/481/484 del IVA (diferimientos), R-50, DIF, 903 y 904 del ICE, y los
conceptos de retención «intereses a bancos» y «otro».

Cuando el sistema tiene un solo valor, lo pone también en el **valor bruto**
(401, 425, 403, 431, 500, 540, 530, 507, 531, 532, 303, 313), porque no registra
notas de crédito ni devoluciones.

## Anexos ICE y PVP

Aplicación `rig` (`/rig/pages/menuInicial.xhtml?codOperativo=ICE|PVP`).
Acordeón *Carga de archivo xml* → `p:fileUpload` `…:frmRecepcion:anexosSubir`:

- **solo `.zip`**, hasta 8 MB;
- **`auto: true`**: al elegir el archivo **se sube y se valida en el acto**.
  Actualiza el panel de datos del contribuyente, los errores y los botones.
- el envío es el botón **Aceptar** (`…:frmRecepcion:j_idt96`, id generado), que
  la extensión no toca.

No se probó entregando un anexo real: falta ver en el portal qué muestra
cuando el ZIP es válido y cuándo lo rechaza.

## No verificado todavía

- El selector de **semestre** de la obligación 2021. Por eso la extensión pide
  elegirlo a mano y sigue sola desde *Preguntas*.
- El formulario ICE de productos que no sean bebidas alcohólicas: la tabla es la
  del 3031.
