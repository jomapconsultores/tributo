"""Portal de Devolución de IVA — Adultos mayores (tercera edad) del SRI
(iteración 5 — flujo navegado y confirmado; parseo del grid pendiente de captura).

Portal real (confirmado y probado logueado):
    https://srienlinea.sri.gob.ec/devolucionTerceraEdad-internet/pages/terceraEdad/procesarDTE.jsf

App JSF/PrimeFaces aparte (`devolucionTerceraEdad-internet`) con su PROPIO cliente
OIDC `app-devolucion-iva-tercera-edad-internet`. Aprendizajes de la captura real:

  - Navegar a la URL "pelada" REBOTA a Keycloak y se cuelga. Hay que entrar con la
    URL COMPLETA con params MPT (`FULL_URL`): con la sesión del perfil viva, el SSO
    del cliente de devolución resuelve solo y carga el trámite.
  - Los IDs PrimeFaces son mayormente autogenerados (`j_idt*`) e INESTABLES → se
    maneja por TEXTO/ROL VISIBLE. Excepción: el panel de facturas usa IDs estables
    (`frmPanelFacturacionElectronicaTerceraEdad:cmbAnio/:cmbPeriodo`).

Wizard real (confirmado paso a paso contra el portal):
    A) INTRO / confirmación de ciudad → botón "Aceptar".
    B) CONVENIO DE DÉBITO: tabla `frmConvenioDebito:tblConvenios` con la cuenta
       bancaria; se marca su radio (.ui-radiobutton-box) y "Aceptar".
    C) HUB con dos accesos: "Ingresar facturas electrónicas" y "Envío de solicitud".
    D) INGRESAR FACTURAS: combos `cmbAnio` (2022..2026) y `cmbPeriodo` (enero..
       diciembre, se puebla por ajax al elegir año) + botón "Buscar" → grid de
       facturas elegibles.
    E) GRID: marcar comprobantes + fijar valor a solicitar + tipo de gasto.
    F) "Envío de solicitud" → PRESENTAR (trámite legal).

ALCANCE Y SEGURIDAD (importante)
--------------------------------
`navegar_a_facturas` llega hasta el grid (paso E) — es SOLO consulta, no presenta
nada. `leer_detalle` parsea ese grid: PENDIENTE de una captura con datos (la
estructura del grid — checkbox/valor/tipo de gasto por fila — se confirma con un
período que tenga facturas). `presentar_solicitud` está BLOQUEADA salvo que se
pase `confirmar=True` explícito: la presentación es un trámite legal irreversible
y no se dispara sin confirmación manual del usuario.
"""
from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from playwright.sync_api import Page, TimeoutError as PWTimeoutError

FULL_URL = (
    "https://srienlinea.sri.gob.ec/devolucionTerceraEdad-internet/pages/terceraEdad/procesarDTE.jsf"
    "?&contextoMPT=https://srienlinea.sri.gob.ec/tuportal-internet"
    "&pathMPT=Devoluciones%20(TAX%20refund)"
    "&actualMPT=Devoluci%F3n%20de%20IVA%20-%20Adultos%20mayores%20"
    "&linkMPT=%2FdevolucionTerceraEdad-internet%2Fpages%2FterceraEdad%2FprocesarDTE.jsf%3F"
    "&esFavorito=S"
)
APP_MARCADOR = "devolucionTerceraEdad-internet"
DEFAULT_TIMEOUT_MS = 30_000

# ID base (form) del panel de ingreso de facturas — IDs estables (no j_idt).
PANEL_FACTURAS = "frmPanelFacturacionElectronicaTerceraEdad"
RADIO_CONVENIO = '[id="frmConvenioDebito:tblConvenios_data"] .ui-radiobutton-box'

# El combo de período usa NOMBRES de mes, no números.
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
         "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]

# Grid de facturas (paso E). IDs estables confirmados contra el portal real.
TBL_FACTURAS = f"{PANEL_FACTURAS}:tblFacturas"
# Combo "Tipo de gasto" por fila: etiqueta visible -> value del <option>.
TIPO_GASTO_VALORES = {
    "alimentación": "4", "educación": "5", "salud": "3",
    "vestimenta": "1", "vivienda": "2",
}

MAPA_ESTADO_SRI: dict[str, str] = {}


def _num(txt) -> Optional[float]:
    """'4,73' | '4.73' | '' -> float | None."""
    if txt is None:
        return None
    s = str(txt).strip().replace(".", "").replace(",", ".") if "," in str(txt) else str(txt).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


class DevolucionScrapeError(Exception):
    """Falla esperable del scraper de Devolución de IVA."""


class DevolucionNoDisponible(DevolucionScrapeError):
    """El paso pedido aún no está implementado (falta capturar su DOM)."""


@dataclass
class FacturaDevolucion:
    """Una fila del grid de facturas elegibles (paso E).

    El grid del SRI NO expone la clave de acceso en texto; el comprobante se
    identifica por `comprobante` (tipo y serie, ej. 'Factura - 001-011-005061393')
    + fecha + razón social. `monto_iva` es el IVA del comprobante; `iva_solicitado`
    es lo que se pide (input, deshabilitado hasta marcar la fila)."""
    row_index: int
    numero: str
    razon_social: str
    comprobante: str
    fecha: str
    monto_iva: Optional[float]
    iva_solicitado: Optional[float] = None
    tipo_gasto: Optional[str] = None


def _dump_debug(page: Page, debug_dir: Optional[Path], nombre: str) -> None:
    if not debug_dir:
        return
    debug_dir.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(debug_dir / f"{nombre}.png"), full_page=True)
        (debug_dir / f"{nombre}.html").write_text(page.content(), encoding="utf-8")
        print(f"[debug] Guardado {nombre}.png/.html en {debug_dir}", file=sys.stderr)
    except Exception:
        pass


def _click_visible(page: Page, texto: str, *, timeout_ms: int = 6_000) -> bool:
    """Clic en el PRIMER control VISIBLE cuyo texto/valor contenga `texto`.
    PrimeFaces deja botones homónimos en diálogos ocultos: se filtra por
    visibilidad (los IDs son autogenerados e inestables)."""
    loc = page.locator(
        f"button:has-text('{texto}'), a:has-text('{texto}'), input[value*='{texto}']"
    )
    for i in range(loc.count()):
        b = loc.nth(i)
        try:
            if b.is_visible():
                b.click(timeout=timeout_ms)
                return True
        except Exception:
            continue
    return False


def _pf_select(page: Page, base_id: str, texto: str) -> None:
    """Selecciona por texto en un PrimeFaces selectOneMenu (abre panel + click item)."""
    page.locator(f'[id="{base_id}"]').click(timeout=10_000)
    time.sleep(0.6)
    page.locator(f'[id="{base_id}_panel"] li:has-text("{texto}")').first.click(timeout=10_000)
    time.sleep(0.4)


def _idle(page: Page, timeout_ms: int = 20_000) -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=timeout_ms)
    except PWTimeoutError:
        pass


def abrir_tramite(page: Page, *, debug_dir: Optional[Path] = None) -> None:
    """Abre el trámite con la sesión del perfil ya activa (core.sri_login.login()).
    Entra con la URL MPT completa y espera aterrizar DENTRO de la app (no Keycloak)."""
    page.set_default_timeout(DEFAULT_TIMEOUT_MS)
    try:
        page.goto(FULL_URL, wait_until="commit", timeout=90_000)
    except PWTimeoutError as e:
        _dump_debug(page, debug_dir, "devolucion_goto_timeout")
        raise DevolucionScrapeError(f"Timeout abriendo el trámite de Devolución de IVA: {e}") from e

    for _ in range(40):
        url = page.url
        if APP_MARCADOR in url and "auth/realms" not in url:
            break
        time.sleep(1)
    else:
        _dump_debug(page, debug_dir, "devolucion_no_entro")
        raise DevolucionScrapeError(
            "No entré al trámite de Devolución de IVA (¿la app pidió login de nuevo?). "
            "Reintentá; el login del perfil se renueva en el próximo comando."
        )
    _idle(page)


def _paso_intro_y_convenio(page: Page, *, debug_dir: Optional[Path] = None) -> None:
    """Pasos A y B: acepta la intro, marca la cuenta bancaria y acepta el convenio.
    NO presenta nada: solo avanza el wizard hasta el hub (paso C)."""
    if not _click_visible(page, "Aceptar"):
        _dump_debug(page, debug_dir, "devolucion_sin_aceptar_A")
        raise DevolucionScrapeError("No encontré el botón 'Aceptar' de la intro (paso A).")
    _idle(page)
    time.sleep(1.5)

    try:
        page.locator(RADIO_CONVENIO).first.click(timeout=10_000)
    except Exception as e:
        _dump_debug(page, debug_dir, "devolucion_sin_radio_B")
        raise DevolucionScrapeError(
            "No pude marcar la cuenta bancaria del convenio de débito (paso B). "
            "¿El contribuyente no tiene cuenta registrada en el SRI?"
        ) from e
    time.sleep(0.5)
    if not _click_visible(page, "Aceptar"):
        raise DevolucionScrapeError("No encontré el botón 'Aceptar' del convenio (paso B).")
    _idle(page, 25_000)
    time.sleep(2)


def navegar_a_facturas(
    page: Page,
    *,
    anio: int,
    mes: int,
    debug_dir: Optional[Path] = None,
) -> None:
    """Deja la `page` en el GRID de facturas elegibles del período (paso E).

    Camina A(intro) → B(convenio) → C(hub) → D(combos año/mes + Buscar). Es SOLO
    consulta: no marca comprobantes ni presenta nada. Requiere `page` autenticada.
    """
    if not 1 <= mes <= 12:
        raise DevolucionScrapeError("mes debe estar entre 1 y 12.")
    abrir_tramite(page, debug_dir=debug_dir)
    _paso_intro_y_convenio(page, debug_dir=debug_dir)

    if not _click_visible(page, "Ingresar facturas electr"):
        _dump_debug(page, debug_dir, "devolucion_sin_hub_C")
        raise DevolucionScrapeError("No encontré 'Ingresar facturas electrónicas' (paso C).")
    _idle(page, 25_000)
    time.sleep(2)

    _pf_select(page, f"{PANEL_FACTURAS}:cmbAnio", str(anio))
    _idle(page, 15_000)
    time.sleep(1)
    _pf_select(page, f"{PANEL_FACTURAS}:cmbPeriodo", MESES[mes - 1])
    time.sleep(0.4)
    if not _click_visible(page, "Buscar"):
        raise DevolucionScrapeError("No encontré el botón 'Buscar' (paso D).")
    _idle(page, 25_000)
    time.sleep(2)
    _dump_debug(page, debug_dir, f"devolucion_grid_{anio}-{mes:02d}")


_GRID_JS = """() => {
  const body = document.querySelector('[id="__TBL__"] .ui-datatable-data');
  if (!body) return [];
  return [...body.querySelectorAll('tr')].map((tr, idx) => {
    const td = tr.querySelectorAll('td');
    if (td.length < 6) return null;
    const g = i => (td[i] ? td[i].innerText : '').trim().replace(/\\s+/g, ' ');
    const ivaInput = tr.querySelector('input[id$=":txtIvaSolicitado"]');
    const tipoSel = tr.querySelector('select[id$=":cmbTipoGasto_input"]');
    return {
      row_index: idx, numero: g(0), razon_social: g(2), comprobante: g(3),
      fecha: g(4), monto_iva: g(5),
      iva_solicitado: ivaInput ? ivaInput.value : '',
      tipo_gasto: (tipoSel && tipoSel.selectedIndex > 0) ? tipoSel.options[tipoSel.selectedIndex].text.trim() : ''
    };
  }).filter(Boolean);
}"""


def leer_detalle(
    page: Page,
    *,
    anio: int,
    mes: int,
    debug_dir: Optional[Path] = None,
) -> list[FacturaDevolucion]:
    """Lee las facturas elegibles del período desde el grid (paso E). READ-ONLY:
    navega hasta el grid y lo parsea sin marcar ni presentar nada."""
    navegar_a_facturas(page, anio=anio, mes=mes, debug_dir=debug_dir)
    filas = page.evaluate(_GRID_JS.replace("__TBL__", TBL_FACTURAS))
    return [
        FacturaDevolucion(
            row_index=f["row_index"], numero=f["numero"], razon_social=f["razon_social"],
            comprobante=f["comprobante"], fecha=f["fecha"], monto_iva=_num(f["monto_iva"]),
            iva_solicitado=_num(f["iva_solicitado"]), tipo_gasto=(f["tipo_gasto"] or None),
        )
        for f in filas
    ]


def marcar_factura(
    page: Page,
    row_index: int,
    *,
    iva_solicitado: float,
    tipo_gasto: str,
) -> None:
    """Marca una fila del grid, fija el IVA solicitado y el tipo de gasto.

    `tipo_gasto`: etiqueta ('alimentación'|'educación'|'salud'|'vestimenta'|
    'vivienda' — ver TIPO_GASTO_VALORES). El input de valor está deshabilitado
    hasta marcar el checkbox 'Seleccionar' (por eso se marca primero)."""
    if tipo_gasto not in TIPO_GASTO_VALORES:
        raise DevolucionScrapeError(
            f"tipo_gasto inválido: {tipo_gasto!r}. Válidos: {sorted(TIPO_GASTO_VALORES)}")
    fila = page.locator(f'[id="{TBL_FACTURAS}"] .ui-datatable-data tr').nth(row_index)
    # 1) checkbox 'Seleccionar' (habilita el input de valor).
    fila.locator(".ui-chkbox-box").first.click(timeout=8_000)
    time.sleep(0.3)
    # 2) IVA solicitado (2 decimales, como exige el onkeydown del portal).
    page.locator(f'[id="{TBL_FACTURAS}:{row_index}:txtIvaSolicitado"]').fill(f"{float(iva_solicitado):.2f}")
    # 3) tipo de gasto (selectOneMenu por texto).
    _pf_select(page, f"{TBL_FACTURAS}:{row_index}:cmbTipoGasto", tipo_gasto)
    time.sleep(0.2)


def procesar_seleccionadas(page: Page, *, debug_dir: Optional[Path] = None) -> None:
    """Click en 'Procesar facturas seleccionadas' (arma la solicitud con lo
    marcado). NO es el envío final: eso es 'Envío de solicitud' (paso F)."""
    if not _click_visible(page, "Procesar facturas seleccionadas"):
        raise DevolucionScrapeError("No encontré 'Procesar facturas seleccionadas'.")
    _idle(page, 25_000)
    time.sleep(2)
    _dump_debug(page, debug_dir, "devolucion_procesada")


def preparar_solicitud(
    page: Page,
    *,
    anio: int,
    mes: int,
    selecciones: list[dict],
    procesar: bool = False,
    debug_dir: Optional[Path] = None,
) -> None:
    """Navega al grid del período y marca/llena las facturas indicadas.

    `selecciones`: lista de {row_index, iva_solicitado, tipo_gasto}. Con
    `procesar=True` hace click en 'Procesar facturas seleccionadas' (arma la
    solicitud en BORRADOR; NO la presenta). El ENVÍO final queda en
    presentar_solicitud, que sigue bloqueada."""
    navegar_a_facturas(page, anio=anio, mes=mes, debug_dir=debug_dir)
    for s in selecciones:
        marcar_factura(page, s["row_index"],
                       iva_solicitado=s["iva_solicitado"], tipo_gasto=s["tipo_gasto"])
    _dump_debug(page, debug_dir, f"devolucion_preparada_{anio}-{mes:02d}")
    if procesar:
        procesar_seleccionadas(page, debug_dir=debug_dir)


# Heurístico de tipo de gasto por palabras en la razón social del proveedor.
# Es BEST-EFFORT y ajustable: el orden importa (primer match gana). El default
# para lo no reconocido es "alimentación" (lo más común en primera necesidad).
# Ajustá estas listas con los proveedores reales de tus contribuyentes.
_HEURISTICA_GASTO = [
    ("salud", ["farmacia", "fybeca", "sana sana", "cruz azul", "pharmacy", "medic",
               "clinic", "hospital", "laboratorio", "optic", "dental", "salud"]),
    ("educación", ["colegio", "universidad", "educ", "libreria", "librería", "papeleria",
                   "papelería", "instituto", "academia"]),
    ("vestimenta", ["leonisa", "etafashion", "de prati", "boutique", "calzado", "moda",
                    "textil", "confeccion", "confección", "ropa", "zapat"]),
    ("vivienda", ["ferreteria", "ferretería", "construc", "inmobiliaria", "arriendo",
                  "electrodom", "mueble", "hogar", "amc", "sukasa"]),
    ("alimentación", ["favorita", "supermaxi", "megamaxi", "aki", " tia", "mi comisariato",
                      "santa maria", "santa maría", "coral", "gran aki", "market", "panaderia",
                      "panadería", "alimento", "comisariato"]),
]
_GASTO_DEFAULT = "alimentación"


def clasificar_tipo_gasto(razon_social: str) -> str:
    """Asigna un tipo de gasto del SRI por heurística sobre la razón social.
    Devuelve una etiqueta de TIPO_GASTO_VALORES. Best-effort: revisar antes de enviar."""
    s = (razon_social or "").lower()
    for etiqueta, claves in _HEURISTICA_GASTO:
        if any(k in s for k in claves):
            return etiqueta
    return _GASTO_DEFAULT


def preparar_solicitud_auto(
    page: Page,
    *,
    anio: int,
    mes: int,
    procesar: bool = False,
    debug_dir: Optional[Path] = None,
) -> list[dict]:
    """AUTO: marca TODAS las facturas elegibles del período, pide el IVA COMPLETO
    de cada una y asigna el tipo de gasto por heurística (clasificar_tipo_gasto).

    Devuelve la lista de asignaciones [{numero, razon_social, iva, tipo_gasto}] para
    que el usuario la REVISE. Con procesar=True arma el borrador (no presenta). El
    envío final sigue en presentar_solicitud (bloqueada). Deja el estado volcado en
    debug/ para revisión. OJO: el tipo de gasto es best-effort — verificar antes de
    presentar (trámite legal)."""
    facturas = leer_detalle(page, anio=anio, mes=mes, debug_dir=debug_dir)  # navega + parsea
    asignaciones = []
    for f in facturas:
        tipo = clasificar_tipo_gasto(f.razon_social)
        iva = f.monto_iva or 0.0
        marcar_factura(page, f.row_index, iva_solicitado=iva, tipo_gasto=tipo)
        asignaciones.append({
            "numero": f.numero, "razon_social": f.razon_social,
            "comprobante": f.comprobante, "iva": iva, "tipo_gasto": tipo,
        })
    _dump_debug(page, debug_dir, f"devolucion_auto_{anio}-{mes:02d}")
    if procesar:
        procesar_seleccionadas(page, debug_dir=debug_dir)
    return asignaciones


# Botón que REGISTRA/PRESENTA la solicitud en la pantalla de "Envío de solicitud"
# (confirmado contra el portal real; la pantalla muestra el resumen 'Total
# solicitud realizada' y la advertencia legal de defraudación antes de este botón).
BTN_PRESENTAR = "Cargar Información"


def presentar_solicitud(page: Page, *, confirmar: bool = False, debug_dir: Optional[Path] = None) -> dict:
    """PRESENTA (registra) la solicitud: click en 'Cargar Información' en la
    pantalla de 'Envío de solicitud'. TRÁMITE LEGAL IRREVERSIBLE — el propio SRI
    advierte pena privativa de libertad de 5 a 7 años por devolución indebida.

    Bloqueada salvo `confirmar=True` explícito. Asume que la `page` ya está en la
    pantalla de Envío (con el resumen 'Total solicitud realizada'). Vuelca el antes
    y el después a debug/ y devuelve el mensaje/resultado capturado.

    NOTA: tras 'Cargar Información' el SRI PODRÍA mostrar una confirmación final
    adicional; si aparece, hay que confirmarla (pendiente de ver en el portal). No
    se auto-clickean botones genéricos, para no presentar algo equivocado."""
    if not confirmar:
        raise DevolucionNoDisponible(
            "presentar_solicitud() está bloqueada: es un trámite legal irreversible "
            "(el SRI advierte pena de 5 a 7 años por devolución indebida). Pasá "
            "confirmar=True SOLO con autorización explícita del contribuyente/contador."
        )
    _dump_debug(page, debug_dir, "devolucion_pre_presentar")
    if not _click_visible(page, BTN_PRESENTAR):
        raise DevolucionScrapeError(
            f"No encontré el botón '{BTN_PRESENTAR}' en la pantalla de Envío. "
            "¿La solicitud fue guardada (paso 'Guardar selección realizada')?"
        )
    _idle(page, 25_000)
    time.sleep(2)
    _dump_debug(page, debug_dir, "devolucion_post_presentar")
    mensaje = page.evaluate(
        "() => [...document.querySelectorAll('.ui-growl-item,.ui-messages,.ui-panel-content')]"
        ".filter(e => e.offsetParent).map(e => (e.innerText||'').trim()).join(' | ').slice(0, 500)"
    )
    return {"ok": True, "mensaje": mensaje}


def enviar_solicitud_auto(
    page: Page,
    *,
    anio: int,
    mes: int,
    confirmar: bool = False,
    debug_dir: Optional[Path] = None,
) -> dict:
    """Flujo COMPLETO 100% automático: auto-completa (marcar+IVA+tipo), procesa,
    GUARDA la selección, va a 'Envío de solicitud' y PRESENTA ('Cargar Información').

    `confirmar=True` es OBLIGATORIO para el paso final (legal irreversible). Sin
    confirmar, prepara y guarda todo pero se detiene ANTES de presentar (deja la
    page en la pantalla de Envío, lista para el clic final)."""
    asignaciones = preparar_solicitud_auto(page, anio=anio, mes=mes, procesar=True, debug_dir=debug_dir)
    if not asignaciones:
        return {"ok": False, "motivo": "sin_facturas", "asignaciones": []}

    if not _click_visible(page, "Guardar selecci"):
        raise DevolucionScrapeError("No pude 'Guardar selección realizada'.")
    _idle(page, 20_000)
    time.sleep(2)
    # Tras guardar volvemos al hub; entramos a 'Envío de solicitud'.
    if not _click_visible(page, "Envío de solicitud"):
        raise DevolucionScrapeError("No encontré 'Envío de solicitud' tras guardar la selección.")
    _idle(page, 20_000)
    time.sleep(2)

    total = round(sum(a["iva"] for a in asignaciones), 2)
    if not confirmar:
        _dump_debug(page, debug_dir, "devolucion_lista_para_presentar")
        return {"ok": False, "motivo": "falta_confirmar", "asignaciones": asignaciones, "total_iva": total}

    res = presentar_solicitud(page, confirmar=True, debug_dir=debug_dir)
    res["asignaciones"] = asignaciones
    res["total_iva"] = total
    return res
