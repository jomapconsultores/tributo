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
refund)*. El mismo menú ofrece además *Prevalidación*, *Recuperación código de
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

1. **`IVA solicitado` y `Tipo de gasto` nacen deshabilitados.** Se habilitan al
   marcar la casilla de la fila. El orden es: marcar → esperar el AJAX → llenar.
2. **Al marcar, el portal auto-rellena el IVA solicitado** con el monto completo
   de la factura. Solo hay que corregirlo cuando el mes supera el tope.
3. **El período es mensual.** Un contribuyente semestral necesita seis
   solicitudes, una por mes.
4. **Los comprobantes se identifican por serie** (`003-301-000089145`), no por
   clave de acceso: es la llave para casar cada fila con `invoices.factura_numero`.

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
- La grilla de discapacidad **no está verificada**: hace falta un contribuyente
  con registro vigente para confirmar que las columnas y el catálogo de tipo de
  gasto son los mismos.

## Parámetros legales

`RBU_POR_ANIO` y `BASE_MAX_RBU` en `backend/routers/devoluciones_iva.py`.
Con RBU 2026 = 482, el tope de adultos mayores es **361.50/mes**
(5 × 482 × 15 %). **Revisar cada enero** contra el acuerdo ministerial y contra
la *Guía para contribuyentes* que el propio portal publica en su primera pantalla.
