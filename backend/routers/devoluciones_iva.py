# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Devolución de IVA — adultos mayores y personas con discapacidad.

Flujo: los comprobantes del período ya están en `invoices` (subidos por TXT/XML
o por el sri_downloader). Aquí el usuario marca cuáles entran a la solicitud,
el sistema calcula el IVA a pedir contra el tope legal mensual, y guarda la
solicitud + snapshot de ítems (tabla devoluciones_iva_solicitudes / _items)
para exportarla a Excel y presentarla al SRI.

Base legal (parámetros abajo, revisar cada enero):
- Adultos mayores (LRTI art. 74): base imponible máxima mensual = 5 RBU.
- Personas con discapacidad (LRTI art. 74 / LOD art. 78): base máxima mensual
  = 2 RBU, proporcional al porcentaje de discapacidad.
"""
import io
import re
import unicodedata
from datetime import datetime, timezone
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client, fetch_all
import orgs
from tenancy import assert_client_owner
from services.periodo import (periodo_cliente_ext, etiqueta_periodo, rango_semestre,
                              semestre_de_mes, mes_anio_de_fecha)
from services.activity import registrar

router = APIRouter(prefix="/api/devoluciones-iva", tags=["devoluciones-iva"])

# --- Parámetros legales (actualizar cada enero) ------------------------------
# RBU = remuneración básica unificada vigente al 1 de enero del año de compra.
RBU_POR_ANIO = {2023: 450, 2024: 460, 2025: 470, 2026: 482}
IVA_TARIFA = 0.15
# Base imponible máxima mensual, en número de RBU, según beneficiario.
BASE_MAX_RBU = {"tercera_edad": 5, "discapacidad": 2}
# Proporción aplicable por rango de % de discapacidad (Reglamento LOD).
PROPORCION_DISCAPACIDAD = [(85, 1.0), (75, 0.8), (50, 0.7), (40, 0.6), (30, 0.5)]

ESTADOS = {"borrador", "presentada", "aprobada", "rechazada"}

_NOMBRE_MES = {1: "Enero", 2: "Febrero", 3: "Marzo", 4: "Abril", 5: "Mayo", 6: "Junio",
               7: "Julio", 8: "Agosto", 9: "Septiembre", 10: "Octubre", 11: "Noviembre",
               12: "Diciembre"}

# --- Rubros de gasto ---------------------------------------------------------
# A qué tipo de gasto se direcciona cada comprobante que entra a la solicitud.
# El catálogo es EXACTAMENTE el del portal del SRI (combo "Tipo de gasto" de la
# pantalla de facturas electrónicas), con su código, porque este dato termina
# cargándose allá: si acá ofreciéramos rubros que el SRI no tiene (turismo,
# servicios básicos, otros), al momento de presentar no habría dónde ponerlos.
# Verificado en el portal el 2026-08-06.
RUBROS = [
    {"key": "vestimenta",   "label": "Vestimenta",   "sri": "1"},
    {"key": "vivienda",     "label": "Vivienda",     "sri": "2"},
    {"key": "salud",        "label": "Salud",        "sri": "3"},
    {"key": "alimentacion", "label": "Alimentación", "sri": "4"},
    {"key": "educacion",    "label": "Educación",    "sri": "5"},
]
RUBRO_KEYS = {r["key"] for r in RUBROS}
RUBRO_LABEL = {r["key"]: r["label"] for r in RUBROS}
RUBRO_SRI = {r["key"]: r["sri"] for r in RUBROS}
# Sin rubro: el comprobante NO se puede presentar así. Se usa cuando la
# clasificación del proveedor no alcanza para proponer uno y el usuario todavía
# no eligió; `guardar_solicitud` lo rechaza (ver _rubros_faltantes).
RUBRO_VACIO = ""

# Rubros viejos (catálogo anterior de 8) que quedaron guardados en solicitudes
# ya creadas. Los que tienen equivalente en el SRI se traducen; turismo y otros
# no lo tienen, así que caen en vacío y hay que reasignarlos a mano.
RUBROS_LEGACY = {"servicios_basicos": "vivienda", "turismo": RUBRO_VACIO, "otros": RUBRO_VACIO}

# Pistas para PROPONER el rubro a partir de la clasificación que ya tiene el
# proveedor en Gastos. Es solo una sugerencia: el usuario la puede cambiar.
# Los servicios básicos (luz, agua, teléfono) van a Vivienda, que es donde el
# SRI los admite.
_PISTAS_RUBRO = [
    ("salud",        ("SALUD", "MEDIC", "FARMAC", "CLINIC", "HOSPITAL", "LABORATORIO", "ODONT", "OPTIC")),
    # Los hipermercados (Coral, comisariatos) van a alimentación aunque vendan de
    # todo: es el rubro con el que se presentan sus compras.
    # Con el listado del portal la única pista suele ser la RAZÓN SOCIAL, que no
    # dice el giro: "GERARDO ORTIZ E HIJOS CIA LTDA CORAL" es un hipermercado y
    # "ORTEGA BERMEO NANCY CUMANDA PIZZA HOUSE" es una pizzería. Por eso van
    # también los nombres comerciales de las cadenas de acá. Sigue siendo una
    # PROPUESTA: el tipo de gasto se declara al SRI y se revisa en pantalla.
    ("alimentacion", ("ALIMENT", "SUPERMERCAD", "HIPERMERC", "COMISARIAT", "ABARROTE",
                      "MINIMARKET", "VIVER", "PANADER", "RESTAURANT", "COMIDA",
                      # Nada de siglas cortas acá: "TIA" o "AKI" sueltas caen
                      # dentro de nombres de personas (CRISTIAN, SEBASTIAN) y
                      # mandarían a alimentación a cualquiera. Van completas.
                      "FAVORITA", "SUPERMAXI", "MEGAMAXI", "CORAL",
                      "ALMACENES TIA", "SANTA MARIA", "DELICAT", "PIZZ",
                      "BURGER", "POLLO", "CAFE", "CAFETER", "HELAD", "CHUZO",
                      "ASADERO", "MARISQU", "CEVICH", "SANDUCH", "FRUT", "CARNIC")),
    ("vivienda",     ("VIVIENDA", "ARRIEND", "ALQUILER", "CONDOMIN", "FERRETER", "MUEBL", "HOGAR",
                      "LUZ", "ELECTRIC", "AGUA", "TELEFON", "INTERNET", "TELECOM", "GAS",
                      "INMUEBLE")),
    ("vestimenta",   ("VESTIMENTA", "ROPA", "CALZAD", "TEXTIL", "BOUTIQUE", "VESTIR", "PRENDAS")),
    ("educacion",    ("EDUCAC", "COLEGIO", "ESCUELA", "UNIVERSID", "CAPACITAC", "LIBRER", "UTILES",
                      "ENSENANZ")),
]


def _rubro_sugerido(clasificacion) -> str:
    """Rubro propuesto según la clasificación del proveedor en Gastos.

    Devuelve vacío cuando no hay con qué decidir: es preferible que el usuario
    elija a mandar todo a un cajón por defecto, porque el tipo de gasto es un
    dato que se declara al SRI."""
    # Sin tildes ni Ñ: el catastro del SRI escribe "ENSEÑANZA" y "FARMACÉUTICOS",
    # y una pista con acento sería una pista que no encuentra nada.
    texto = unicodedata.normalize("NFD", str(clasificacion or "").strip().upper())
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    if not texto:
        return RUBRO_VACIO
    for rubro, pistas in _PISTAS_RUBRO:
        if any(p in texto for p in pistas):
            return rubro
    return RUBRO_VACIO


def _rubro_valido(valor, clasificacion=None) -> str:
    v = str(valor or "").strip().lower()
    if v in RUBRO_KEYS:
        return v
    if v in RUBROS_LEGACY:
        return RUBROS_LEGACY[v]
    return _rubro_sugerido(clasificacion)


def _rubros_faltantes(items: List[dict]) -> List[str]:
    """Comprobantes marcados a los que todavía no se les asignó tipo de gasto."""
    return [f"{it.get('fecha') or '?'} · {it.get('nombre_proveedor') or it.get('ruc_proveedor') or '?'}"
            for it in items if not it.get("rubro")]


def _rbu(anio) -> float:
    try:
        anio = int(anio or 0)
    except (TypeError, ValueError):
        anio = 0
    return float(RBU_POR_ANIO.get(anio, RBU_POR_ANIO[max(RBU_POR_ANIO)]))


def _proporcion_discapacidad(porcentaje) -> float:
    try:
        p = float(porcentaje or 0)
    except (TypeError, ValueError):
        p = 0
    for umbral, prop in PROPORCION_DISCAPACIDAD:
        if p >= umbral:
            return prop
    return 0.0


def _tope_mensual(anio, tipo: str, porcentaje=None) -> float:
    base_max = _rbu(anio) * BASE_MAX_RBU.get(tipo, BASE_MAX_RBU["tercera_edad"])
    tope = base_max * IVA_TARIFA
    if tipo == "discapacidad":
        tope *= _proporcion_discapacidad(porcentaje)
    return round(tope, 2)


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _resumen_comprobante(inv: dict) -> dict:
    """Base gravada e IVA del comprobante (solo lo que genera crédito a devolver)."""
    # Incluye la tarifa 8% (base_8/iva_8): es IVA efectivamente pagado y también
    # genera crédito a devolver (antes el 8% venía plegado en base_15/iva_15).
    base = _num(inv.get("base_15")) + _num(inv.get("base_8")) + _num(inv.get("base_5"))
    iva = _num(inv.get("iva_15")) + _num(inv.get("iva_8")) + _num(inv.get("iva_5"))
    return {
        "id": inv.get("id"),
        "unique_id": inv.get("unique_id"),
        # Serie del comprobante (estab-ptoEmi-secuencial): es como lo muestra el
        # portal del SRI, y por lo tanto la llave para casar cada fila de su grilla.
        "factura_numero": inv.get("factura_numero"),
        "fecha": inv.get("fecha"),
        "ruc_proveedor": inv.get("ruc_proveedor"),
        "nombre_proveedor": inv.get("nombre_proveedor"),
        "clasificacion": inv.get("clasificacion"),
        "base": round(base, 2),
        "iva": round(iva, 2),
        "total": _num(inv.get("total")),
    }


# Comprobantes que vienen de la GRILLA DEL PORTAL, no de Gastos.
#
# El SRI ya no pide cargar las facturas: en "Ingresar facturas electrónicas"
# muestra él mismo el listado que califica —bienes de primera necesidad de
# establecimientos verificados— y el trámite es marcarlo, clasificarlo y
# enviarlo. Ese listado entra al sistema tal cual y no tiene invoice_id: no es
# una factura de Gastos, es lo que el portal reconoce. Se distinguen por el
# prefijo del id, que es sintético (la grilla no da id, da la serie).
PORTAL_PREFIJO = "portal:"


def _es_portal(id_) -> bool:
    return str(id_ or "").startswith(PORTAL_PREFIJO)


def _serie_de_id(id_) -> str:
    return str(id_ or "")[len(PORTAL_PREFIJO):]


def _resumen_portal(row: dict) -> dict:
    """Comprobante tal como lo lista el portal.

    La grilla trae proveedor, serie, fecha y monto IVA; NO trae la base
    imponible ni el total, así que van en cero: lo que se devuelve es el IVA y
    es lo único que el portal informa. Tampoco trae el RUC del proveedor."""
    serie = str(row.get("serie") or row.get("factura_numero") or "").strip()
    return {
        "id": PORTAL_PREFIJO + serie,
        "unique_id": row.get("unique_id"),
        "factura_numero": serie,
        "fecha": str(row.get("fecha") or "").strip(),
        "ruc_proveedor": (row.get("ruc_proveedor") or None),
        "nombre_proveedor": str(row.get("proveedor") or row.get("nombre_proveedor") or "").strip(),
        "clasificacion": row.get("clasificacion"),
        "base": _num(row.get("base")),
        "iva": round(_num(row.get("iva")), 2),
        "total": _num(row.get("total")),
        "origen": "portal",
    }


# --- Memoria del tipo de gasto por proveedor --------------------------------
# El portal no da el RUC del proveedor, solo la razón social, así que lo que se
# recuerda va por NOMBRE. Y el portal suele pegar razón social + nombre
# comercial repitiendo lo mismo ("CORPORACION FAVORITA C.A. CORPORACION
# FAVORITA C.A."), así que la clave se queda con una sola copia: si no, el mismo
# proveedor se aprendería dos veces según cómo lo escriba el SRI ese día.
def _nombre_clave(nombre) -> str:
    t = unicodedata.normalize("NFD", str(nombre or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[^A-Z0-9 ]+", " ", t.upper())
    palabras = t.split()
    if palabras and len(palabras) % 2 == 0:
        mitad = len(palabras) // 2
        if palabras[:mitad] == palabras[mitad:]:
            palabras = palabras[:mitad]
    return " ".join(palabras)[:200]


def _ambito_aprendizaje(user_id: str) -> tuple:
    """(columna, valor) del dueño del aprendizaje: la empresa activa, o el usuario.

    Clasificar es trabajo del estudio, no de cada persona: cuando hay empresa
    activa lo aprendido se comparte dentro de ella."""
    try:
        org = orgs.org_activa()
    except Exception:
        org = None
    return ("org_id", org) if org else ("user_id", user_id)


def _rubros_aprendidos(sb, user_id: str) -> Dict[str, str]:
    col, val = _ambito_aprendizaje(user_id)
    try:
        filas = fetch_all(lambda: sb.table("devoluciones_iva_rubro_proveedor")
                          .select("nombre_clave,rubro").eq(col, val))
    except Exception as e:            # la tabla puede no estar todavía en la base
        print(f"[devoluciones_iva] sin memoria de rubros: {e}")
        return {}
    return {f["nombre_clave"]: f["rubro"] for f in filas if f.get("rubro")}


def _aprender_rubros(sb, user_id: str, items: List[dict]) -> int:
    """Guarda lo que el usuario decidió, para imputarlo solo la próxima vez.

    Se llama al GUARDAR la solicitud, que es cuando el tipo de gasto es una
    decisión y no una propuesta."""
    col, val = _ambito_aprendizaje(user_id)
    decididos: Dict[str, dict] = {}
    for it in items:
        clave = _nombre_clave(it.get("nombre_proveedor"))
        rubro = it.get("rubro")
        if clave and rubro:
            decididos[clave] = {"rubro": rubro, "visto": it.get("nombre_proveedor")}
    if not decididos:
        return 0
    try:
        previas = fetch_all(lambda: sb.table("devoluciones_iva_rubro_proveedor")
                            .select("id,nombre_clave,rubro,veces").eq(col, val)
                            .in_("nombre_clave", list(decididos)))
        por_clave = {p["nombre_clave"]: p for p in previas}
        nuevas = []
        for clave, d in decididos.items():
            vieja = por_clave.get(clave)
            if not vieja:
                nuevas.append({col: val, "user_id": user_id, "nombre_clave": clave,
                               "nombre_visto": d["visto"], "rubro": d["rubro"], "veces": 1})
                continue
            # Si cambió de opinión, manda lo último y el contador vuelve a empezar.
            cambio = vieja.get("rubro") != d["rubro"]
            sb.table("devoluciones_iva_rubro_proveedor").update({
                "rubro": d["rubro"], "nombre_visto": d["visto"],
                "veces": 1 if cambio else int(vieja.get("veces") or 1) + 1,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", vieja["id"]).execute()
        if nuevas:
            sb.table("devoluciones_iva_rubro_proveedor").insert(nuevas).execute()
        return len(decididos)
    except Exception as e:            # aprender no puede romper el guardado
        print(f"[devoluciones_iva] no pude aprender los rubros: {e}")
        return 0


def _clasif_por_proveedor(sb, client_id: str) -> Dict[str, str]:
    """Clasificación que ya tiene cada proveedor en Gastos, por NOMBRE.

    La grilla del portal no da el RUC, así que el nombre es lo único con lo que
    se puede reusar el trabajo de clasificación ya hecho para ese proveedor."""
    filas = fetch_all(lambda: sb.table("invoices").select(
        "nombre_proveedor,clasificacion").eq("client_id", client_id))
    mapa: Dict[str, str] = {}
    for f in filas:
        nom = str(f.get("nombre_proveedor") or "").strip().upper()
        cla = str(f.get("clasificacion") or "").strip()
        if nom and cla and cla != "SIN CLASIFICAR":
            mapa.setdefault(nom, cla)
    return mapa


def _actividades_por_nombre(sb, client_id: str) -> Dict[str, dict]:
    """Actividad económica del SRI de cada proveedor, indexada por NOMBRE.

    La grilla del portal trae la razón social y nada más —sin RUC—, así que la
    actividad no se puede pedir al SRI para esas filas: el catastro se consulta
    por número, no por nombre (probado: los servicios `obtenerPorRazonSocial` y
    `obtenerPorNombreComercial` no existen en la API pública).

    Lo que sí se puede es reusar lo que el sistema YA sabe: el mismo proveedor,
    en Gastos, aparece con RUC, y su actividad está en `classification_map`
    porque la clasificación la trae del SRI. Se casa por nombre normalizado —el
    mismo criterio con el que ya se aprende el tipo de gasto— y así la fila del
    portal hereda la actividad de su RUC."""
    porrruc: Dict[str, dict] = {}
    try:
        for f in fetch_all(lambda: sb.table("classification_map")
                           .select("ruc,nombre_proveedor,actividad,categoria")):
            ruc = str(f.get("ruc") or "").strip()
            act = str(f.get("actividad") or "").strip()
            if ruc:
                porrruc[ruc] = {"actividad": act, "categoria": f.get("categoria") or "",
                                "nombre": f.get("nombre_proveedor") or ""}
    except Exception as e:                      # sin clasificador no se rompe nada
        print(f"[devoluciones_iva] sin classification_map: {e}")

    mapa: Dict[str, dict] = {}
    # Por el nombre con que el proveedor figura en el clasificador…
    for ruc, d in porrruc.items():
        clave = _nombre_clave(d.get("nombre"))
        if clave and d.get("actividad"):
            mapa.setdefault(clave, {"actividad": d["actividad"], "ruc": ruc})
    # …y por el nombre con que aparece en las facturas de este contribuyente,
    # que es el que más se parece al del portal.
    try:
        for f in fetch_all(lambda: sb.table("invoices")
                           .select("nombre_proveedor,ruc_proveedor").eq("client_id", client_id)):
            clave = _nombre_clave(f.get("nombre_proveedor"))
            ruc = str(f.get("ruc_proveedor") or "").strip()
            if not clave or not ruc:
                continue
            d = porrruc.get(ruc)
            if d and d.get("actividad"):
                mapa.setdefault(clave, {"actividad": d["actividad"], "ruc": ruc})
            else:
                # Sin actividad todavía: se deja el RUC para poder pedírsela al
                # SRI cuando se sincronice.
                mapa.setdefault(clave, {"actividad": "", "ruc": ruc})
    except Exception as e:
        print(f"[devoluciones_iva] sin facturas para cruzar actividades: {e}")
    return mapa


def _meses_del_periodo(pmes, pfreq, psem) -> List[int]:
    """Meses que cubre el período del cliente: uno si es mensual, los seis del
    semestre si es semestral (la devolución también se pide por el semestre)."""
    if (pfreq or "mensual") == "semestral":
        sem = int(psem) if psem else semestre_de_mes(pmes or 1)
        ini, fin = rango_semestre(sem)
        return list(range(ini, fin + 1))
    return [int(pmes)] if pmes else []


def _detalle_por_mes(items: List[dict], meses: List[int], anio, tipo: str, porcentaje) -> dict:
    """Reparte los comprobantes marcados por MES y aplica el tope de cada mes.

    El tope de la devolución es mensual (5 RBU de base para adultos mayores; 2 RBU
    proporcionales para discapacidad), así que un período semestral tiene SEIS
    topes, no uno: el excedente de un mes no se compensa con el cupo libre de otro.
    Los comprobantes con fecha ilegible o de otro mes se imputan al mes ancla del
    período (no se descartan en silencio)."""
    tope_mes = _tope_mensual(anio, tipo, porcentaje)
    ancla = meses[-1] if meses else None
    por_mes = {m: {"mes": m, "comprobantes": 0, "base": 0.0, "iva": 0.0} for m in meses}
    for it in items:
        fmes, fanio = mes_anio_de_fecha(it.get("fecha"))
        destino = fmes if (fmes in por_mes and (not anio or fanio == int(anio))) else ancla
        if destino is None:
            continue
        d = por_mes[destino]
        d["comprobantes"] += 1
        d["base"] += _num(it.get("base"))
        d["iva"] += _num(it.get("iva"))

    detalle = []
    for m in meses:
        d = por_mes[m]
        iva = round(d["iva"], 2)
        detalle.append({
            "mes": m,
            "comprobantes": d["comprobantes"],
            "base": round(d["base"], 2),
            "iva": iva,
            "tope": tope_mes,
            "solicitar": round(min(iva, tope_mes), 2),
            "excedente": round(max(0.0, iva - tope_mes), 2),
        })
    return {
        "tope_mes": tope_mes,
        "meses": meses,
        "detalle": detalle,
        "total_base": round(sum(d["base"] for d in detalle), 2),
        "total_iva": round(sum(d["iva"] for d in detalle), 2),
        # Tope del PERÍODO: la suma de los topes de sus meses (mensual = el del mes).
        "tope_periodo": round(tope_mes * len(meses), 2),
        "monto": round(sum(d["solicitar"] for d in detalle), 2),
        "excedente": round(sum(d["excedente"] for d in detalle), 2),
    }


def _solicitud_de_periodo(sb, client_id: str, mes, anio) -> Optional[dict]:
    q = sb.table("devoluciones_iva_solicitudes").select("*").eq("client_id", client_id)
    if mes and anio:
        q = q.eq("mes", int(mes)).eq("anio", int(anio))
    rows = q.execute().data or []
    return rows[0] if rows else None


def _items_de(sb, solicitud_id: str) -> List[dict]:
    return sb.table("devoluciones_iva_items").select("*").eq(
        "solicitud_id", solicitud_id).execute().data or []


@router.get("/rubros")
async def rubros(_: str = Depends(get_current_user)):
    """Catálogo de tipos de gasto (el mismo del portal del SRI, con su código)."""
    return {"rubros": RUBROS, "defecto": RUBRO_VACIO}


@router.post("/actividades")
async def sincronizar_actividades(client_id: str = Query(...),
                                  user_id: str = Depends(get_current_user)):
    """Trae del SRI la actividad económica de los proveedores de este contribuyente.

    Para qué: la actividad es la mejor pista del tipo de gasto. "GERARDO ORTIZ E
    HIJOS CIA LTDA" no dice nada; su actividad —venta al por menor de alimentos—
    lo dice todo, y de ahí sale la propuesta de rubro.

    Alcance y su límite: el catastro del SRI se consulta POR RUC. Los
    comprobantes que trae la grilla del portal no lo tienen —solo la razón
    social—, así que acá se sincronizan los proveedores que el sistema conoce con
    RUC (los de las facturas del contribuyente) y las filas del portal heredan la
    actividad casando el nombre. El que nunca pasó por Gastos se queda sin
    actividad: no hay forma de preguntarle al SRI por nombre."""
    from services.min_produccion import consultar_sri
    sb = get_supabase_client()
    assert_client_owner(client_id, user_id)

    mapa = _actividades_por_nombre(sb, client_id)
    con_ruc = {d["ruc"] for d in mapa.values() if d.get("ruc")}
    faltan = sorted({d["ruc"] for d in mapa.values()
                     if d.get("ruc") and not d.get("actividad")})
    sin_ruc = sum(1 for d in mapa.values() if not d.get("ruc"))

    # El SRI responde de a uno y tarda; se acota por llamada y se avisa cuánto
    # quedó afuera, que es mejor que una pantalla colgada o un corte silencioso.
    TOPE = 20
    pendientes = faltan[TOPE:]
    nuevas = 0
    for ruc in faltan[:TOPE]:
        try:
            sri = consultar_sri(ruc, timeout=8) or {}
        except Exception:
            continue
        ae = (sri.get("actividad_economica") or "").strip()
        if not ae:
            continue
        try:
            sb.table("classification_map").update({"actividad": ae}).eq("ruc", ruc).execute()
            nuevas += 1
        except Exception as e:
            print(f"[devoluciones_iva] no pude guardar la actividad de {ruc}: {e}")

    return {
        "proveedores": len(mapa),
        "con_ruc": len(con_ruc),
        "sin_ruc": sin_ruc,
        "consultados": min(len(faltan), TOPE),
        "actualizados": nuevas,
        "pendientes": len(pendientes),
    }


@router.get("/parametros")
async def parametros(
    anio: int,
    tipo: str = "tercera_edad",
    porcentaje: Optional[float] = None,
    user_id: str = Depends(get_current_user),
):
    """Tope mensual y parámetros vigentes para el año/beneficiario."""
    if tipo not in BASE_MAX_RBU:
        raise HTTPException(status_code=400, detail=f"Tipo inválido: {sorted(BASE_MAX_RBU)}")
    return {
        "anio": anio,
        "rbu": _rbu(anio),
        "iva_tarifa": IVA_TARIFA,
        "base_max_rbu": BASE_MAX_RBU[tipo],
        "proporcion": _proporcion_discapacidad(porcentaje) if tipo == "discapacidad" else 1.0,
        "tope_mensual": _tope_mensual(anio, tipo, porcentaje),
    }


def _periodo_pedido(sb, client_id: str, mes=None, anio=None):
    """Período sobre el que se trabaja: el que se pide, o el del cliente.

    La devolución en el portal del SRI se presenta MES A MES (el combo "Período
    solicitado" son los meses del año), así que cuando se pide un mes concreto
    el período es mensual aunque el contribuyente declare semestral: un semestre
    se resuelve con seis solicitudes, no con una."""
    if mes and anio:
        return int(mes), int(anio), "mensual", None, [int(mes)]
    pmes, panio, pfreq, psem = periodo_cliente_ext(sb, client_id)
    return pmes, panio, pfreq, psem, _meses_del_periodo(pmes, pfreq, psem)


@router.get("/periodos")
async def periodos(
    client_id: str = Query(...),
    user_id: str = Depends(get_current_user),
):
    """Meses con comprobantes y en qué estado está la devolución de cada uno.

    Es lo que responde «¿qué mes valido?»: lista los meses que tienen gasto
    cargado, con el IVA disponible y si ya hay solicitud (y su estado). Los que
    quedan en `pendiente` son los que se pueden marcar para procesarlos en lote."""
    sb = get_supabase_client()
    assert_client_owner(client_id, user_id)

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,estado,fecha,base_15,iva_15,base_8,iva_8,base_5,iva_5"
    ).eq("client_id", client_id))

    acc: Dict[tuple, dict] = {}
    for i in invs:
        if (i.get("estado") or "OK") != "OK":
            continue
        m, a = mes_anio_de_fecha(i.get("fecha"))
        if not m or not a:
            continue
        r = _resumen_comprobante(i)
        d = acc.setdefault((a, m), {"anio": a, "mes": m, "comprobantes": 0, "base": 0.0, "iva": 0.0})
        d["comprobantes"] += 1
        d["base"] += r["base"]
        d["iva"] += r["iva"]

    sols = sb.table("devoluciones_iva_solicitudes").select(
        "id,mes,anio,estado,monto_solicitado,comprobantes_enviados,monto_enviado,total_base,total_iva"
    ).eq("client_id", client_id).execute().data or []
    por_periodo = {(int(s["anio"]), int(s["mes"])): s for s in sols}

    # Meses que solo existen como solicitud: los que entraron desde la grilla
    # del portal no tienen gasto cargado en el sistema y, sin esto, el mes no
    # aparecería para elegirlo aunque la solicitud ya esté armada.
    solo_solicitud = [s for (a, m), s in por_periodo.items() if (a, m) not in acc]
    if solo_solicitud:
        filas = fetch_all(lambda: sb.table("devoluciones_iva_items").select(
            "solicitud_id").in_("solicitud_id", [s["id"] for s in solo_solicitud]))
        cuenta: Dict[str, int] = {}
        for f in filas:
            cuenta[f["solicitud_id"]] = cuenta.get(f["solicitud_id"], 0) + 1
        for s in solo_solicitud:
            acc[(int(s["anio"]), int(s["mes"]))] = {
                "anio": int(s["anio"]), "mes": int(s["mes"]),
                "comprobantes": cuenta.get(s["id"], 0),
                "base": _num(s.get("total_base")), "iva": _num(s.get("total_iva")),
            }

    salida = []
    for (a, m), d in sorted(acc.items(), reverse=True):
        sol = por_periodo.get((a, m))
        salida.append({
            **d,
            "base": round(d["base"], 2),
            "iva": round(d["iva"], 2),
            "etiqueta": f"{_NOMBRE_MES.get(m, m)} {a}",
            "solicitud_id": sol["id"] if sol else None,
            "estado": (sol or {}).get("estado") or "pendiente",
            "monto_solicitado": _num((sol or {}).get("monto_solicitado")),
            "comprobantes_enviados": (sol or {}).get("comprobantes_enviados"),
            "monto_enviado": _num((sol or {}).get("monto_enviado")) if sol and sol.get("monto_enviado") is not None else None,
        })
    return {"periodos": salida}


@router.get("/comprobantes")
async def comprobantes(
    client_id: str = Query(...),
    mes: Optional[int] = None,
    anio: Optional[int] = None,
    user_id: str = Depends(get_current_user),
):
    """Comprobantes del período pedido (o el del cliente) + la solicitud guardada."""
    sb = get_supabase_client()
    assert_client_owner(client_id, user_id)
    pmes, panio, pfreq, psem, meses = _periodo_pedido(sb, client_id, mes, anio)

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,factura_numero,estado,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_0,base_15,iva_15,base_8,iva_8,base_5,iva_5,total"
    ).eq("client_id", client_id).order("fecha", desc=True))
    comps = [_resumen_comprobante(i) for i in invs if (i.get("estado") or "OK") == "OK"]
    # Cuando se pide un mes concreto se acota a ese mes: si no, al validar un mes
    # viejo aparecería el gasto de todos los períodos cargados del contribuyente.
    if mes and anio:
        comps = [c for c in comps if mes_anio_de_fecha(c.get("fecha")) == (int(mes), int(anio))]

    for c in comps:
        c["origen"] = "gastos"

    solicitud = _solicitud_de_periodo(sb, client_id, pmes, panio)
    seleccionados = []
    rubros_guardados = {}
    if solicitud:
        items = _items_de(sb, solicitud["id"])
        solicitud["items"] = items
        seleccionados = [it["invoice_id"] for it in items if it.get("invoice_id")]
        rubros_guardados = {it["invoice_id"]: it.get("rubro") for it in items if it.get("invoice_id")}
        # Los comprobantes que entraron desde la grilla del SRI no están en
        # Gastos: viven en la solicitud y son los únicos que los tienen, así que
        # salen de ahí para poder marcarlos y clasificarlos en la pantalla.
        vistas = {c.get("factura_numero") for c in comps if c.get("factura_numero")}
        for it in items:
            if it.get("invoice_id"):
                continue
            serie = str(it.get("factura_numero") or "").strip()
            if not serie or serie in vistas:
                continue
            vistas.add(serie)
            c = _resumen_portal({**it, "serie": serie, "proveedor": it.get("nombre_proveedor")})
            comps.append(c)
            seleccionados.append(c["id"])
            rubros_guardados[c["id"]] = it.get("rubro")
        comps.sort(key=lambda c: str(c.get("fecha") or ""), reverse=True)

    # Rubro de cada comprobante. Manda el ya guardado en la solicitud; si no,
    # lo APRENDIDO de ese proveedor en solicitudes anteriores; y recién después
    # la pista por palabra clave. Para los del portal no hay clasificación de
    # Gastos, así que ahí la pista se busca en el nombre.
    aprendidos = _rubros_aprendidos(sb, user_id)
    # La ACTIVIDAD ECONÓMICA del SRI es mejor pista que el nombre: "GERARDO
    # ORTIZ E HIJOS CIA LTDA" no dice nada, y su actividad —venta al por menor
    # de alimentos— lo dice todo. Va después de lo aprendido, que es una
    # decisión, y antes del nombre, que es una adivinanza.
    actividades = _actividades_por_nombre(sb, client_id)
    for c in comps:
        clave = _nombre_clave(c.get("nombre_proveedor"))
        act = (actividades.get(clave) or {})
        c["actividad"] = act.get("actividad") or ""
        c["ruc_sri"] = act.get("ruc") or c.get("ruc_proveedor") or ""
        sugerido = (aprendidos.get(clave)
                    or (_rubro_sugerido(c["actividad"]) if c["actividad"] else RUBRO_VACIO)
                    or _rubro_sugerido(c.get("clasificacion") or c.get("nombre_proveedor")))
        c["rubro_sugerido"] = sugerido
        c["rubro"] = rubros_guardados.get(c["id"]) or sugerido

    return {
        "periodo": etiqueta_periodo(pmes, panio, pfreq, psem),
        "mes": pmes,
        "anio": panio,
        "periodicidad": pfreq or "mensual",
        "semestre": psem,
        "meses": meses,
        "comprobantes": comps,
        "solicitud": solicitud,
        "seleccionados": seleccionados,
        "rubros": RUBROS,
    }


class SolicitudIn(BaseModel):
    client_id: str
    tipo_beneficiario: str = "tercera_edad"
    porcentaje_discapacidad: Optional[float] = None
    invoice_ids: List[str]
    # invoice_id → rubro de gasto. Lo que no venga se propone por la clasificación.
    rubros: Optional[Dict[str, str]] = None
    observaciones: Optional[str] = None
    # Mes/año a validar. Si no vienen, se usa el período del cliente.
    mes: Optional[int] = None
    anio: Optional[int] = None
    # Datos de los comprobantes traídos del portal que siguen marcados. Los
    # manda la pantalla porque no están en Gastos: si un id `portal:` no viene
    # acá, se recupera de la solicitud anterior.
    portal_filas: Optional[List[dict]] = None


def _validar_beneficiario(tipo: str, porcentaje):
    if tipo not in BASE_MAX_RBU:
        raise HTTPException(status_code=400, detail=f"Tipo inválido: {sorted(BASE_MAX_RBU)}")
    if tipo == "discapacidad" and (not porcentaje or not (30 <= float(porcentaje) <= 100)):
        raise HTTPException(status_code=400,
                            detail="Para discapacidad indica el porcentaje (30 a 100).")


def _items_del_portal(sb, client_id: str, mes, anio, series: List[str],
                      filas: Optional[List[dict]] = None) -> List[dict]:
    """Datos de los comprobantes de la grilla del SRI que se están marcando.

    Vienen en el pedido —el navegador los tiene en pantalla— o, si no, de la
    solicitud que ya los tenía guardados: como no están en Gastos, esa es la
    única copia que existe de lo que mostró el portal."""
    por_serie: Dict[str, dict] = {}
    for f in (filas or []):
        r = _resumen_portal(f)
        if r["factura_numero"]:
            por_serie[r["factura_numero"]] = r
    faltan = [s for s in series if s not in por_serie]
    if faltan:
        previa = _solicitud_de_periodo(sb, client_id, mes, anio)
        if previa:
            for it in _items_de(sb, previa["id"]):
                serie = str(it.get("factura_numero") or "").strip()
                if serie in faltan and not it.get("invoice_id"):
                    por_serie[serie] = _resumen_portal(
                        {**it, "serie": serie, "proveedor": it.get("nombre_proveedor")})
    return [por_serie[s] for s in series if s in por_serie]


def _guardar_solicitud(sb, user_id: str, client_id: str, tipo: str, porcentaje,
                       invoice_ids: List[str], rubros_pedidos: Optional[Dict[str, str]],
                       observaciones=None, mes=None, anio=None,
                       portal_filas: Optional[List[dict]] = None,
                       exigir_rubro: bool = True) -> dict:
    """Crea/reemplaza la solicitud de UN período con los comprobantes marcados.

    Lo usa tanto el guardado de una sola pantalla como el procesamiento en lote
    de varios meses; por eso vive aparte del endpoint. Los marcados pueden venir
    de Gastos (invoice_id) o de la grilla del portal (prefijo `portal:`)."""
    pmes, panio, pfreq, psem, meses = _periodo_pedido(sb, client_id, mes, anio)
    if not pmes or not panio:
        raise HTTPException(status_code=400,
                            detail="El cliente no tiene período (mes/año) definido.")

    ids_gastos = [i for i in invoice_ids if not _es_portal(i)]
    series = [_serie_de_id(i) for i in invoice_ids if _es_portal(i)]

    items: List[dict] = []
    if ids_gastos:
        invs = fetch_all(lambda: sb.table("invoices").select(
            "id,unique_id,factura_numero,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
            "base_15,iva_15,base_8,iva_8,base_5,iva_5,total"
        ).eq("client_id", client_id).in_("id", ids_gastos))
        items += [_resumen_comprobante(i) for i in invs]
    if series:
        items += _items_del_portal(sb, client_id, pmes, panio, series, portal_filas)
    if not items:
        raise HTTPException(status_code=400, detail="Los comprobantes marcados no existen en este cliente.")

    pedidos = rubros_pedidos or {}
    for it in items:
        it["rubro"] = _rubro_valido(pedidos.get(it["id"]),
                                    it.get("clasificacion") or it.get("nombre_proveedor"))

    # El tipo de gasto es obligatorio: es un dato que se declara al SRI y su
    # combo no admite vacío, así que no tiene sentido dejar pasar la solicitud.
    # Solo se exige al guardar: al traer la grilla del portal la solicitud nace
    # para clasificarla acá, y ahí todavía puede faltar.
    faltantes = _rubros_faltantes(items) if exigir_rubro else []
    if faltantes:
        raise HTTPException(status_code=400, detail=(
            f"Falta el tipo de gasto en {len(faltantes)} comprobante(s): "
            + "; ".join(faltantes[:5]) + ("…" if len(faltantes) > 5 else "")))

    # El tope es MENSUAL: se aplica mes a mes (un período semestral lleva seis).
    calc = _detalle_por_mes(items, meses, panio, tipo, porcentaje)

    # Reemplazo total: la solicitud del período es una sola (UNIQUE client+mes+anio).
    previa = _solicitud_de_periodo(sb, client_id, pmes, panio)
    if previa:
        if previa.get("estado") == "presentada":
            raise HTTPException(status_code=409, detail=(
                f"{etiqueta_periodo(pmes, panio, pfreq, psem)} ya está presentada al SRI. "
                "Elimínala del historial si necesitás rehacerla."))
        sb.table("devoluciones_iva_solicitudes").delete().eq("id", previa["id"]).execute()

    res = sb.table("devoluciones_iva_solicitudes").insert({
        "user_id": user_id,
        "client_id": client_id,
        "mes": int(pmes),
        "anio": int(panio),
        "tipo_beneficiario": tipo,
        "porcentaje_discapacidad": porcentaje,
        "total_base": calc["total_base"],
        "total_iva": calc["total_iva"],
        "tope_mensual": calc["tope_periodo"],
        "monto_solicitado": calc["monto"],
        "detalle_meses": calc["detalle"],
        "estado": "borrador",
        "observaciones": observaciones,
    }).execute()
    solicitud = res.data[0]

    sb.table("devoluciones_iva_items").insert([
        {
            "solicitud_id": solicitud["id"],
            # Los del portal no son facturas de Gastos: van sin invoice_id y su
            # identidad es la serie, que es como los nombra el SRI.
            "invoice_id": None if _es_portal(it["id"]) else it["id"],
            "unique_id": it["unique_id"],
            "factura_numero": it["factura_numero"],
            "fecha": it["fecha"],
            "ruc_proveedor": it["ruc_proveedor"],
            "nombre_proveedor": it["nombre_proveedor"],
            "clasificacion": it["clasificacion"],
            "rubro": it["rubro"],
            "base": it["base"],
            "iva": it["iva"],
            "total": it["total"],
        }
        for it in items
    ]).execute()

    # Lo que se guardó es una DECISIÓN del usuario sobre el tipo de gasto de
    # cada proveedor: se aprende para imputarlo solo la próxima vez. En la
    # ingesta del portal no, que ahí los rubros todavía son una propuesta.
    if exigir_rubro:
        _aprender_rubros(sb, user_id, items)

    registrar(actor_user_id=user_id, action="create", module="declaraciones",
              entity="Solicitud devolución IVA", client_id=client_id,
              cantidad=len(items))
    return {**solicitud, "items_count": len(items), "excedente": calc["excedente"],
            "detalle_meses": calc["detalle"], "tope_mes": calc["tope_mes"],
            "periodo": etiqueta_periodo(pmes, panio, pfreq, psem)}


@router.post("/solicitudes")
async def guardar_solicitud(body: SolicitudIn, user_id: str = Depends(get_current_user)):
    """Crea/reemplaza la solicitud del período pedido (queda en borrador)."""
    sb = get_supabase_client()
    assert_client_owner(body.client_id, user_id)
    _validar_beneficiario(body.tipo_beneficiario, body.porcentaje_discapacidad)
    if not body.invoice_ids:
        raise HTTPException(status_code=400, detail="Marca al menos un comprobante.")
    return _guardar_solicitud(
        sb, user_id, body.client_id, body.tipo_beneficiario, body.porcentaje_discapacidad,
        body.invoice_ids, body.rubros, body.observaciones, body.mes, body.anio,
        portal_filas=body.portal_filas)


class PortalFila(BaseModel):
    """Una fila de la grilla "Listado de comprobantes recibidos" del SRI."""
    serie: str
    fecha: Optional[str] = None
    proveedor: Optional[str] = None
    iva: float = 0


class PortalIn(BaseModel):
    client_id: str
    mes: int
    anio: int
    tipo_beneficiario: str = "tercera_edad"
    porcentaje_discapacidad: Optional[float] = None
    # Identificación que el portal mostraba: se compara con la del contribuyente
    # para no cargarle a uno los comprobantes de otro.
    identificacion: Optional[str] = None
    filas: List[PortalFila]


@router.post("/portal")
async def ingresar_del_portal(body: PortalIn, user_id: str = Depends(get_current_user)):
    """Ingresa al sistema el listado que el portal del SRI muestra del período.

    El trámite dejó de ser "cargar facturas": el SRI lista él mismo lo que
    califica —bienes de primera necesidad de establecimientos verificados— y lo
    que hay que hacer es marcar, clasificar y enviar. Así que la grilla entra
    tal cual y la solicitud nace de ahí, sin depender de que esas facturas estén
    en Gastos (muchas no van a estar: el portal deja fuera las de devolución
    automática total y suma las que el contribuyente no cargó).

    Queda en borrador y con el tipo de gasto PROPUESTO —por la clasificación que
    el proveedor ya tenga en Gastos, o por su nombre—, para revisarlo en la
    pantalla antes de presentar."""
    sb = get_supabase_client()
    assert_client_owner(body.client_id, user_id)
    _validar_beneficiario(body.tipo_beneficiario, body.porcentaje_discapacidad)
    if not body.filas:
        raise HTTPException(status_code=400, detail="El portal no devolvió ningún comprobante.")

    cl = sb.table("clients").select("identificacion,nombre").eq("id", body.client_id).execute().data
    ident = str((cl[0] if cl else {}).get("identificacion") or "").strip()
    pedida = str(body.identificacion or "").strip()
    if pedida and ident and pedida != ident:
        raise HTTPException(status_code=400, detail=(
            f"Esos comprobantes son de {pedida} y el contribuyente abierto es {ident}. "
            "Abrí el contribuyente correcto y volvé a pegarlos."))

    clasif = _clasif_por_proveedor(sb, body.client_id)
    aprendidos = _rubros_aprendidos(sb, user_id)
    actividades = _actividades_por_nombre(sb, body.client_id)
    filas, rubros, vistas = [], {}, set()
    for f in body.filas:
        serie = str(f.serie or "").strip()
        if not serie or serie in vistas:
            continue          # el portal pagina: una serie repetida es la misma fila
        vistas.add(serie)
        fila = {"serie": serie, "fecha": f.fecha, "proveedor": f.proveedor, "iva": f.iva}
        filas.append(fila)
        nombre = str(f.proveedor or "").strip().upper()
        clave = _nombre_clave(f.proveedor)
        actividad = (actividades.get(clave) or {}).get("actividad") or ""
        # Primero lo que ya se decidió antes para ese proveedor; después su
        # ACTIVIDAD ECONÓMICA según el SRI; después la clasificación que tenga en
        # Gastos; y por último la pista del nombre, que es la más pobre.
        rubros[PORTAL_PREFIJO + serie] = (
            aprendidos.get(clave)
            or (_rubro_sugerido(actividad) if actividad else RUBRO_VACIO)
            or _rubro_sugerido(clasif.get(nombre) or nombre))

    sol = _guardar_solicitud(
        sb, user_id, body.client_id, body.tipo_beneficiario, body.porcentaje_discapacidad,
        [PORTAL_PREFIJO + f["serie"] for f in filas], rubros,
        None, body.mes, body.anio, portal_filas=filas, exigir_rubro=False)
    sin_rubro = sum(1 for k in rubros.values() if not k)
    return {**sol, "comprobantes": len(filas), "sin_rubro": sin_rubro}


class LoteIn(BaseModel):
    client_id: str
    tipo_beneficiario: str = "tercera_edad"
    porcentaje_discapacidad: Optional[float] = None
    # Meses a preparar de una: [{"mes": 1, "anio": 2026}, ...]
    periodos: List[Dict[str, int]]


@router.post("/solicitudes/lote")
async def guardar_lote(body: LoteIn, user_id: str = Depends(get_current_user)):
    """Prepara de una sola vez la solicitud de VARIOS meses anteriores.

    Toma todos los comprobantes de cada mes y les asigna el tipo de gasto que
    sugiere la clasificación del proveedor. Los meses en los que algún
    comprobante quede sin tipo de gasto NO se guardan: se devuelven como
    `revisar` para que el usuario los complete a mano, porque el tipo de gasto
    es un dato que se declara y no se puede adivinar."""
    sb = get_supabase_client()
    assert_client_owner(body.client_id, user_id)
    _validar_beneficiario(body.tipo_beneficiario, body.porcentaje_discapacidad)
    if not body.periodos:
        raise HTTPException(status_code=400, detail="Marca al menos un mes.")

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,estado,fecha,clasificacion"
    ).eq("client_id", body.client_id))
    por_mes: Dict[tuple, List[dict]] = {}
    for i in invs:
        if (i.get("estado") or "OK") != "OK":
            continue
        m, a = mes_anio_de_fecha(i.get("fecha"))
        if m and a:
            por_mes.setdefault((a, m), []).append(i)

    hechas, revisar = [], []
    for p in body.periodos:
        mes, anio = int(p.get("mes") or 0), int(p.get("anio") or 0)
        etiqueta = f"{_NOMBRE_MES.get(mes, mes)} {anio}"
        lote = por_mes.get((anio, mes)) or []
        if not lote:
            revisar.append({"mes": mes, "anio": anio, "etiqueta": etiqueta,
                            "motivo": "No hay comprobantes cargados en ese mes."})
            continue
        try:
            sol = _guardar_solicitud(
                sb, user_id, body.client_id, body.tipo_beneficiario,
                body.porcentaje_discapacidad, [i["id"] for i in lote],
                {i["id"]: _rubro_sugerido(i.get("clasificacion")) for i in lote},
                mes=mes, anio=anio)
            hechas.append({"mes": mes, "anio": anio, "etiqueta": etiqueta,
                           "solicitud_id": sol["id"], "comprobantes": sol["items_count"],
                           "monto_solicitado": sol["monto_solicitado"]})
        except HTTPException as e:
            revisar.append({"mes": mes, "anio": anio, "etiqueta": etiqueta,
                            "motivo": str(e.detail)})

    return {
        "preparadas": hechas,
        "revisar": revisar,
        "total_comprobantes": sum(h["comprobantes"] for h in hechas),
        "total_solicitado": round(sum(_num(h["monto_solicitado"]) for h in hechas), 2),
    }


@router.get("/solicitudes")
async def listar_solicitudes(
    client_id: str = Query(...),
    user_id: str = Depends(get_current_user),
):
    """Historial del CONTRIBUYENTE (todos sus períodos, no solo el client_id dado)."""
    sb = get_supabase_client()
    assert_client_owner(client_id, user_id)
    cl = sb.table("clients").select("identificacion").eq("id", client_id).execute().data
    if not cl:
        raise HTTPException(status_code=404, detail="Cliente no existe")
    ident = cl[0].get("identificacion")
    hermanos = sb.table("clients").select("id").eq("identificacion", ident).execute().data or []
    ids = [h["id"] for h in hermanos] or [client_id]
    rows = sb.table("devoluciones_iva_solicitudes").select("*").in_(
        "client_id", ids).order("anio", desc=True).order("mes", desc=True).execute().data or []
    return {"data": rows}


class EstadoIn(BaseModel):
    estado: str
    observaciones: Optional[str] = None


def _solicitud_propia(sb, solicitud_id: str, user_id: str) -> dict:
    rows = sb.table("devoluciones_iva_solicitudes").select("*").eq("id", solicitud_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Solicitud no encontrada")
    assert_client_owner(rows[0]["client_id"], user_id)
    return rows[0]


@router.put("/solicitudes/{solicitud_id}")
async def cambiar_estado(solicitud_id: str, body: EstadoIn, user_id: str = Depends(get_current_user)):
    if body.estado not in ESTADOS:
        raise HTTPException(status_code=400, detail=f"Estado inválido: {sorted(ESTADOS)}")
    sb = get_supabase_client()
    _solicitud_propia(sb, solicitud_id, user_id)
    upd = {"estado": body.estado}
    if body.observaciones is not None:
        upd["observaciones"] = body.observaciones
    sb.table("devoluciones_iva_solicitudes").update(upd).eq("id", solicitud_id).execute()
    return {"ok": True, "estado": body.estado}


@router.get("/solicitudes/{solicitud_id}/envio")
async def payload_envio(solicitud_id: str, user_id: str = Depends(get_current_user)):
    """Datos de la solicitud listos para llevarla al portal del SRI.

    Es lo que consume el bajador/enviador que corre DENTRO de la sesión del SRI
    (el navegador del contribuyente): claves de acceso, rubro y montos. Desde acá
    no se puede llamar al SRI —requiere la sesión del portal—, así que la app
    entrega el paquete y el script lo carga en el formulario."""
    sb = get_supabase_client()
    sol = _solicitud_propia(sb, solicitud_id, user_id)
    items = _items_de(sb, solicitud_id)
    cl = sb.table("clients").select(
        "identificacion,nombre,periodicidad,periodo_semestre").eq(
        "id", sol["client_id"]).execute().data
    c = cl[0] if cl else {}
    pfreq = (c.get("periodicidad") or "mensual")
    return {
        "solicitud_id": sol["id"],
        "contribuyente": {"identificacion": c.get("identificacion", ""), "nombre": c.get("nombre", "")},
        "periodo": {
            "mes": sol.get("mes"), "anio": sol.get("anio"),
            "periodicidad": pfreq, "semestre": c.get("periodo_semestre"),
            "etiqueta": etiqueta_periodo(sol.get("mes"), sol.get("anio"), pfreq, c.get("periodo_semestre")),
        },
        "beneficiario": {
            "tipo": sol.get("tipo_beneficiario"),
            "porcentaje_discapacidad": sol.get("porcentaje_discapacidad"),
        },
        "totales": {
            "base": _num(sol.get("total_base")),
            "iva": _num(sol.get("total_iva")),
            "tope": _num(sol.get("tope_mensual")),
            "solicitado": _num(sol.get("monto_solicitado")),
        },
        "detalle_meses": sol.get("detalle_meses") or [],
        "estado": sol.get("estado"),
        "items": [
            {
                "clave_acceso": it.get("unique_id"),
                # El portal lista los comprobantes por serie, no por clave: es
                # con esto que el enviador encuentra la fila que le corresponde.
                "serie": it.get("factura_numero"),
                "fecha": it.get("fecha"),
                "ruc_proveedor": it.get("ruc_proveedor"),
                "proveedor": it.get("nombre_proveedor"),
                "rubro": it.get("rubro") or RUBRO_VACIO,
                "rubro_label": RUBRO_LABEL.get(it.get("rubro") or "", "Sin asignar"),
                # Código del combo "Tipo de gasto" del portal (1..5).
                "rubro_sri": RUBRO_SRI.get(it.get("rubro") or "", ""),
                "base": _num(it.get("base")),
                "iva": _num(it.get("iva")),
                "total": _num(it.get("total")),
            }
            for it in sorted(items, key=lambda x: (x.get("fecha") or ""))
        ],
    }


class EnvioIn(BaseModel):
    """Lo que confirmó el portal del SRI al presentar la solicitud.

    Todo es opcional: si no se informa, se asume que el SRI procesó lo mismo que
    se marcó acá. Pero conviene cargarlo, porque el portal trabaja con su propio
    listado filtrado y puede haber procesado menos comprobantes de los marcados."""
    comprobantes: Optional[int] = None
    monto: Optional[float] = None
    fecha_carga: Optional[str] = None   # "06-08-2026 13:52:14" o ISO
    mensaje: Optional[str] = None       # constancia textual del portal


def _fecha_carga_iso(txt) -> Optional[str]:
    """Normaliza la fecha/hora de carga del SRI (dd-mm-aaaa hh:mm:ss) a ISO."""
    s = str(txt or "").strip()
    if not s:
        return None
    for fmt in ("%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            continue
    return s  # ya venía en ISO (o algo que Postgres sepa leer)


@router.post("/solicitudes/{solicitud_id}/enviar")
async def marcar_enviada(solicitud_id: str, body: Optional[EnvioIn] = None,
                         user_id: str = Depends(get_current_user)):
    """Deja constancia de lo PRESENTADO al SRI y devuelve el reporte del envío.

    El envío en sí ocurre en el portal (sesión del contribuyente); acá se guarda
    qué aceptó: cuántos comprobantes procesó y por cuánto, con la fecha de carga
    y el mensaje del portal. Eso es lo que después alimenta el reporte."""
    sb = get_supabase_client()
    sol = _solicitud_propia(sb, solicitud_id, user_id)
    if not (sol.get("detalle_meses") is not None or sol.get("monto_solicitado")):
        raise HTTPException(status_code=400, detail="La solicitud no tiene monto a solicitar.")

    items = _items_de(sb, solicitud_id)
    b = body or EnvioIn()
    enviados = int(b.comprobantes) if b.comprobantes is not None else len(items)
    monto = _num(b.monto) if b.monto is not None else _num(sol.get("monto_solicitado"))

    sb.table("devoluciones_iva_solicitudes").update({
        "estado": "presentada",
        "presentada_at": "now()",
        "comprobantes_enviados": enviados,
        "monto_enviado": monto,
        "fecha_carga_sri": _fecha_carga_iso(b.fecha_carga),
        "sri_mensaje": b.mensaje,
    }).eq("id", solicitud_id).execute()

    registrar(actor_user_id=user_id, action="update", module="declaraciones",
              entity="Devolución IVA enviada al SRI", client_id=sol["client_id"],
              cantidad=enviados,
              metadata={"monto": monto, "mes": sol.get("mes"), "anio": sol.get("anio"),
                        "marcados": len(items), "mensaje": b.mensaje})

    # Reporte del envío: qué se marcó acá vs. qué procesó el SRI, y a qué tipo
    # de gasto se direccionó cada dólar (que es lo que el portal pide fila a fila).
    por_rubro = {}
    for it in items:
        k = it.get("rubro") or RUBRO_VACIO
        acc = por_rubro.setdefault(k, {"rubro": k, "label": RUBRO_LABEL.get(k, "Sin asignar"),
                                       "comprobantes": 0, "iva": 0.0})
        acc["comprobantes"] += 1
        acc["iva"] += _num(it.get("iva"))
    return {
        "ok": True,
        "estado": "presentada",
        "reporte": {
            "periodo": {"mes": sol.get("mes"), "anio": sol.get("anio"),
                        "etiqueta": f"{_NOMBRE_MES.get(int(sol.get('mes') or 0), '')} {sol.get('anio')}"},
            "comprobantes_marcados": len(items),
            "comprobantes_procesados": enviados,
            "monto_solicitado": _num(sol.get("monto_solicitado")),
            "monto_procesado": monto,
            "diferencia": round(_num(sol.get("monto_solicitado")) - monto, 2),
            "fecha_carga": b.fecha_carga,
            "mensaje": b.mensaje,
            "por_rubro": [{**v, "iva": round(v["iva"], 2)} for v in por_rubro.values()],
        },
    }


@router.get("/reporte")
async def reporte(
    client_id: Optional[str] = None,
    anio: Optional[int] = None,
    user_id: str = Depends(get_current_user),
):
    """Reporte de devoluciones: qué se procesó y presentó, y por cuánto.

    Sin `client_id` sale el consolidado de todos los contribuyentes que el
    usuario puede ver según su rol; con `client_id`, el de ese contribuyente."""
    from tenancy import visible_clients
    sb = get_supabase_client()

    if client_id:
        assert_client_owner(client_id, user_id)
        cl = sb.table("clients").select("id,identificacion,nombre").eq(
            "id", client_id).execute().data or []
    else:
        cl = visible_clients(user_id, "id,identificacion,nombre")
    por_id = {str(c["id"]): c for c in cl}
    if not por_id:
        return {"filas": [], "totales": {"solicitudes": 0, "comprobantes": 0, "monto": 0.0}}

    q = sb.table("devoluciones_iva_solicitudes").select("*").in_("client_id", list(por_id))
    if anio:
        q = q.eq("anio", int(anio))
    sols = q.order("anio", desc=True).order("mes", desc=True).execute().data or []

    filas = []
    for s in sols:
        c = por_id.get(str(s["client_id"])) or {}
        presentada = s.get("estado") in ("presentada", "aprobada")
        procesados = s.get("comprobantes_enviados")
        filas.append({
            "solicitud_id": s["id"],
            "identificacion": c.get("identificacion", ""),
            "contribuyente": c.get("nombre", ""),
            "mes": s.get("mes"),
            "anio": s.get("anio"),
            "periodo": f"{_NOMBRE_MES.get(int(s.get('mes') or 0), '')} {s.get('anio')}",
            "beneficiario": ("Discapacidad" if s.get("tipo_beneficiario") == "discapacidad"
                             else "Adulto mayor"),
            "estado": s.get("estado"),
            "total_iva": _num(s.get("total_iva")),
            "tope": _num(s.get("tope_mensual")),
            "monto_solicitado": _num(s.get("monto_solicitado")),
            "comprobantes_procesados": procesados,
            "monto_procesado": _num(s.get("monto_enviado")) if s.get("monto_enviado") is not None else None,
            "fecha_carga_sri": s.get("fecha_carga_sri"),
            "presentada_at": s.get("presentada_at"),
            "mensaje": s.get("sri_mensaje"),
            "presentada": presentada,
        })

    presentadas = [f for f in filas if f["presentada"]]
    return {
        "filas": filas,
        "totales": {
            "solicitudes": len(filas),
            "presentadas": len(presentadas),
            "comprobantes": sum(int(f["comprobantes_procesados"] or 0) for f in presentadas),
            "monto": round(sum(_num(f["monto_procesado"] if f["monto_procesado"] is not None
                                    else f["monto_solicitado"]) for f in presentadas), 2),
            "pendiente": round(sum(f["monto_solicitado"] for f in filas if not f["presentada"]), 2),
        },
    }


@router.delete("/solicitudes/{solicitud_id}")
async def eliminar_solicitud(solicitud_id: str, user_id: str = Depends(get_current_user)):
    sb = get_supabase_client()
    _solicitud_propia(sb, solicitud_id, user_id)
    sb.table("devoluciones_iva_solicitudes").delete().eq("id", solicitud_id).execute()
    return {"ok": True}


@router.get("/solicitudes/{solicitud_id}/export/excel")
async def exportar_excel(solicitud_id: str, user_id: str = Depends(get_current_user)):
    """Excel con el detalle de la solicitud, para presentar/archivar."""
    import xlsxwriter

    sb = get_supabase_client()
    sol = _solicitud_propia(sb, solicitud_id, user_id)
    items = _items_de(sb, solicitud_id)
    cl = sb.table("clients").select(
        "identificacion,nombre,periodicidad,periodo_semestre").eq(
        "id", sol["client_id"]).execute().data
    ident = cl[0].get("identificacion", "") if cl else ""
    nombre = cl[0].get("nombre", "") if cl else ""
    pfreq = (cl[0].get("periodicidad") if cl else None) or "mensual"
    psem = cl[0].get("periodo_semestre") if cl else None
    periodo_txt = etiqueta_periodo(sol.get("mes"), sol.get("anio"), pfreq, psem)

    output = io.BytesIO()
    wb = xlsxwriter.Workbook(output, {"in_memory": True})
    ws = wb.add_worksheet("SOLICITUD")
    fmt_title = wb.add_format({"bold": True, "font_size": 14})
    fmt_lbl = wb.add_format({"bold": True})
    fmt_head = wb.add_format({"bold": True, "bg_color": "#007bff", "font_color": "white", "border": 1})
    fmt_cell = wb.add_format({"border": 1})
    fmt_num = wb.add_format({"num_format": "$#,##0.00", "border": 1})
    fmt_num_b = wb.add_format({"num_format": "$#,##0.00", "border": 1, "bold": True})

    tipo_lbl = ("Adulto mayor" if sol["tipo_beneficiario"] == "tercera_edad"
                else f"Discapacidad ({sol.get('porcentaje_discapacidad') or ''}%)")
    ws.write(0, 0, "SOLICITUD DE DEVOLUCIÓN DE IVA", fmt_title)
    ws.write(1, 0, "Contribuyente:", fmt_lbl); ws.write(1, 1, f"{ident} — {nombre}")
    ws.write(2, 0, "Período:", fmt_lbl); ws.write(2, 1, periodo_txt)
    ws.write(3, 0, "Beneficiario:", fmt_lbl); ws.write(3, 1, tipo_lbl)
    ws.write(4, 0, "Estado:", fmt_lbl); ws.write(4, 1, sol.get("estado", ""))

    heads = ["Fecha", "RUC proveedor", "Proveedor", "Tipo de gasto", "Clasificación",
             "Clave de acceso", "Base gravada", "IVA", "Total"]
    row0 = 6
    for i, h in enumerate(heads):
        ws.write(row0, i, h, fmt_head)
    r = row0 + 1
    # Ordenados por rubro y fecha: así el detalle se lee por tipo de gasto.
    for it in sorted(items, key=lambda x: (RUBRO_LABEL.get(x.get("rubro") or "", "zz"), x.get("fecha") or "")):
        ws.write(r, 0, it.get("fecha") or "", fmt_cell)
        ws.write(r, 1, it.get("ruc_proveedor") or "", fmt_cell)
        ws.write(r, 2, it.get("nombre_proveedor") or "", fmt_cell)
        ws.write(r, 3, RUBRO_LABEL.get(it.get("rubro") or "", "—"), fmt_cell)
        ws.write(r, 4, it.get("clasificacion") or "", fmt_cell)
        ws.write(r, 5, it.get("unique_id") or "", fmt_cell)
        ws.write_number(r, 6, _num(it.get("base")), fmt_num)
        ws.write_number(r, 7, _num(it.get("iva")), fmt_num)
        ws.write_number(r, 8, _num(it.get("total")), fmt_num)
        r += 1

    ws.write(r, 5, "TOTALES", fmt_head)
    ws.write_number(r, 6, _num(sol.get("total_base")), fmt_num_b)
    ws.write_number(r, 7, _num(sol.get("total_iva")), fmt_num_b)
    r += 2
    ws.write(r, 5, "Tope del período:", fmt_lbl); ws.write_number(r, 6, _num(sol.get("tope_mensual")), fmt_num_b)
    ws.write(r + 1, 5, "IVA a solicitar:", fmt_lbl); ws.write_number(r + 1, 6, _num(sol.get("monto_solicitado")), fmt_num_b)

    # Resumen por tipo de gasto (a dónde se direccionó cada comprobante).
    r += 4
    ws.write(r, 0, "RESUMEN POR TIPO DE GASTO", fmt_lbl)
    r += 1
    for i, h in enumerate(["Tipo de gasto", "Comprobantes", "Base gravada", "IVA"]):
        ws.write(r, i, h, fmt_head)
    r += 1
    por_rubro = {}
    for it in items:
        acc = por_rubro.setdefault(it.get("rubro") or RUBRO_VACIO, {"n": 0, "base": 0.0, "iva": 0.0})
        acc["n"] += 1
        acc["base"] += _num(it.get("base"))
        acc["iva"] += _num(it.get("iva"))
    for rubro in RUBROS:
        acc = por_rubro.get(rubro["key"])
        if not acc:
            continue
        ws.write(r, 0, rubro["label"], fmt_cell)
        ws.write_number(r, 1, acc["n"], fmt_cell)
        ws.write_number(r, 2, round(acc["base"], 2), fmt_num)
        ws.write_number(r, 3, round(acc["iva"], 2), fmt_num)
        r += 1

    # Desglose por mes: el tope es mensual, así que un semestre lleva seis topes.
    detalle = sol.get("detalle_meses") or []
    if len(detalle) > 1:
        r += 2
        ws.write(r, 0, "DESGLOSE POR MES (el tope es mensual)", fmt_lbl)
        r += 1
        for i, h in enumerate(["Mes", "Comprobantes", "Base gravada", "IVA", "Tope del mes", "A solicitar", "Excedente"]):
            ws.write(r, i, h, fmt_head)
        r += 1
        for d in detalle:
            ws.write(r, 0, _NOMBRE_MES.get(int(d.get("mes") or 0), ""), fmt_cell)
            ws.write_number(r, 1, int(d.get("comprobantes") or 0), fmt_cell)
            ws.write_number(r, 2, _num(d.get("base")), fmt_num)
            ws.write_number(r, 3, _num(d.get("iva")), fmt_num)
            ws.write_number(r, 4, _num(d.get("tope")), fmt_num)
            ws.write_number(r, 5, _num(d.get("solicitar")), fmt_num_b)
            ws.write_number(r, 6, _num(d.get("excedente")), fmt_num)
            r += 1

    ws.set_column(0, 0, 14); ws.set_column(1, 1, 15); ws.set_column(2, 2, 32)
    ws.set_column(3, 3, 18); ws.set_column(4, 4, 20); ws.set_column(5, 5, 52)
    ws.set_column(6, 8, 13)
    wb.close()
    output.seek(0)

    sufijo = (f"{sol['anio']}-S{int(psem) if psem else semestre_de_mes(sol.get('mes') or 1)}"
              if pfreq == "semestral" else f"{sol['anio']}-{int(sol['mes']):02d}")
    fname = f"DevolucionIVA_{ident}_{sufijo}.xlsx"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
