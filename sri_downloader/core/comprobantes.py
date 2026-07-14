"""Scraper de Comprobantes Electrónicos Recibidos (iteración 2).

Tras el login (core.sri_login), navega a la consulta de comprobantes recibidos
del SRI, filtra por período (año/mes) y tipo de comprobante, y descarga el
"listado" TXT que el propio portal genera. Ese TXT trae la CLAVE_ACCESO de cada
comprobante — exactamente el formato que el backend ya acepta en
POST /api/invoices/process-txt (el backend baja los XML por SOAP con esas claves).

La página es JSF/PrimeFaces; los IDs de los controles son los históricos del
portal (frmPrincipal:ano, frmPrincipal:mes, ...). Si el SRI cambia el form, se
guarda screenshot + HTML en debug/<RUC>/ para ajustar los selectores.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Optional

from playwright.sync_api import Page, TimeoutError as PWTimeoutError

RECIBIDOS_URL = (
    "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/"
    "pages/consultas/recibidos/comprobantesRecibidos.jsf"
)

# Valores del combo "Tipo de comprobante" del portal.
TIPOS_COMPROBANTE = {
    "factura": "1",
    "liquidacion": "2",
    "nota_credito": "3",
    "nota_debito": "4",
    "retencion": "6",
}

DEFAULT_TIMEOUT_MS = 30_000


class ScrapeError(Exception):
    """Falla esperable del scraper: la página cambió, no hay datos, etc."""


def _select_first(page: Page, selectors: list[str], value: str, *, label: str) -> None:
    """Selecciona `value` en el primer <select> que exista de la lista."""
    last_err = None
    for sel in selectors:
        try:
            page.wait_for_selector(sel, timeout=5_000, state="attached")
            page.select_option(sel, value)
            return
        except Exception as e:  # PWTimeoutError o value inexistente
            last_err = e
            continue
    raise ScrapeError(
        f"No pude fijar {label}={value}. Selectores probados: {selectors}. "
        f"Probablemente el form del SRI cambió."
    ) from last_err


def _dump_debug(page: Page, debug_dir: Optional[Path], nombre: str) -> None:
    if not debug_dir:
        return
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(debug_dir / f"{nombre}.png"), full_page=True)
        (debug_dir / f"{nombre}.html").write_text(page.content(), encoding="utf-8")
        print(f"[debug] Screenshot y HTML guardados en {debug_dir}", file=sys.stderr)
    except Exception:
        pass


def descargar_listado_recibidos(
    page: Page,
    *,
    anio: int,
    mes: int,
    tipo: str = "factura",
    destino: Path,
    debug_dir: Optional[Path] = None,
) -> Path:
    """Descarga el listado TXT de comprobantes recibidos del período.

    Requiere una `page` ya autenticada (login() de core.sri_login).
    Devuelve la ruta del TXT guardado en `destino`.
    """
    tipo_valor = TIPOS_COMPROBANTE.get(tipo)
    if not tipo_valor:
        raise ScrapeError(f"Tipo inválido: {tipo}. Válidos: {sorted(TIPOS_COMPROBANTE)}")

    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    try:
        page.goto(RECIBIDOS_URL, wait_until="domcontentloaded")
        # Si la sesión no sirve para esta app, el SRI manda de vuelta a Keycloak.
        if "auth/realms" in page.url:
            raise ScrapeError(
                "El portal pidió login de nuevo al entrar a Comprobantes Recibidos. "
                "Reintentá: el login se renueva en el próximo comando."
            )
        page.wait_for_load_state("networkidle", timeout=20_000)

        # Período y tipo. El día se deja en "Todos" (valor 0) para traer el mes entero.
        _select_first(page, ["select#frmPrincipal\\:ano", "select[id$='ano']"], str(anio), label="año")
        time.sleep(0.5)  # JSF re-renderea los combos dependientes
        _select_first(page, ["select#frmPrincipal\\:mes", "select[id$='mes']"], str(mes), label="mes")
        time.sleep(0.5)
        try:
            _select_first(page, ["select#frmPrincipal\\:dia", "select[id$='dia']"], "0", label="día")
        except ScrapeError:
            pass  # algunos períodos no muestran combo de día; el default ya es "Todos"
        time.sleep(0.3)
        _select_first(
            page,
            ["select#frmPrincipal\\:cmbTipoComprobante", "select[id$='cmbTipoComprobante']"],
            tipo_valor,
            label="tipo de comprobante",
        )

        # Consultar
        boton = None
        for sel in ["#frmPrincipal\\:btnConsultar", "input[id$='btnConsultar']", "button:has-text('Consultar')"]:
            if page.locator(sel).count():
                boton = sel
                break
        if not boton:
            raise ScrapeError("No encontré el botón Consultar.")
        page.click(boton)
        page.wait_for_load_state("networkidle", timeout=30_000)

        # ¿Hubo resultados? El portal muestra un mensaje si no hay datos.
        cuerpo = page.content().lower()
        if "no existen datos" in cuerpo or "no se encontraron" in cuerpo:
            raise ScrapeError(
                f"El SRI no reporta comprobantes ({tipo}) para {mes:02d}/{anio}."
            )

        # Descargar el "listado" (TXT con las claves de acceso).
        link = None
        for sel in [
            "#frmPrincipal\\:lnkTxtlistado",
            "a[id$='lnkTxtlistado']",
            "a:has-text('Listado')",
            "a[title*='istado']",
        ]:
            if page.locator(sel).count():
                link = sel
                break
        if not link:
            raise ScrapeError("Consulté el período pero no encontré el link del listado TXT.")

        destino.parent.mkdir(parents=True, exist_ok=True)
        with page.expect_download(timeout=60_000) as dl_info:
            page.click(link)
        dl_info.value.save_as(str(destino))
        return destino

    except ScrapeError:
        _dump_debug(page, debug_dir, "recibidos_error")
        raise
    except PWTimeoutError as e:
        _dump_debug(page, debug_dir, "recibidos_timeout")
        raise ScrapeError(f"Timeout esperando al portal del SRI: {e}") from e
