"""Scraper de Comprobantes Electrónicos EMITIDOS (ventas / facturas de ingreso).

Tras el login (core.sri_login), navega a la consulta de comprobantes EMITIDOS del
SRI y, para CADA FECHA de emisión (día por día), filtra por estado/tipo, consulta
y extrae las CLAVES DE ACCESO (49 dígitos) de los comprobantes. Acumula todas en
un TXT — el mismo formato que el backend acepta en POST /api/sales-iva/process-txt
(baja los XML por SOAP con esas claves y los guarda como ingresos/ventas).

Form real (confirmado con captura del portal), en:
  https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/pages/consultas/menu.jsf
Campos: RUC (precargado = contribuyente autenticado), "Fecha emisión" (un solo día,
calendario dd/mm/yyyy), "Estado autorización" (Autorizados), "Tipo de comprobante"
(Factura), "Establecimiento" (Todos), "Punto de emisión", botón "Consultar" y
"Descargar reporte". Por eso el modo natural es DÍA POR DÍA: se fija la fecha, se
consulta, se leen las claves, y se avanza al día siguiente.

La página es JSF/PrimeFaces; los IDs exactos del form se afinan leyendo el dump
que la primera corrida guarda en debug/<RUC>/emitidos_form.html y
emitidos_consulta.html. Los selectores de aquí son por etiqueta/atributo con
varios fallbacks para ser robustos ante esos IDs.
"""
from __future__ import annotations

import calendar
import re
import sys
import time
from pathlib import Path
from typing import Callable, Optional

from playwright.sync_api import Page, TimeoutError as PWTimeoutError

EMITIDOS_URL = (
    "https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/"
    "pages/consultas/menu.jsf"
)

# El form de EMITIDOS filtra por "Tipo de comprobante" con la ETIQUETA visible del
# combo (no un valor numérico). Solo 'factura' interesa como ingreso; el resto es
# best-effort (la etiqueta exacta puede variar y se ajusta con el dump del portal).
TIPOS_COMPROBANTE = {
    "factura": "Factura",
    "liquidacion": "Liquidación de compra de bienes y prestación de servicios",
    "nota_credito": "Nota de Crédito",
    "nota_debito": "Nota de Débito",
    "retencion": "Comprobante de Retención",
}

DEFAULT_TIMEOUT_MS = 30_000


class ScrapeError(Exception):
    """Falla esperable del scraper: la página cambió, no hay datos, etc."""


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


def _claves_de_texto(texto: str) -> list[str]:
    """Claves de acceso (49 dígitos) presentes en un texto."""
    return re.findall(r"\d{49}", texto or "")


def _claves_de_archivo(ruta: Path) -> list[str]:
    try:
        return _claves_de_texto(ruta.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return []


# --- Interacción con el form real de EMITIDOS -------------------------------

def _en_login(page: Page) -> bool:
    """True si el portal nos rebotó a la pantalla de login del SRI (Keycloak).

    Chequea URL Y DOM: el rebote OIDC puede llegar DESPUÉS del domcontentloaded,
    dejando page.url en el .jsf original en el instante del goto y aterrizando en
    el login recién al asentarse la navegación. Mirar solo page.url no alcanza —
    por eso una corrida previa guardó la página de login como si fuera el form.
    """
    url = (page.url or "").lower()
    if any(m in url for m in ("auth/realms", "login-actions", "openid-connect/auth")):
        return True
    try:
        html = page.content().lower()
    except Exception:
        return False
    return any(m in html for m in (
        "kc-form-login", "input-datos-login", "sri en línea - login",
    ))


def _ir_a_emitidos(page: Page) -> None:
    page.goto(EMITIDOS_URL, wait_until="domcontentloaded")
    # El rebote a Keycloak puede dispararse después del domcontentloaded, así que
    # dejamos que la navegación se asiente ANTES de decidir si estamos en login.
    try:
        page.wait_for_load_state("networkidle", timeout=20_000)
    except PWTimeoutError:
        pass
    if _en_login(page):
        raise ScrapeError(
            "El portal rebotó al login al entrar a Comprobantes Emitidos: la "
            "sesión del SRI no llegó autenticada a la app de comprobantes. "
            "Rehacé el login (si persiste, borrá state/<RUC>/storage.json)."
        )


def _set_fecha_emision(page: Page, fecha_str: str) -> None:
    """Fija el campo 'Fecha emisión' (calendario PrimeFaces) con dd/mm/yyyy."""
    candidatos = [
        "input[id$='fechaEmision_input']",
        "input[id*='fechaEmision']",
        "input[id*='echaEmision']",
        "span.ui-calendar input",
        ".ui-calendar input",
    ]
    inp = None
    for sel in candidatos:
        loc = page.locator(sel)
        if loc.count():
            inp = loc.first
            break
    if inp is None:  # por proximidad al rótulo 'Fecha emisión'
        loc = page.locator("xpath=//*[contains(normalize-space(text()),'Fecha emisi')]/following::input[1]")
        if loc.count():
            inp = loc.first
    if inp is None:
        raise ScrapeError("No encontré el campo 'Fecha emisión' en el form de emitidos.")
    inp.click()
    try:
        inp.fill(fecha_str)
    except Exception:
        inp.press("Control+a")
        inp.type(fecha_str, delay=20)
    inp.press("Escape")  # cerrar el overlay del datepicker
    time.sleep(0.3)


def _set_combo(page: Page, id_subs: list[str], etiqueta: str, campo: str, *, requerido: bool = True) -> None:
    """Fija un combo por la ETIQUETA visible. Soporta <select> nativo y el
    selectOneMenu de PrimeFaces (div desplegable)."""
    # 1) <select> nativo por id-substring o por su <label for=...>
    for sub in id_subs:
        sel = f"select[id*='{sub}']"
        if page.locator(sel).count():
            try:
                page.select_option(sel, label=etiqueta)
                time.sleep(0.3)
                return
            except Exception:
                pass
    # 2) PrimeFaces selectOneMenu (div): abrir y elegir la opción por texto
    for sub in id_subs:
        cont = page.locator(f"[id*='{sub}']").first
        try:
            if cont.count():
                cont.click()
                page.get_by_role("option", name=etiqueta).first.click()
                time.sleep(0.3)
                return
        except Exception:
            continue
    if requerido:
        raise ScrapeError(f"No pude fijar {campo}='{etiqueta}' (revisá el dump del form de emitidos).")


def _click_consultar(page: Page) -> None:
    for sel in [
        "button:has-text('Consultar')",
        "input[value='Consultar']",
        "[id*='btnConsultar']",
        "a:has-text('Consultar')",
    ]:
        if page.locator(sel).count():
            page.locator(sel).first.click()
            page.wait_for_load_state("networkidle", timeout=30_000)
            return
    raise ScrapeError("No encontré el botón 'Consultar' (emitidos).")


def _sin_resultados(page: Page) -> bool:
    cuerpo = page.content().lower()
    return any(m in cuerpo for m in (
        "no existen datos", "no se encontraron", "no hay resultados", "sin resultados",
        "no se encontraron registros",
    ))


def _descargar_reporte(page: Page, destino: Path) -> Optional[Path]:
    """Click en 'Descargar reporte' y guarda el archivo. None si no hay link."""
    for sel in [
        "a:has-text('Descargar reporte')",
        "a:has-text('Descargar')",
        "[id*='escargarReporte']",
        "[id*='Reporte']",
        "a[title*='eporte']",
    ]:
        if page.locator(sel).count():
            destino.parent.mkdir(parents=True, exist_ok=True)
            try:
                with page.expect_download(timeout=60_000) as dl:
                    page.locator(sel).first.click()
                dl.value.save_as(str(destino))
                return destino
            except Exception:
                return None
    return None


def descargar_emitidos_de_fecha(
    page: Page,
    *,
    fecha_str: str,
    tipo_valor: Optional[str],
    debug_dir: Optional[Path] = None,
    tmp_reporte: Optional[Path] = None,
    dump: bool = False,
) -> set[str]:
    """Consulta los comprobantes emitidos de UNA fecha (dd/mm/yyyy) y devuelve el
    conjunto de claves de acceso encontradas (del grid y del reporte descargable)."""
    _ir_a_emitidos(page)
    if dump:
        _dump_debug(page, debug_dir, "emitidos_form")
    _set_fecha_emision(page, fecha_str)
    _set_combo(page, ["stadoAutorizacion", "estadoAutorizacion", "estado"],
               "Autorizados", "Estado autorización", requerido=False)
    if tipo_valor:
        _set_combo(page, ["ipoComprobante", "tipoComprobante", "tipoDocumento", "comprobante"],
                   tipo_valor, "Tipo de comprobante", requerido=False)
    _click_consultar(page)
    if dump:
        _dump_debug(page, debug_dir, "emitidos_consulta")
    if _sin_resultados(page):
        return set()
    claves = set(_claves_de_texto(page.content()))
    # Complementar con el reporte descargable (trae todos los renglones del día).
    if tmp_reporte is not None:
        r = _descargar_reporte(page, tmp_reporte)
        if r:
            claves |= set(_claves_de_archivo(r))
            try:
                r.unlink()
            except Exception:
                pass
    return claves


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
    """Recorre el mes DÍA POR DÍA (form 'Fecha emisión') y acumula TODAS las claves
    de acceso de los comprobantes emitidos en un único TXT (`destino`), sin
    duplicados. Un día sin datos se salta; un día con error no aborta el resto. Si
    el PRIMER día falla por estructura (form/URL cambiada), sí aborta para revisar
    el dump. La primera fecha vuelca el HTML del form/consulta a debug/ para afinar
    selectores. Requiere `page` ya autenticada.

    `progreso(dia, total_dias, claves_nuevas, estado)` se llama tras cada día.
    Devuelve {total_claves, dias_con_datos, dias_sin_datos, dias_con_error, destino}.
    """
    if tipo not in TIPOS_COMPROBANTE:
        raise ScrapeError(f"Tipo inválido: {tipo}. Válidos: {sorted(TIPOS_COMPROBANTE)}")
    tipo_valor = TIPOS_COMPROBANTE.get(tipo)

    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    n_dias = calendar.monthrange(anio, mes)[1]
    claves: dict[str, bool] = {}   # dedup conservando orden de aparición
    dias_con = dias_sin = dias_err = 0
    tmp_dir = destino.parent / "_tmp_emitidos"

    for dia in range(1, n_dias + 1):
        fecha_str = f"{dia:02d}/{mes:02d}/{anio}"
        try:
            encontradas = descargar_emitidos_de_fecha(
                page, fecha_str=fecha_str, tipo_valor=tipo_valor,
                debug_dir=debug_dir, tmp_reporte=tmp_dir / f"rep_{dia:02d}.bin",
                dump=(dia == 1),
            )
            nuevas = 0
            for c in encontradas:
                if c not in claves:
                    claves[c] = True
                    nuevas += 1
            if encontradas:
                dias_con += 1
                if progreso:
                    progreso(dia, n_dias, nuevas, "ok")
            else:
                dias_sin += 1
                if progreso:
                    progreso(dia, n_dias, 0, "sin datos")
        except ScrapeError as e:
            _dump_debug(page, debug_dir, f"emitidos_error_dia_{dia:02d}")
            if dia == 1 and not claves:
                raise   # estructura mal → abortar para ajustar selectores con el dump
            dias_err += 1
            if progreso:
                progreso(dia, n_dias, 0, f"error: {e}")
        except PWTimeoutError:
            _dump_debug(page, debug_dir, f"emitidos_timeout_dia_{dia:02d}")
            dias_err += 1
            if progreso:
                progreso(dia, n_dias, 0, "timeout")

    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text("\n".join(claves.keys()) + ("\n" if claves else ""), encoding="utf-8")
    try:
        for f in tmp_dir.glob("*"):
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
