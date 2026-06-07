"""Login al SRI vía Keycloak (OpenID Connect).

Estrategia: navegar a la página de Perfil (requiere login) y dejar que el SRI
redirija al Keycloak con sus propios state/nonce. Playwright sigue la cadena
de redirects, llena RUC + clave, y al submit regresa al Perfil.

Selectores cubren variantes conocidas del form de Keycloak del SRI; si la
página cambia, se imprime un screenshot en debug/ para inspección.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional
from playwright.sync_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    TimeoutError as PWTimeoutError,
)

from core.config import dir_state_cliente

PERFIL_URL = "https://srienlinea.sri.gob.ec/sri-en-linea/contribuyente/perfil"
PERFIL_URL_HOST = "srienlinea.sri.gob.ec"

# Selectores Keycloak. El primero que matchee se usa.
USERNAME_SELECTORS = [
    "input#username",
    "input[name='username']",
    "input#usuario",
    "input[name='usuario']",
]
PASSWORD_SELECTORS = [
    "input#password",
    "input[name='password']",
    "input#clave",
    "input[name='clave']",
]
SUBMIT_SELECTORS = [
    "input#kc-login",
    "button[type='submit']",
    "input[type='submit']",
]

DEFAULT_TIMEOUT_MS = 30_000


class LoginError(Exception):
    """Falla esperable de login: clave incorrecta, captcha, SRI caído, etc."""


def _fill_first(page: Page, selectors: list[str], value: str) -> str:
    """Llena el primer selector que aparezca. Devuelve el selector usado."""
    last_err = None
    for sel in selectors:
        try:
            page.wait_for_selector(sel, timeout=4_000, state="visible")
            page.fill(sel, value)
            return sel
        except PWTimeoutError as e:
            last_err = e
            continue
    raise LoginError(
        f"No encontré ningún input que coincida con {selectors}. "
        f"Probablemente el form del SRI cambió."
    ) from last_err


def _click_first(page: Page, selectors: list[str]) -> str:
    last_err = None
    for sel in selectors:
        try:
            page.wait_for_selector(sel, timeout=4_000, state="visible")
            page.click(sel)
            return sel
        except PWTimeoutError as e:
            last_err = e
            continue
    raise LoginError(
        f"No encontré botón de submit ({selectors})."
    ) from last_err


def login(
    pw: Playwright,
    ruc: str,
    clave: str,
    *,
    headless: bool = False,
    debug_dir: Optional[Path] = None,
) -> tuple[Browser, BrowserContext, Page]:
    """Hace login y devuelve (browser, context, page) ya autenticados en perfil.

    El caller es responsable de cerrar el browser cuando termine.

    Args:
        pw: instancia de Playwright sync (sync_playwright().start()).
        ruc: 13 dígitos.
        clave: clave SRI del contribuyente.
        headless: True para producción no asistida. Default False para ver lo que pasa.
        debug_dir: si se pasa, guarda screenshot ante errores.
    """
    state_dir = dir_state_cliente(ruc)
    state_file = state_dir / "storage.json"

    browser = pw.chromium.launch(headless=headless)
    context = browser.new_context(
        storage_state=str(state_file) if state_file.exists() else None,
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/130.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1366, "height": 820},
        locale="es-EC",
    )
    page = context.new_page()
    page.set_default_timeout(DEFAULT_TIMEOUT_MS)

    try:
        page.goto(PERFIL_URL, wait_until="domcontentloaded")

        # Si ya hay sesión válida cargada del storage_state, no aparece el form.
        if PERFIL_URL_HOST in page.url and "auth/realms" not in page.url:
            try:
                page.wait_for_selector("text=Perfil", timeout=5_000)
                _save_state(context, state_file)
                return browser, context, page
            except PWTimeoutError:
                pass

        # Esperar a que Keycloak nos sirva el form de login.
        page.wait_for_url("**/auth/realms/**", timeout=15_000)

        _fill_first(page, USERNAME_SELECTORS, ruc)
        _fill_first(page, PASSWORD_SELECTORS, clave)
        _click_first(page, SUBMIT_SELECTORS)

        # Esperar redirect de vuelta a srienlinea.
        try:
            page.wait_for_url(f"**{PERFIL_URL_HOST}/**", timeout=30_000)
        except PWTimeoutError:
            # Detectar error de clave: Keycloak muestra "Credenciales inválidas".
            body = page.content().lower()
            for marca in ("credenciales", "inválida", "invalido", "incorrect"):
                if marca in body:
                    raise LoginError(
                        "Credenciales rechazadas por el SRI. "
                        "Verificá RUC/clave en clientes.local.json."
                    )
            raise LoginError(
                "Timeout esperando regreso a srienlinea tras submit. "
                "¿Captcha, 2FA inesperado, o SRI caído?"
            )

        # Confirmar que la sesión está activa.
        page.wait_for_load_state("networkidle", timeout=15_000)
        _save_state(context, state_file)
        return browser, context, page

    except LoginError:
        if debug_dir:
            _dump_debug(page, debug_dir)
        browser.close()
        raise
    except Exception as e:
        if debug_dir:
            _dump_debug(page, debug_dir)
        browser.close()
        raise LoginError(f"Error inesperado en login: {e}") from e


def _save_state(context: BrowserContext, state_file: Path) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    context.storage_state(path=str(state_file))


def _dump_debug(page: Page, debug_dir: Path) -> None:
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(debug_dir / "login_error.png"), full_page=True)
        (debug_dir / "login_error.html").write_text(page.content(), encoding="utf-8")
        print(f"[debug] Screenshot y HTML guardados en {debug_dir}", file=sys.stderr)
    except Exception:
        pass
