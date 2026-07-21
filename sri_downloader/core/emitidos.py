"""Scraper de Comprobantes Electrónicos EMITIDOS (ventas del contribuyente).

Espejo de core.comprobantes (recibidos): tras el login (core.sri_login), navega
a la consulta de comprobantes EMITIDOS del SRI, filtra por período (año/mes) y
tipo de comprobante, y descarga el "listado" TXT que el propio portal genera. Ese
TXT trae la CLAVE_ACCESO de cada comprobante — exactamente el formato que el
backend ya acepta en POST /api/sales-iva/process-txt (el backend baja los XML por
SOAP con esas claves y los guarda como ingresos/ventas).

Dos modos:
  · descargar_listado_emitidos()        → un listado del MES entero (día 'Todos').
  · descargar_emitidos_dia_por_dia()     → recorre el mes DÍA POR DÍA y acumula
    todas las claves en un TXT (recomendado: el listado 'Todos' del SRI suele
    topar la cantidad de resultados; día por día baja el total completo).

La página es JSF/PrimeFaces, misma app que recibidos; los IDs de los controles
son, POR ANALOGÍA con recibidos, frmPrincipal:ano / :mes / :dia /
:cmbTipoComprobante / btnConsultar / lnkTxtlistado.

IMPORTANTE — SELECTORES TENTATIVOS: sin acceso vivo al SRI (claves locales
desactualizadas) no se pudo confirmar contra el portal real la URL exacta del
.jsf de emitidos ni los IDs del form, que pueden diferir de recibidos (emitidos
a veces exige un paso extra tipo "Generar reporte" antes de mostrar el link TXT).
Por eso cada selector tiene varios fallbacks y, ante cualquier falla, se guarda
screenshot + HTML en debug/<RUC>/emitidos_error.* para ajustar EMITIDOS_URL y los
id$='...' reales del form JSF de emitidos.
"""
from __future__ import annotations

import calendar
import re
import sys
import time
from pathlib import Path
from typing import Callable, Optional

from playwright.sync_api import Page, TimeoutError as PWTimeoutError

# TENTATIVO: confirmar contra el portal real. Por analogía con RECIBIDOS_URL,
# el submenú "Comprobantes electrónicos > Emitidos" del SRI en Línea.
EMITIDOS_URL = (
    "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/"
    "pages/consultas/emitidos/comprobantesEmitidos.jsf"
)

# Valores del combo "Tipo de comprobante" del portal (idénticos a recibidos).
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
        f"Probablemente el form del SRI (emitidos) cambió o difiere de recibidos."
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


# --- Helpers compartidos (mes completo y día por día) -----------------------

def _abrir_emitidos(page: Page) -> None:
    """Navega a la consulta de Emitidos y valida que la sesión siga activa."""
    page.goto(EMITIDOS_URL, wait_until="domcontentloaded")
    if "auth/realms" in page.url:
        raise ScrapeError(
            "El portal pidió login de nuevo al entrar a Comprobantes Emitidos. "
            "Reintentá: el login se renueva en el próximo comando."
        )
    page.wait_for_load_state("networkidle", timeout=20_000)


def _fijar_filtros(page: Page, anio: int, mes: int, dia_valor: Optional[str], tipo_valor: Optional[str]) -> None:
    """Fija año, mes, día (opcional) y tipo. dia_valor '0' = mes entero ('Todos');
    '1'..'31' = un día concreto. Si el combo usa día con cero a la izquierda, se
    reintenta con ese formato."""
    _select_first(page, ["select#frmPrincipal\\:ano", "select[id$='ano']"], str(anio), label="año")
    time.sleep(0.5)  # JSF re-renderea los combos dependientes
    _select_first(page, ["select#frmPrincipal\\:mes", "select[id$='mes']"], str(mes), label="mes")
    time.sleep(0.5)
    if dia_valor is not None:
        dia_sels = ["select#frmPrincipal\\:dia", "select[id$='dia']"]
        try:
            _select_first(page, dia_sels, dia_valor, label="día")
        except ScrapeError:
            # El combo puede usar días con cero a la izquierda ('01'..'09'), o no
            # existir para ese período (algunos meses no muestran día): 'Todos' = 0
            # es el default, así que sólo reintentamos con zfill para días concretos.
            if dia_valor not in ("0", "00") and len(dia_valor) == 1:
                _select_first(page, dia_sels, dia_valor.zfill(2), label="día")
            elif dia_valor in ("0", "00"):
                pass  # sin combo de día → ya viene en 'Todos'
            else:
                raise
    time.sleep(0.3)
    if tipo_valor:
        # En emitidos el combo de tipo puede no existir; si no aparece seguimos.
        try:
            _select_first(
                page,
                ["select#frmPrincipal\\:cmbTipoComprobante", "select[id$='cmbTipoComprobante']"],
                tipo_valor,
                label="tipo de comprobante",
            )
        except ScrapeError:
            pass


def _click_consultar(page: Page) -> None:
    boton = None
    for sel in ["#frmPrincipal\\:btnConsultar", "input[id$='btnConsultar']", "button:has-text('Consultar')"]:
        if page.locator(sel).count():
            boton = sel
            break
    if not boton:
        raise ScrapeError("No encontré el botón Consultar (emitidos).")
    page.click(boton)
    page.wait_for_load_state("networkidle", timeout=30_000)


def _hay_datos(page: Page) -> bool:
    cuerpo = page.content().lower()
    return not ("no existen datos" in cuerpo or "no se encontraron" in cuerpo)


def _descargar_listado(page: Page, destino: Path) -> Path:
    """Descarga el TXT del listado/reporte de la consulta actual a `destino`."""
    link = None
    for sel in [
        "#frmPrincipal\\:lnkTxtlistado",
        "a[id$='lnkTxtlistado']",
        "a:has-text('Listado')",
        "a[title*='istado']",
        "a:has-text('reporte')",
        "a[title*='eporte']",
    ]:
        if page.locator(sel).count():
            link = sel
            break
    if not link:
        raise ScrapeError("Consulté el período pero no encontré el link del listado/reporte TXT (emitidos).")
    destino.parent.mkdir(parents=True, exist_ok=True)
    with page.expect_download(timeout=60_000) as dl_info:
        page.click(link)
    dl_info.value.save_as(str(destino))
    return destino


def _claves_de_txt(ruta: Path) -> list[str]:
    """Claves de acceso (49 dígitos) presentes en un TXT del portal."""
    try:
        return re.findall(r"\d{49}", ruta.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []


def descargar_listado_emitidos(
    page: Page,
    *,
    anio: int,
    mes: int,
    tipo: str = "factura",
    destino: Path,
    debug_dir: Optional[Path] = None,
) -> Path:
    """Descarga el listado TXT de comprobantes EMITIDOS (ventas) del período.

    Requiere una `page` ya autenticada (login() de core.sri_login).
    Devuelve la ruta del TXT guardado en `destino`.
    """
    tipo_valor = TIPOS_COMPROBANTE.get(tipo)
    if not tipo_valor:
        raise ScrapeError(f"Tipo inválido: {tipo}. Válidos: {sorted(TIPOS_COMPROBANTE)}")

    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    try:
        _abrir_emitidos(page)
        # Día en "Todos" (0) para traer el mes entero.
        _fijar_filtros(page, anio, mes, "0", tipo_valor)
        _click_consultar(page)
        if not _hay_datos(page):
            raise ScrapeError(
                f"El SRI no reporta comprobantes emitidos ({tipo}) para {mes:02d}/{anio}."
            )
        return _descargar_listado(page, destino)
    except ScrapeError:
        _dump_debug(page, debug_dir, "emitidos_error")
        raise
    except PWTimeoutError as e:
        _dump_debug(page, debug_dir, "emitidos_timeout")
        raise ScrapeError(f"Timeout esperando al portal del SRI (emitidos): {e}") from e


def descargar_emitidos_dia_por_dia(
    page: Page,
    *,
    anio: int,
    mes: int,
    tipo: str = "factura",
    destino: Path,
    debug_dir: Optional[Path] = None,
    progreso: Optional[Callable[[int, int, int, str], None]] = None,
) -> dict:
    """Recorre el mes DÍA POR DÍA y acumula TODAS las claves de acceso de los
    comprobantes emitidos en un único TXT (`destino`), sin duplicados.

    Por qué día por día: la consulta de Emitidos del SRI, con el día en "Todos",
    suele TOPAR la cantidad de resultados del listado; consultando cada día se
    baja el total completo. Un día sin datos se salta; un día que falle no aborta
    el resto (se guarda debug y se continúa). Si el PRIMER día falla por estructura
    (form/URL cambiada), sí se aborta para que revises el debug y ajustemos los
    selectores.

    `progreso(dia, total_dias, claves_nuevas, estado)` se llama tras cada día
    ('ok' | 'sin datos' | 'error: ...' | 'timeout') para informar avance.
    Requiere una `page` ya autenticada. Devuelve stats {total_claves, dias_con_datos,
    dias_sin_datos, dias_con_error, destino}.
    """
    tipo_valor = TIPOS_COMPROBANTE.get(tipo)
    if not tipo_valor:
        raise ScrapeError(f"Tipo inválido: {tipo}. Válidos: {sorted(TIPOS_COMPROBANTE)}")

    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    n_dias = calendar.monthrange(anio, mes)[1]
    claves: dict[str, bool] = {}   # dedup conservando el orden de aparición
    dias_con = dias_sin = dias_err = 0
    tmp_dir = destino.parent / "_tmp_emitidos"

    for dia in range(1, n_dias + 1):
        try:
            # Re-navegar cada día da una vista/ViewState JSF fresca (más robusto
            # que reusar el form tras muchos postbacks).
            _abrir_emitidos(page)
            _fijar_filtros(page, anio, mes, str(dia), tipo_valor)
            _click_consultar(page)
            if not _hay_datos(page):
                dias_sin += 1
                if progreso:
                    progreso(dia, n_dias, 0, "sin datos")
                continue
            tmp = tmp_dir / f"dia_{dia:02d}.txt"
            _descargar_listado(page, tmp)
            nuevas = 0
            for c in _claves_de_txt(tmp):
                if c not in claves:
                    claves[c] = True
                    nuevas += 1
            dias_con += 1
            if progreso:
                progreso(dia, n_dias, nuevas, "ok")
        except ScrapeError as e:
            _dump_debug(page, debug_dir, f"emitidos_error_dia_{dia:02d}")
            # Si el PRIMER día falla por estructura y no hay nada aún, es casi
            # seguro que el form/URL de emitidos no es el correcto → abortar.
            if dia == 1 and not claves:
                raise
            dias_err += 1
            if progreso:
                progreso(dia, n_dias, 0, f"error: {e}")
            continue
        except PWTimeoutError:
            _dump_debug(page, debug_dir, f"emitidos_timeout_dia_{dia:02d}")
            dias_err += 1
            if progreso:
                progreso(dia, n_dias, 0, "timeout")
            continue

    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text("\n".join(claves.keys()) + ("\n" if claves else ""), encoding="utf-8")
    # Limpieza de temporales por día.
    try:
        for f in tmp_dir.glob("*.txt"):
            f.unlink()
        tmp_dir.rmdir()
    except Exception:
        pass

    return {
        "total_claves": len(claves),
        "dias_con_datos": dias_con,
        "dias_sin_datos": dias_sin,
        "dias_con_error": dias_err,
        "destino": destino,
    }
