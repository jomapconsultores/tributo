# SRI Downloader

Descargador local de comprobantes del SRI Ecuador (facturas recibidas, retenciones, facturas emitidas). Corre **100% en tu PC**: las credenciales del SRI nunca salen de tu máquina.

## Estado actual (iteraciones 1, 2, 3 y 4; iteración 5 en scaffold)

Implementado: **login**, **descarga del listado de Comprobantes Recibidos** (TXT con
claves de acceso, por período y tipo), **descarga del listado de Comprobantes Emitidos**
(ventas), y **upload automático** de esos listados al tributos-api, que baja los XML por
SOAP y los clasifica igual que una subida manual.

Con la unión al tributos-api, **Retenciones** e **Ingresos IVA** ya tienen unión completa
además de Gastos:

- **Gastos**: `comprobantes --tipo factura --upload` → `POST /api/invoices/process-txt`.
- **Retenciones** (recibidas): `comprobantes --tipo retencion --upload` → `POST /api/retentions/process-txt`.
- **Ingresos IVA (ventas)**: `emitidos --upload` → `POST /api/sales-iva/process-txt`.

**Devolución de IVA - Adultos mayores (iteración 5)**: flujo navegado, LEÍDO y ESCRITO,
todo probado contra el portal real logueado. Es una app JSF/PrimeFaces aparte
(`devolucionTerceraEdad-internet`) con su propio cliente OIDC; se entra con la URL completa
con params MPT (`FULL_URL` en `core/devoluciones.py`) tras el login del perfil. Wizard:
intro → convenio de débito (cuenta bancaria) → Ingresar facturas → año/mes → Buscar → grid
(marcar + IVA solicitado + tipo de gasto) → Procesar → *Envío de solicitud*.

```powershell
# MENÚ: lista todas las personas y, al elegir una, abre el SRI logueado y
# auto-completa su devolución (deja el navegador abierto para revisar/presentar):
..\venv\Scripts\python.exe descargar.py devoluciones lista
# Auto-completar directo para una persona (deja el navegador abierto):
..\venv\Scripts\python.exe descargar.py devoluciones preparar --ruc 0400533824001 --anio 2026 --mes 6
# Flujo COMPLETO: prepara + guarda + llega a 'Envío de solicitud' y frena (vos presentás):
..\venv\Scripts\python.exe descargar.py devoluciones enviar --ruc 0400533824001 --anio 2026 --mes 6
# ...y con --confirmar PRESENTA de verdad (IRREVERSIBLE, responsabilidad legal 5-7 años):
..\venv\Scripts\python.exe descargar.py devoluciones enviar --ruc 0400533824001 --anio 2026 --mes 6 --confirmar
# Leer las facturas elegibles del período (read-only):
..\venv\Scripts\python.exe descargar.py devoluciones leer --ruc 0400533824001 --anio 2026 --mes 6
```

En `devoluciones lista` se muestran todas las personas de `clientes.local.json`. Para
marcar quién hace devolución (adultos mayores) y que aparezcan primero con la etiqueta
`(devolución)`, agregá `"devolucion": true` a esa persona en `clientes.local.json`:

```json
{ "ruc": "0400533824001", "clave": "…", "alias": "Lidia Magola Coral", "devolucion": true }
```

`core/devoluciones.py` expone: `leer_detalle` (lee el grid), `marcar_factura` / `preparar_solicitud`
(marca facturas + fija IVA solicitado + tipo de gasto), `procesar_seleccionadas` (arma el borrador).
La **presentación final** (`presentar_solicitud`) está **bloqueada** salvo `confirmar=True` explícito
y su paso F ('Envío de solicitud') aún no se implementó: es un trámite legal irreversible y no se
dispara sin confirmación manual. Tipos de gasto del portal: alimentación, educación, salud,
vestimenta, vivienda.

## Setup (una sola vez)

```powershell
# Desde C:\Users\mapos\Dropbox\Programas\tributos-web\sri_downloader
..\venv\Scripts\python.exe -m pip install -r requirements.txt
..\venv\Scripts\python.exe -m playwright install chromium
```

## Configurar clientes

```powershell
..\venv\Scripts\python.exe descargar.py init
```

Eso crea `clientes.local.json` (gitignored). Editalo y reemplazá los ejemplos con tus RUCs y claves del SRI:

```json
{
  "clientes": [
    { "ruc": "1791234567001", "clave": "AbCd1234!", "alias": "Mi Cliente S.A." }
  ]
}
```

## Probar el login

```powershell
..\venv\Scripts\python.exe descargar.py list
..\venv\Scripts\python.exe descargar.py test-login --ruc 1791234567001
```

Por defecto **abre el navegador visible** para que veas qué pasa. Cuando termina el login te deja la ventana abierta para que confirmes que entraste; presionás Enter en la consola para cerrarla.

Si querés correr sin ventana (después de confirmar que funciona):

```powershell
..\venv\Scripts\python.exe descargar.py test-login --ruc 1791234567001 --headless
```

## Qué hace el login

1. Abre `https://srienlinea.sri.gob.ec/sri-en-linea/contribuyente/perfil`.
2. SRI redirige al Keycloak con sus state/nonce propios.
3. Llena RUC + clave automáticamente y submit.
4. Espera el redirect de vuelta al perfil.
5. Guarda el `storage_state` (cookies) en `playwright_state/<RUC>/storage.json` para reusar en próximos comandos sin re-loguear.

Si Keycloak rechaza credenciales, ves `Credenciales rechazadas por el SRI`. Si el form cambió, ves `No encontré ningún input...` y se guarda screenshot + HTML en `debug/<RUC>/`.

## Seguridad

- `clientes.local.json` está en `.gitignore`. NO lo commitees.
- `playwright_state/` también está gitignored (contiene cookies de sesión).
- `descargas/` ídem.

## Descargar comprobantes recibidos (y subirlos al sistema)

```powershell
# Solo descargar el listado TXT del período (queda en descargas/<RUC>/)
..\venv\Scripts\python.exe descargar.py comprobantes --ruc 1791234567001 --anio 2026 --mes 6

# Descargar Y subir al tributos-api (config "api" en clientes.local.json):
# el backend baja los XML por SOAP con esas claves y clasifica automáticamente.
..\venv\Scripts\python.exe descargar.py comprobantes --ruc 1791234567001 --anio 2026 --mes 6 --upload

# Otros tipos (solo descarga local): retencion, nota_credito, nota_debito, liquidacion
..\venv\Scripts\python.exe descargar.py comprobantes --ruc 1791234567001 --anio 2026 --mes 6 --tipo retencion
```

Para `--upload` agregá en `clientes.local.json` (raíz, junto a `"clientes"`):

```json
"api": { "base_url": "http://localhost:8000", "email": "tu_usuario", "password": "tu_clave_del_sistema" }
```

El contribuyente debe existir en la web con ese período (Clientes → mes/año); el upload valida período y descarta duplicados.

## Roadmap

| Iter | Estado | Qué entrega |
|---|---|---|
| 1 | ✅ | Login Keycloak + config + CLI |
| 2 | ✅ | Scraper de Comprobantes Recibidos (gastos + retenciones: listado TXT) |
| 3 | ✅ | Scraper de Comprobantes Emitidos (ventas / ingresos IVA: listado TXT) |
| 4 | ✅ | Upload + clasificación automática al tributos-api (`--upload`: gastos, retenciones e ingresos IVA) |
| 5 | 🚧 | Devolución IVA Adultos mayores (`core/devoluciones.py`) — **EN PROGRESO**: URL real confirmada (`procesarDTE.jsf`) + comando `devoluciones capturar` que vuelca el HTML/screenshot del portal (período + grid de facturas) para extraer selectores. Lectura del grid/estado pendiente del primer dump real; carga/envío de la solicitud queda fuera de alcance (trámite legal, no se simula). La solicitud ya se arma en el módulo web. |
