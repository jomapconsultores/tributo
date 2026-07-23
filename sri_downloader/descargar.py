"""CLI del descargador del SRI.

Comandos:
  python descargar.py init          Crea clientes.local.json desde el template.
  python descargar.py list          Lista los clientes configurados.
  python descargar.py test-login --ruc XXX
                                    Prueba el login Keycloak de un cliente.
                                    Por defecto NO headless: ves el navegador.
  python descargar.py comprobantes --ruc XXX --anio 2026 --mes 6 [--tipo factura] [--upload]
                                    Baja el listado TXT de comprobantes recibidos
                                    del período y (con --upload) lo sube al
                                    tributos-api, que descarga los XML por SOAP.
  python descargar.py emitidos --ruc XXX --anio 2026 --mes 6 [--upload]
                                    Baja las facturas EMITIDAS (ingresos) del
                                    período recorriéndolo DÍA POR DÍA (default),
                                    acumula todas las claves en un TXT y (con
                                    --upload) lo sube a /api/sales-iva/process-txt.
                                    --mes-completo usa el modo viejo (mes entero).
  python descargar.py devoluciones capturar --ruc XXX --anio 2026 --mes 6
                                    Abre el portal real de Devolución de IVA
                                    (tercera edad) y vuelca HTML/screenshot a
                                    debug/ para extraer los selectores (iter 5).
"""
import shutil
import sys
from pathlib import Path

import click

from core.config import (
    BASE_DIR,
    CLIENTES_FILE,
    buscar_cliente,
    cargar_clientes,
    dir_descargas_cliente,
)


@click.group()
def cli():
    """Descargador SRI — corre 100% local, credenciales nunca salen de tu PC."""
    pass


@cli.command("init")
def cmd_init():
    """Crea clientes.local.json desde el template si no existe."""
    if CLIENTES_FILE.exists():
        click.secho(f"Ya existe {CLIENTES_FILE.name}, no lo toco.", fg="yellow")
        return
    src = BASE_DIR / "clientes.example.json"
    shutil.copy(src, CLIENTES_FILE)
    click.secho(f"[OK] Creado {CLIENTES_FILE}", fg="green")
    click.secho(
        "  Editalo y reemplazá los RUCs/claves de ejemplo por los tuyos.\n"
        "  Está gitignored: NO se commitea.",
        fg="cyan",
    )


@cli.command("list")
def cmd_list():
    """Lista los clientes configurados (sin mostrar claves)."""
    try:
        clientes = cargar_clientes()
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    click.echo(f"{len(clientes)} cliente(s) configurado(s):")
    for c in clientes:
        ruc = c.get("ruc", "??")
        alias = c.get("alias", "(sin alias)")
        marca = "[OK]" if c.get("clave") else "[ERR] sin clave"
        click.echo(f"  {marca}  {ruc}  {alias}")


@cli.command("test-login")
@click.option("--ruc", required=True, help="RUC del cliente a probar.")
@click.option("--headless", is_flag=True, default=False,
              help="Corre sin abrir ventana (no recomendado la primera vez).")
def cmd_test_login(ruc: str, headless: bool):
    """Prueba el login Keycloak de un cliente. Útil para validar credenciales."""
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente:
        click.secho(f"[ERR] RUC {ruc} no está en clientes.local.json", fg="red")
        sys.exit(1)
    clave = cliente.get("clave")
    if not clave or clave == "TU_CLAVE_SRI_AQUI":
        click.secho(f"[ERR] El cliente {ruc} no tiene clave configurada.", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
    except ImportError:
        click.secho(
            "[ERR] Playwright no está instalado. Corré:\n"
            "    pip install -r requirements.txt\n"
            "    python -m playwright install chromium",
            fg="red",
        )
        sys.exit(1)

    click.echo(f"-> Probando login para {ruc} ({cliente.get('alias', '')})...")
    debug_dir = BASE_DIR / "debug" / ruc

    with sync_playwright() as pw:
        try:
            browser, context, page = login(
                pw, ruc, clave, headless=headless, debug_dir=debug_dir
            )
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            if debug_dir.exists():
                click.secho(f"  Revisá los archivos en {debug_dir}", fg="yellow")
            sys.exit(1)

        click.secho(f"[OK] Login OK. URL actual: {page.url}", fg="green")
        try:
            titulo = page.title()
            click.echo(f"  Título de la página: {titulo}")
        except Exception:
            pass

        if not headless:
            click.echo("\n  Dejé la ventana abierta para que confirmes que estás logueado.")
            click.echo("  Presioná Enter acá para cerrar el navegador...")
            try:
                input()
            except EOFError:
                pass

        browser.close()
        click.secho("[OK] Browser cerrado. Estado de sesión guardado para próximos comandos.", fg="green")


@cli.command("comprobantes")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año del período, p.ej. 2026.")
@click.option("--mes", required=True, type=int, help="Mes del período (1-12).")
@click.option("--tipo", default="factura", show_default=True,
              type=click.Choice(["factura", "liquidacion", "nota_credito", "nota_debito", "retencion"]),
              help="Tipo de comprobante a listar.")
@click.option("--upload", is_flag=True, default=False,
              help="Sube el TXT al tributos-api (tipo=factura → gastos, tipo=retencion → retenciones).")
@click.option("--headless/--no-headless", default=True, show_default=True,
              help="Correr el navegador sin ventana.")
def cmd_comprobantes(ruc: str, anio: int, mes: int, tipo: str, upload: bool, headless: bool):
    """Descarga el listado TXT de Comprobantes Recibidos del período.

    Con --upload, además lo sube a POST /api/invoices/process-txt del
    tributos-api (config "api" en clientes.local.json): el backend baja los
    XML por SOAP y los clasifica igual que una subida manual desde la web.
    """
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.comprobantes import ScrapeError, descargar_listado_recibidos
    except ImportError:
        click.secho(
            "[ERR] Playwright no está instalado. Corré:\n"
            "    pip install -r requirements.txt\n"
            "    python -m playwright install chromium",
            fg="red",
        )
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    destino = dir_descargas_cliente(ruc) / f"recibidos_{tipo}_{anio}-{mes:02d}.txt"

    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _context, page = login(
                pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir
            )
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Consultando comprobantes recibidos ({tipo}) de {mes:02d}/{anio}...")
            descargar_listado_recibidos(
                page, anio=anio, mes=mes, tipo=tipo, destino=destino, debug_dir=debug_dir
            )
        except ScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)
        browser.close()

    claves = sum(1 for linea in destino.read_text(encoding="utf-8", errors="ignore").splitlines() if linea.strip())
    click.secho(f"[OK] Listado guardado: {destino} ({claves} línea(s))", fg="green")

    if not upload:
        click.echo("  Podés subirlo a mano en la pantalla de Gastos, o re-correr con --upload.")
        return
    # --upload enruta según el tipo de comprobante: factura → gastos,
    # retencion → retenciones. El resto de tipos aún no tiene endpoint.
    if tipo not in ("factura", "retencion"):
        click.secho("[ERR] --upload solo aplica a tipo=factura (gastos) o tipo=retencion. El TXT quedó guardado.", fg="red")
        sys.exit(1)

    from core.api_client import ApiError, TributosApi
    try:
        click.echo("-> Subiendo al tributos-api...")
        api = TributosApi()
        client_id = api.buscar_client_id(ruc, mes, anio)
        if not client_id:
            click.secho(
                f"[ERR] No existe el contribuyente {ruc} con período {mes:02d}/{anio} en el sistema. "
                "Crealo primero en la web (Clientes) y reintentá.",
                fg="red",
            )
            sys.exit(1)
        if tipo == "retencion":
            res = api.subir_txt_retenciones(client_id, destino)
        else:
            res = api.subir_txt_gastos(client_id, destino)
        api.close()
    except ApiError as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)

    click.secho(
        f"[OK] Subido. Nuevas: {res.get('new', 0)} | duplicadas: {res.get('duplicates', 0)} | "
        f"errores: {res.get('errors', 0)} | fuera de período: {res.get('fuera_de_periodo', 0)}",
        fg="green",
    )
    if res.get("no_descargadas"):
        click.secho(f"  Claves que el SRI no entregó: {res['no_descargadas']}", fg="yellow")


@cli.command("emitidos")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año del período, p.ej. 2026.")
@click.option("--mes", required=True, type=int, help="Mes del período (1-12).")
@click.option("--tipo", default="factura", show_default=True,
              type=click.Choice(["factura", "liquidacion", "nota_credito", "nota_debito", "retencion"]),
              help="Tipo de comprobante emitido a listar.")
@click.option("--upload", is_flag=True, default=False,
              help="Sube el TXT al tributos-api (/api/sales-iva/process-txt → ingresos IVA).")
@click.option("--headless/--no-headless", default=True, show_default=True,
              help="Correr el navegador sin ventana.")
def cmd_emitidos(ruc: str, anio: int, mes: int, tipo: str, upload: bool, headless: bool):
    """Descarga las facturas EMITIDAS (ventas / ingresos) del período recorriéndolo
    DÍA POR DÍA (el form del SRI filtra por 'Fecha emisión', un día a la vez) y
    acumula todas las claves de acceso en un solo TXT (sin duplicados).

    Con --upload, además lo sube a POST /api/sales-iva/process-txt del
    tributos-api (config "api" en clientes.local.json): el backend baja los
    XML por SOAP y los guarda como ingresos IVA, igual que una subida manual.
    """
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.emitidos import ScrapeError, descargar_emitidos_dia_por_dia
    except ImportError:
        click.secho(
            "[ERR] Playwright no está instalado. Corré:\n"
            "    pip install -r requirements.txt\n"
            "    python -m playwright install chromium",
            fg="red",
        )
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    destino = dir_descargas_cliente(ruc) / f"emitidos_{tipo}_{anio}-{mes:02d}.txt"

    def _progreso(dia, total, nuevas, estado):
        color = "green" if estado == "ok" else ("yellow" if estado == "sin datos" else "red")
        extra = f" (+{nuevas} claves)" if estado == "ok" else ""
        click.secho(f"   día {dia:>2}/{total}: {estado}{extra}", fg=color)

    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _context, page = login(
                pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir
            )
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Consultando emitidos ({tipo}) de {mes:02d}/{anio} DÍA POR DÍA...")
            stats = descargar_emitidos_dia_por_dia(
                page, anio=anio, mes=mes, tipo=tipo, destino=destino,
                debug_dir=debug_dir, progreso=_progreso,
            )
            click.secho(
                f"   Resumen: {stats['dias_con_datos']} día(s) con datos, "
                f"{stats['dias_sin_datos']} sin datos, {stats['dias_con_error']} con error.",
                fg="cyan",
            )
        except ScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)
        browser.close()

    claves = sum(1 for linea in destino.read_text(encoding="utf-8", errors="ignore").splitlines() if linea.strip())
    click.secho(f"[OK] Listado guardado: {destino} ({claves} clave(s) de acceso)", fg="green")
    if claves == 0:
        click.secho("  El SRI no reportó facturas emitidas en ese período (o el form cambió; revisá debug/).", fg="yellow")
        return

    if not upload:
        click.echo("  Podés subirlo a mano en la pantalla de Ingresos IVA, o re-correr con --upload.")
        return
    # El módulo de ingresos (sales-iva) parsea todo como VENTA; solo las facturas
    # emitidas son ingresos. Notas/retenciones emitidas caerían en la tabla
    # equivocada, así que se bloquea el --upload para esos tipos (el TXT ya quedó guardado).
    if tipo != "factura":
        click.secho("[ERR] --upload de emitidos solo aplica a tipo=factura (ingresos IVA). El TXT quedó guardado.", fg="red")
        sys.exit(1)

    from core.api_client import ApiError, TributosApi
    try:
        click.echo("-> Subiendo al tributos-api...")
        api = TributosApi()
        client_id = api.buscar_client_id(ruc, mes, anio)
        if not client_id:
            click.secho(
                f"[ERR] No existe el contribuyente {ruc} con período {mes:02d}/{anio} en el sistema. "
                "Crealo primero en la web (Clientes) y reintentá.",
                fg="red",
            )
            sys.exit(1)
        res = api.subir_txt_ventas(client_id, destino)
        api.close()
    except ApiError as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)

    # OJO: /api/sales-iva/process-txt responde en ESPAÑOL
    # (nuevas/duplicadas/errores/...), NO en inglés como gastos.
    click.secho(
        f"[OK] Subido. Nuevas: {res.get('nuevas', 0)} | duplicadas: {res.get('duplicadas', 0)} | "
        f"errores: {res.get('errores', 0)} | rechazadas por ICE: {res.get('rechazadas_por_ice', 0)} | "
        f"fuera de período: {res.get('fuera_de_periodo', 0)}",
        fg="green",
    )
    if res.get("no_descargadas"):
        click.secho(f"  Claves que el SRI no entregó: {res['no_descargadas']}", fg="yellow")


@cli.group("devoluciones")
def cmd_devoluciones():
    """Devolución de IVA - Adultos mayores (tercera edad). Iteración 5."""
    pass


@cmd_devoluciones.command("capturar")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año a consultar (2022-2026).")
@click.option("--mes", required=True, type=int, help="Mes a consultar (1-12).")
@click.option("--headless/--no-headless", default=False, show_default=True,
              help="Por defecto abre el navegador visible para ver el portal.")
def cmd_devoluciones_capturar(ruc: str, anio: int, mes: int, headless: bool):
    """Navega el trámite de Devolución de IVA hasta el GRID de facturas del período
    y vuelca su HTML+screenshot a debug/ (SOLO consulta: no marca ni presenta nada).

    Camina intro -> convenio de debito -> Ingresar facturas -> anio/mes -> Buscar,
    y deja debug/<RUC>/devolucion_grid_<anio>-<mes>.html para confirmar la
    estructura del grid y completar el parser (leer_detalle).
    """
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.devoluciones import DevolucionScrapeError, navegar_a_facturas
    except ImportError:
        click.secho(
            "[ERR] Playwright no está instalado. Corré:\n"
            "    pip install -r requirements.txt\n"
            "    python -m playwright install chromium",
            fg="red",
        )
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _context, page = login(
                pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir
            )
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Navegando el trámite hasta el grid de {mes:02d}/{anio}...")
            navegar_a_facturas(page, anio=anio, mes=mes, debug_dir=debug_dir)
        except DevolucionScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)
        browser.close()

    click.secho(f"[OK] Grid capturado en {debug_dir}", fg="green")
    click.echo(f"  Revisá devolucion_grid_{anio}-{mes:02d}.html (estructura del grid de facturas).")


@cmd_devoluciones.command("leer")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año a consultar (2022-2026).")
@click.option("--mes", required=True, type=int, help="Mes a consultar (1-12).")
@click.option("--headless/--no-headless", default=True, show_default=True)
def cmd_devoluciones_leer(ruc: str, anio: int, mes: int, headless: bool):
    """Lee y lista las facturas ELEGIBLES del período en el portal de Devolución
    (read-only: no marca ni presenta nada)."""
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.devoluciones import DevolucionScrapeError, leer_detalle
    except ImportError:
        click.secho("[ERR] Playwright no está instalado (pip install -r requirements.txt).", fg="red")
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _c, page = login(pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir)
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Leyendo facturas elegibles de {mes:02d}/{anio}...")
            facturas = leer_detalle(page, anio=anio, mes=mes, debug_dir=debug_dir)
        except DevolucionScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)
        browser.close()

    if not facturas:
        click.secho(f"[OK] El SRI no muestra facturas elegibles para {mes:02d}/{anio}.", fg="yellow")
        return
    click.secho(f"[OK] {len(facturas)} factura(s) elegible(s) en {mes:02d}/{anio}:", fg="green")
    total = 0.0
    for f in facturas:
        total += f.monto_iva or 0.0
        click.echo(f"  #{f.numero:>2}  {f.fecha}  {(f.razon_social or '')[:32]:32}  "
                   f"{(f.comprobante or ''):28}  IVA={f.monto_iva}")
    click.echo(f"  Total IVA de comprobantes elegibles: {round(total, 2)}")


@cmd_devoluciones.command("preparar")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año a solicitar (2022-2026).")
@click.option("--mes", required=True, type=int, help="Mes a solicitar (1-12).")
@click.option("--procesar", is_flag=True, default=False,
              help="Guarda el borrador en el SRI (click 'Procesar facturas seleccionadas'). NO presenta.")
@click.option("--headless/--no-headless", default=False, show_default=True,
              help="Por defecto abre el navegador visible para que revises antes de enviar.")
def cmd_devoluciones_preparar(ruc: str, anio: int, mes: int, procesar: bool, headless: bool):
    """AUTO-completa la solicitud de Devolución: marca TODAS las facturas del
    período, pide el IVA completo y asigna el tipo de gasto por heurística.

    NO presenta el trámite. En modo visible (por defecto) deja el navegador
    ABIERTO para que revises el tipo de gasto y, si estás de acuerdo, hagas vos
    'Procesar facturas seleccionadas' y 'Envío de solicitud'. El tipo de gasto es
    best-effort: REVISALO antes de enviar (es un trámite legal).
    """
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)
    _preparar_devolucion(ruc, cliente, anio, mes, procesar, headless)


def _preparar_devolucion(ruc, cliente, anio, mes, procesar, headless):
    """Login + auto-completar la devolución del período (marca todas + IVA + tipo
    de gasto). Deja el navegador ABIERTO (si no headless) para revisar/presentar.
    Reusado por 'preparar' y por el menú 'lista'. NO presenta el trámite."""
    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.devoluciones import DevolucionScrapeError, preparar_solicitud_auto
    except ImportError:
        click.secho("[ERR] Playwright no está instalado (pip install -r requirements.txt).", fg="red")
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _c, page = login(pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir)
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Auto-completando {mes:02d}/{anio} (marcar + IVA + tipo de gasto)...")
            asignaciones = preparar_solicitud_auto(
                page, anio=anio, mes=mes, procesar=procesar, debug_dir=debug_dir)
        except DevolucionScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)

        if not asignaciones:
            click.secho(f"[OK] No hay facturas elegibles en {mes:02d}/{anio}.", fg="yellow")
            browser.close()
            return

        total = sum(a["iva"] for a in asignaciones)
        click.secho(f"[OK] {len(asignaciones)} factura(s) auto-completada(s) — IVA total {round(total, 2)}:", fg="green")
        for a in asignaciones:
            click.echo(f"  #{a['numero']:>2}  {(a['razon_social'] or '')[:32]:32}  "
                       f"IVA={a['iva']:.2f}  -> {a['tipo_gasto']}")
        click.secho("  OJO: el tipo de gasto es best-effort. REVISALO antes de enviar.", fg="yellow")
        if procesar:
            click.secho("  Borrador procesado en el SRI. Falta 'Envío de solicitud' (lo hacés vos).", fg="cyan")

        if not headless:
            click.echo("\n  Dejé el navegador ABIERTO. Revisá los tipos de gasto, y si estás de")
            click.echo("  acuerdo hacé 'Procesar facturas seleccionadas' y 'Envío de solicitud'.")
            click.echo("  Presioná Enter acá para cerrar el navegador...")
            try:
                input()
            except EOFError:
                pass
        browser.close()
    click.secho("[OK] Listo.", fg="green")


@cmd_devoluciones.command("lista")
@click.option("--anio", type=int, default=None, help="Año a solicitar (si se omite, se pregunta).")
@click.option("--mes", type=int, default=None, help="Mes a solicitar (si se omite, se pregunta).")
@click.option("--procesar", is_flag=True, default=False,
              help="Guarda el borrador en el SRI. NO presenta.")
def cmd_devoluciones_lista(anio, mes, procesar):
    """Menú: lista TODAS las personas de clientes.local.json y, al elegir una,
    abre el SRI logueado y auto-completa su Devolución del período.

    Marcá en clientes.local.json quién hace devolución agregando "devolucion": true
    a esa persona (opcional): se muestra con la etiqueta (devolución) en la lista.
    """
    try:
        clientes = cargar_clientes()
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    disponibles = [c for c in clientes if c.get("clave")]
    if not disponibles:
        click.secho("[ERR] No hay personas con clave en clientes.local.json", fg="red")
        sys.exit(1)
    # Si hay marcadas con "devolucion": true, mostrar primero esas.
    disponibles.sort(key=lambda c: (not c.get("devolucion"), (c.get("alias") or "")))

    click.secho("Personas disponibles para Devolución de IVA (adultos mayores):", fg="cyan")
    for i, c in enumerate(disponibles, 1):
        marca = click.style("  (devolución)", fg="green") if c.get("devolucion") else ""
        click.echo(f"  {i:>2}. {str(c.get('ruc','')):15} {c.get('alias', '')}{marca}")

    idx = click.prompt("\nElegí el número de la persona", type=int)
    if not 1 <= idx <= len(disponibles):
        click.secho("[ERR] Número fuera de rango.", fg="red")
        sys.exit(1)
    cliente = disponibles[idx - 1]

    if anio is None:
        anio = click.prompt("Año a solicitar", type=int)
    if mes is None:
        mes = click.prompt("Mes a solicitar (1-12)", type=int)
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)

    click.secho(f"\n-> {cliente.get('alias', '')} — Devolución {mes:02d}/{anio}", fg="cyan")
    _preparar_devolucion(cliente["ruc"], cliente, anio, mes, procesar, headless=False)


@cmd_devoluciones.command("enviar")
@click.option("--ruc", required=True, help="RUC del cliente (debe estar en clientes.local.json).")
@click.option("--anio", required=True, type=int, help="Año a solicitar (2022-2026).")
@click.option("--mes", required=True, type=int, help="Mes a solicitar (1-12).")
@click.option("--confirmar", is_flag=True, default=False,
              help="PRESENTA de verdad (IRREVERSIBLE, responsabilidad legal). Sin este flag, "
                   "prepara y guarda todo y FRENA en la pantalla de envío.")
@click.option("--headless/--no-headless", default=False, show_default=True)
def cmd_devoluciones_enviar(ruc, anio, mes, confirmar, headless):
    """Flujo COMPLETO de Devolución: auto-completa (marcar+IVA+tipo de gasto), guarda
    la selección y llega a 'Envío de solicitud'. Con --confirmar además PRESENTA
    ('Cargar Información').

    OJO: presentar es un trámite legal IRREVERSIBLE — el SRI advierte pena de 5 a 7
    años por devolución indebida, y el tipo de gasto es best-effort. Sin --confirmar,
    deja todo listo y el navegador abierto para que revises y presiones vos.
    """
    if not 1 <= mes <= 12:
        click.secho("[ERR] --mes debe estar entre 1 y 12.", fg="red")
        sys.exit(1)
    try:
        cliente = buscar_cliente(ruc)
    except (FileNotFoundError, ValueError) as e:
        click.secho(f"[ERR] {e}", fg="red")
        sys.exit(1)
    if not cliente or not cliente.get("clave"):
        click.secho(f"[ERR] RUC {ruc} no está (o no tiene clave) en clientes.local.json", fg="red")
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
        from core.sri_login import LoginError, login
        from core.devoluciones import DevolucionScrapeError, enviar_solicitud_auto
    except ImportError:
        click.secho("[ERR] Playwright no está instalado (pip install -r requirements.txt).", fg="red")
        sys.exit(1)

    debug_dir = BASE_DIR / "debug" / ruc
    click.echo(f"-> Login SRI para {ruc} ({cliente.get('alias', '')})...")
    with sync_playwright() as pw:
        try:
            browser, _c, page = login(pw, ruc, cliente["clave"], headless=headless, debug_dir=debug_dir)
        except LoginError as e:
            click.secho(f"[ERR] Login falló: {e}", fg="red")
            sys.exit(1)
        try:
            click.echo(f"-> Preparando y guardando {mes:02d}/{anio}...")
            res = enviar_solicitud_auto(page, anio=anio, mes=mes, confirmar=confirmar, debug_dir=debug_dir)
        except DevolucionScrapeError as e:
            click.secho(f"[ERR] {e}", fg="red")
            browser.close()
            sys.exit(1)

        if res.get("motivo") == "sin_facturas":
            click.secho(f"[OK] No hay facturas elegibles en {mes:02d}/{anio}.", fg="yellow")
            browser.close()
            return

        total = res.get("total_iva")
        n = len(res.get("asignaciones") or [])
        if confirmar and res.get("ok"):
            click.secho(f"[OK] PRESENTADA la devolución {mes:02d}/{anio}: {n} comprobantes, IVA {total}.", fg="green")
            if res.get("mensaje"):
                click.echo(f"  SRI: {res['mensaje'][:300]}")
        else:
            click.secho(f"[OK] Listo para presentar: {n} comprobantes, IVA {total}. NO presenté (falta --confirmar).", fg="yellow")
            click.secho("  Advertencia del SRI: devolución indebida = defraudación (pena 5-7 años). Revisá el tipo de gasto.", fg="yellow")
            if not headless:
                click.echo("\n  Navegador ABIERTO en la pantalla de 'Envío de solicitud'. Si estás de")
                click.echo("  acuerdo, presioná 'Cargar Información' para presentar. Enter acá para cerrar...")
                try:
                    input()
                except EOFError:
                    pass
        browser.close()
    click.secho("[OK] Listo.", fg="green")


if __name__ == "__main__":
    cli()
