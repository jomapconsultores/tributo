"""CLI del descargador del SRI.

Comandos:
  python descargar.py init          Crea clientes.local.json desde el template.
  python descargar.py list          Lista los clientes configurados.
  python descargar.py test-login --ruc XXX
                                    Prueba el login Keycloak de un cliente.
                                    Por defecto NO headless: ves el navegador.

Iteración 1: solo login. Las descargas vienen en iteración 2.
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


if __name__ == "__main__":
    cli()
