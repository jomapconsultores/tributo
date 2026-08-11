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
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client, fetch_all
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
    ("alimentacion", ("ALIMENT", "SUPERMERCAD", "HIPERMERC", "COMISARIAT", "ABARROTE",
                      "MINIMARKET", "VIVER", "PANADER", "RESTAURANT", "COMIDA")),
    ("vivienda",     ("VIVIENDA", "ARRIEND", "ALQUILER", "CONDOMIN", "FERRETER", "MUEBL", "HOGAR",
                      "LUZ", "ELECTRIC", "AGUA", "TELEFON", "INTERNET", "TELECOM", "GAS")),
    ("vestimenta",   ("VESTIMENTA", "ROPA", "CALZAD", "TEXTIL", "BOUTIQUE")),
    ("educacion",    ("EDUCAC", "COLEGIO", "ESCUELA", "UNIVERSID", "CAPACITAC", "LIBRER", "UTILES")),
]


def _rubro_sugerido(clasificacion) -> str:
    """Rubro propuesto según la clasificación del proveedor en Gastos.

    Devuelve vacío cuando no hay con qué decidir: es preferible que el usuario
    elija a mandar todo a un cajón por defecto, porque el tipo de gasto es un
    dato que se declara al SRI."""
    texto = str(clasificacion or "").strip().upper()
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
        "id,mes,anio,estado,monto_solicitado,comprobantes_enviados,monto_enviado"
    ).eq("client_id", client_id).execute().data or []
    por_periodo = {(int(s["anio"]), int(s["mes"])): s for s in sols}

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

    solicitud = _solicitud_de_periodo(sb, client_id, pmes, panio)
    seleccionados = []
    rubros_guardados = {}
    if solicitud:
        items = _items_de(sb, solicitud["id"])
        solicitud["items"] = items
        seleccionados = [it["invoice_id"] for it in items if it.get("invoice_id")]
        rubros_guardados = {it["invoice_id"]: it.get("rubro") for it in items if it.get("invoice_id")}

    # Rubro de cada comprobante: el ya guardado en la solicitud manda; si no, se
    # propone uno según la clasificación del proveedor (el usuario puede cambiarlo).
    for c in comps:
        sugerido = _rubro_sugerido(c.get("clasificacion"))
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


def _validar_beneficiario(tipo: str, porcentaje):
    if tipo not in BASE_MAX_RBU:
        raise HTTPException(status_code=400, detail=f"Tipo inválido: {sorted(BASE_MAX_RBU)}")
    if tipo == "discapacidad" and (not porcentaje or not (30 <= float(porcentaje) <= 100)):
        raise HTTPException(status_code=400,
                            detail="Para discapacidad indica el porcentaje (30 a 100).")


def _guardar_solicitud(sb, user_id: str, client_id: str, tipo: str, porcentaje,
                       invoice_ids: List[str], rubros_pedidos: Optional[Dict[str, str]],
                       observaciones=None, mes=None, anio=None) -> dict:
    """Crea/reemplaza la solicitud de UN período con los comprobantes marcados.

    Lo usa tanto el guardado de una sola pantalla como el procesamiento en lote
    de varios meses; por eso vive aparte del endpoint."""
    pmes, panio, pfreq, psem, meses = _periodo_pedido(sb, client_id, mes, anio)
    if not pmes or not panio:
        raise HTTPException(status_code=400,
                            detail="El cliente no tiene período (mes/año) definido.")

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,factura_numero,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_15,iva_15,base_8,iva_8,base_5,iva_5,total"
    ).eq("client_id", client_id).in_("id", invoice_ids))
    if not invs:
        raise HTTPException(status_code=400, detail="Los comprobantes marcados no existen en este cliente.")

    items = [_resumen_comprobante(i) for i in invs]
    pedidos = rubros_pedidos or {}
    for it in items:
        it["rubro"] = _rubro_valido(pedidos.get(it["id"]), it.get("clasificacion"))

    # El tipo de gasto es obligatorio: es un dato que se declara al SRI y su
    # combo no admite vacío, así que no tiene sentido dejar pasar la solicitud.
    faltantes = _rubros_faltantes(items)
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
            "invoice_id": it["id"],
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
        body.invoice_ids, body.rubros, body.observaciones, body.mes, body.anio)


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
