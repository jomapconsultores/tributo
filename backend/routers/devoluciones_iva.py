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
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import get_current_user
from database import get_supabase_client, fetch_all
from tenancy import assert_client_owner
from services.periodo import periodo_cliente, etiqueta_periodo
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
    base = _num(inv.get("base_15")) + _num(inv.get("base_5"))
    iva = _num(inv.get("iva_15")) + _num(inv.get("iva_5"))
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


def _solicitud_de_periodo(sb, client_id: str, mes, anio) -> Optional[dict]:
    q = sb.table("devoluciones_iva_solicitudes").select("*").eq("client_id", client_id)
    if mes and anio:
        q = q.eq("mes", int(mes)).eq("anio", int(anio))
    rows = q.execute().data or []
    return rows[0] if rows else None


def _items_de(sb, solicitud_id: str) -> List[dict]:
    return sb.table("devoluciones_iva_items").select("*").eq(
        "solicitud_id", solicitud_id).execute().data or []


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
    pmes, panio = periodo_cliente(sb, client_id)

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,estado,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_0,base_15,iva_15,base_5,iva_5,total"
    ).eq("client_id", client_id).order("fecha", desc=True))
    comps = [_resumen_comprobante(i) for i in invs if (i.get("estado") or "OK") == "OK"]

    solicitud = _solicitud_de_periodo(sb, client_id, pmes, panio)
    seleccionados = []
    if solicitud:
        items = _items_de(sb, solicitud["id"])
        solicitud["items"] = items
        seleccionados = [it["invoice_id"] for it in items if it.get("invoice_id")]

    return {
        "periodo": etiqueta_periodo(pmes, panio),
        "mes": pmes,
        "anio": panio,
        "comprobantes": comps,
        "solicitud": solicitud,
        "seleccionados": seleccionados,
    }


class SolicitudIn(BaseModel):
    client_id: str
    tipo_beneficiario: str = "tercera_edad"
    porcentaje_discapacidad: Optional[float] = None
    invoice_ids: List[str]
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

    pmes, panio = periodo_cliente(sb, body.client_id)
    if not pmes or not panio:
        raise HTTPException(status_code=400,
                            detail="El cliente no tiene período (mes/año) definido.")

    invs = fetch_all(lambda: sb.table("invoices").select(
        "id,unique_id,fecha,ruc_proveedor,nombre_proveedor,clasificacion,"
        "base_15,iva_15,base_5,iva_5,total"
    ).eq("client_id", body.client_id).in_("id", body.invoice_ids))
    if not invs:
        raise HTTPException(status_code=400, detail="Los comprobantes marcados no existen en este cliente.")

    items = [_resumen_comprobante(i) for i in invs]
    total_base = round(sum(i["base"] for i in items), 2)
    total_iva = round(sum(i["iva"] for i in items), 2)
    tope = _tope_mensual(panio, body.tipo_beneficiario, body.porcentaje_discapacidad)
    monto = round(min(total_iva, tope), 2)

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
        "total_base": total_base,
        "total_iva": total_iva,
        "tope_mensual": tope,
        "monto_solicitado": monto,
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
            "base": it["base"],
            "iva": it["iva"],
            "total": it["total"],
        }
        for it in items
    ]).execute()

    registrar(actor_user_id=user_id, action="create", module="declaraciones",
              entity="Solicitud devolución IVA", client_id=body.client_id,
              cantidad=len(items))
    return {**solicitud, "items_count": len(items), "excedente": round(max(0.0, total_iva - tope), 2)}


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
    cl = sb.table("clients").select("identificacion,nombre").eq("id", sol["client_id"]).execute().data
    ident = cl[0].get("identificacion", "") if cl else ""
    nombre = cl[0].get("nombre", "") if cl else ""

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
    ws.write(2, 0, "Período:", fmt_lbl); ws.write(2, 1, f"{int(sol['mes']):02d}/{sol['anio']}")
    ws.write(3, 0, "Beneficiario:", fmt_lbl); ws.write(3, 1, tipo_lbl)
    ws.write(4, 0, "Estado:", fmt_lbl); ws.write(4, 1, sol.get("estado", ""))

    heads = ["Fecha", "RUC proveedor", "Proveedor", "Clasificación", "Clave de acceso", "Base gravada", "IVA", "Total"]
    row0 = 6
    for i, h in enumerate(heads):
        ws.write(row0, i, h, fmt_head)
    r = row0 + 1
    for it in items:
        ws.write(r, 0, it.get("fecha") or "", fmt_cell)
        ws.write(r, 1, it.get("ruc_proveedor") or "", fmt_cell)
        ws.write(r, 2, it.get("nombre_proveedor") or "", fmt_cell)
        ws.write(r, 3, it.get("clasificacion") or "", fmt_cell)
        ws.write(r, 4, it.get("unique_id") or "", fmt_cell)
        ws.write_number(r, 5, _num(it.get("base")), fmt_num)
        ws.write_number(r, 6, _num(it.get("iva")), fmt_num)
        ws.write_number(r, 7, _num(it.get("total")), fmt_num)
        r += 1

    ws.write(r, 4, "TOTALES", fmt_head)
    ws.write_number(r, 5, _num(sol.get("total_base")), fmt_num_b)
    ws.write_number(r, 6, _num(sol.get("total_iva")), fmt_num_b)
    r += 2
    ws.write(r, 4, "Tope mensual:", fmt_lbl); ws.write_number(r, 5, _num(sol.get("tope_mensual")), fmt_num_b)
    ws.write(r + 1, 4, "IVA a solicitar:", fmt_lbl); ws.write_number(r + 1, 5, _num(sol.get("monto_solicitado")), fmt_num_b)

    ws.set_column(0, 0, 12); ws.set_column(1, 1, 15); ws.set_column(2, 2, 32)
    ws.set_column(3, 3, 20); ws.set_column(4, 4, 52); ws.set_column(5, 7, 13)
    wb.close()
    output.seek(0)

    fname = f"DevolucionIVA_{ident}_{sol['anio']}-{int(sol['mes']):02d}.xlsx"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
