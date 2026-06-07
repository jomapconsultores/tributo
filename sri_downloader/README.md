# SRI Downloader

Descargador local de comprobantes del SRI Ecuador (facturas recibidas, retenciones, facturas emitidas). Corre **100% en tu PC**: las credenciales nunca salen de tu máquina.

## ⚠ Iteración 1 (actual)

Solo está implementado **login** + verificación de credenciales. Las descargas vienen en la próxima iteración.

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

## Roadmap

| Iter | Estado | Qué entrega |
|---|---|---|
| 1 | ✅ | Login Keycloak + config + CLI |
| 2 | 📋 | Scraper de Comprobantes Recibidos (gastos + retenciones) |
| 3 | 📋 | Scraper de Facturas Emitidas (Facturador SRI) |
| 4 | 📋 | Upload + clasificación automática al tributos-api |
| 5 | 📋 | Scraper de Devolución IVA Tercera Edad (alimenta el módulo DEVOLUCIONES IVA del frontend) |
