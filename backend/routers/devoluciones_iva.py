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
# Es un catálogo CERRADO (a diferencia de la clasificación de Gastos, que es
# texto libre por proveedor) para que el detalle y los totales sean comparables.
RUBROS = [
    {"key": "vivienda",           "label": "Vivienda"},
    {"key": "salud",              "label": "Salud"},
    {"key": "alimentacion",       "label": "Alimentación"},
    {"key": "vestimenta",         "label": "Vestimenta"},
    {"key": "educacion",          "label": "Educación"},
    {"key": "turismo",            "label": "Turismo"},
    {"key": "servicios_basicos",  "label": "Servicios básicos"},
    {"key": "otros",              "label": "Otros"},
]
RUBRO_KEYS = {r["key"] for r in RUBROS}
RUBRO_LABEL = {r["key"]: r["label"] for r in RUBROS}
RUBRO_DEFECTO = "otros"

# Pistas para PROPONER el rubro a partir de la clasificación que ya tiene el
# proveedor en Gastos. Es solo una sugerencia: el usuario la puede cambiar.
_PISTAS_RUBRO = [
    ("salud",             ("SALUD", "MEDIC", "FARMAC", "CLINIC", "HOSPITAL", "LABORATORIO", "ODONT", "OPTIC")),
    ("alimentacion",      ("ALIMENT", "SUPERMERCAD", "COMISARIAT", "VIVER", "PANADER", "RESTAURANT", "COMIDA")),
    ("vivienda",          ("VIVIENDA", "ARRIEND", "ALQUILER", "CONDOMIN", "FERRETER", "MUEBL", "HOGAR")),
    ("vestimenta",        ("VESTIMENTA", "ROPA", "CALZAD", "TEXTIL", "BOUTIQUE")),
    ("educacion",         ("EDUCAC", "COLEGIO", "ESCUELA", "UNIVERSID", "CAPACITAC", "LIBRER", "UTILES")),
    ("turismo",           ("TURISM", "HOTEL", "HOSPEDAJ", "AGENCIA DE VIAJ", "PASAJE")),
    ("servicios_basicos", ("SERVICIO", "LUZ", "ELECTRIC", "AGUA", "TELEFON", "INTERNET", "TELECOM", "GAS")),
]


def _rubro_sugerido(clasificacion) -> str:
    """Rubro propuesto según la clasificación del proveedor en Gastos."""
    texto = str(clasificacion or "").strip().upper()
    if not texto:
        return RUBRO_DEFECTO
    for rubro, pistas in _PISTAS_RUBRO:
        if any(p in texto for p in pistas):
            return rubro
    return RUBRO_DEFECTO


def _rubro_valido(valor, clasificacion=None) -> str:
    v = str(valor or "").strip().lower()
    if v in RUBRO_KEYS:
        return v
    return _rubro_sugerido(clasificacion)


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
    """Catálogo de tipos de gasto a los que se direcciona cada comprobante."""
    return {"rubros": RUBROS, "defecto": RUBRO_DEFECTO}


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


@router.get("/comprobantes")
async def comprobantes(
    client_id: str = Query(...),
    user_id: str = Depends(get_current_user),
):
    """Comprobantes del período del cliente + la solicitud guardada (si hay)."""
    sb = get_supabase_client()
    assert_client_owner(client_id, user_id)
    pmes, panio, pfreq, psem = periodo_cliente_ext(sb, client_id)
    meses = _meses_del_periodo(pmes, pfreq, psem)

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,estado,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_0,base_15,iva_15,base_8,iva_8,base_5,iva_5,total"
    ).eq("client_id", client_id).order("fecha", desc=True))
    comps = [_resumen_comprobante(i) for i in invs if (i.get("estado") or "OK") == "OK"]

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


@router.post("/solicitudes")
async def guardar_solicitud(body: SolicitudIn, user_id: str = Depends(get_current_user)):
    """Crea/reemplaza la solicitud del período del cliente (queda en borrador)."""
    sb = get_supabase_client()
    assert_client_owner(body.client_id, user_id)
    if body.tipo_beneficiario not in BASE_MAX_RBU:
        raise HTTPException(status_code=400, detail=f"Tipo inválido: {sorted(BASE_MAX_RBU)}")
    if body.tipo_beneficiario == "discapacidad":
        if not body.porcentaje_discapacidad or not (30 <= float(body.porcentaje_discapacidad) <= 100):
            raise HTTPException(status_code=400,
                                detail="Para discapacidad indica el porcentaje (30 a 100).")
    if not body.invoice_ids:
        raise HTTPException(status_code=400, detail="Marca al menos un comprobante.")

    pmes, panio, pfreq, psem = periodo_cliente_ext(sb, body.client_id)
    if not pmes or not panio:
        raise HTTPException(status_code=400,
                            detail="El cliente no tiene período (mes/año) definido.")
    meses = _meses_del_periodo(pmes, pfreq, psem)

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_15,iva_15,base_8,iva_8,base_5,iva_5,total"
    ).eq("client_id", body.client_id).in_("id", body.invoice_ids))
    if not invs:
        raise HTTPException(status_code=400, detail="Los comprobantes marcados no existen en este cliente.")

    items = [_resumen_comprobante(i) for i in invs]
    pedidos = body.rubros or {}
    for it in items:
        it["rubro"] = _rubro_valido(pedidos.get(it["id"]), it.get("clasificacion"))

    # El tope es MENSUAL: se aplica mes a mes (un período semestral lleva seis).
    calc = _detalle_por_mes(items, meses, panio, body.tipo_beneficiario,
                            body.porcentaje_discapacidad)

    # Reemplazo total: la solicitud del período es una sola (UNIQUE client+mes+anio).
    previa = _solicitud_de_periodo(sb, body.client_id, pmes, panio)
    if previa:
        sb.table("devoluciones_iva_solicitudes").delete().eq("id", previa["id"]).execute()

    res = sb.table("devoluciones_iva_solicitudes").insert({
        "user_id": user_id,
        "client_id": body.client_id,
        "mes": int(pmes),
        "anio": int(panio),
        "tipo_beneficiario": body.tipo_beneficiario,
        "porcentaje_discapacidad": body.porcentaje_discapacidad,
        "total_base": calc["total_base"],
        "total_iva": calc["total_iva"],
        "tope_mensual": calc["tope_periodo"],
        "monto_solicitado": calc["monto"],
        "detalle_meses": calc["detalle"],
        "estado": "borrador",
        "observaciones": body.observaciones,
    }).execute()
    solicitud = res.data[0]

    sb.table("devoluciones_iva_items").insert([
        {
            "solicitud_id": solicitud["id"],
            "invoice_id": it["id"],
            "unique_id": it["unique_id"],
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
              entity="Solicitud devolución IVA", client_id=body.client_id,
              cantidad=len(items))
    return {**solicitud, "items_count": len(items), "excedente": calc["excedente"],
            "detalle_meses": calc["detalle"], "tope_mes": calc["tope_mes"]}


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
                "fecha": it.get("fecha"),
                "ruc_proveedor": it.get("ruc_proveedor"),
                "proveedor": it.get("nombre_proveedor"),
                "rubro": it.get("rubro") or RUBRO_DEFECTO,
                "rubro_label": RUBRO_LABEL.get(it.get("rubro") or RUBRO_DEFECTO, ""),
                "base": _num(it.get("base")),
                "iva": _num(it.get("iva")),
                "total": _num(it.get("total")),
            }
            for it in sorted(items, key=lambda x: (x.get("fecha") or ""))
        ],
    }


@router.post("/solicitudes/{solicitud_id}/enviar")
async def marcar_enviada(solicitud_id: str, user_id: str = Depends(get_current_user)):
    """Deja constancia de que la solicitud se envió al SRI: estado `presentada`
    con la fecha. El envío en sí ocurre en el portal (sesión del contribuyente)."""
    sb = get_supabase_client()
    sol = _solicitud_propia(sb, solicitud_id, user_id)
    if not (sol.get("detalle_meses") is not None or sol.get("monto_solicitado")):
        raise HTTPException(status_code=400, detail="La solicitud no tiene monto a solicitar.")
    sb.table("devoluciones_iva_solicitudes").update({
        "estado": "presentada",
        "presentada_at": "now()",
    }).eq("id", solicitud_id).execute()
    registrar(actor_user_id=user_id, action="update", module="declaraciones",
              entity="Devolución IVA enviada al SRI", client_id=sol["client_id"],
              metadata={"monto": _num(sol.get("monto_solicitado"))})
    return {"ok": True, "estado": "presentada"}


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
        acc = por_rubro.setdefault(it.get("rubro") or RUBRO_DEFECTO, {"n": 0, "base": 0.0, "iva": 0.0})
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
