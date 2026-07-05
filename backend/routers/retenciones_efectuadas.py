"""Retenciones EFECTUADAS: el cliente actúa como AGENTE de retención hacia sus
propios proveedores (retiene IVA y Renta al pagarles, emite el comprobante).

Distinto del módulo "retentions" (retenciones que le HACEN al cliente). El IVA
retenido aquí alimenta una sección nueva dentro de la declaración de IVA
(Formulario 104); el Renta retenido alimenta la declaración nueva "103"
(Formulario 103 — Retenciones en la Fuente de Impuesto a la Renta).

Solo aplica a clientes marcados clients.es_agente_retencion = true (el SRI
designa quién es agente de retención; no todos los contribuyentes lo son)."""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all, es_error_duplicado
from services.retention_parser import parse_retention_xml
from services.retention_export import generate_retention_excel
from services.xml_store import guardar_xml_original
from services.periodo import periodo_cliente, es_de_otro_periodo, etiqueta_periodo
from tenancy import assert_client_owner, fetch_visible_rows, filter_ids_by_tenancy
from services.activity import registrar

router = APIRouter(prefix="/api/retenciones-efectuadas", tags=["retenciones_efectuadas"])

REF_COLUMNS = (
    "id,client_id,unique_id,estado,fecha,ruc_proveedor,nombre_proveedor,"
    "nro_comprobante,periodo_fiscal,base_renta,porc_renta,ret_renta,concepto_renta,"
    "base_iva,porc_iva,ret_iva,ret_isd,total_retenido"
)

# Catálogo de conceptos de retención de Renta (etiquetas, no casilleros — el
# SRI renumera los casilleros del Formulario 103 periódicamente; el contador
# debe verificar el casillero exacto antes de presentar, igual que ya se
# advierte para ICE en declaracion.py).
#
# Porcentajes vigentes desde el 1-mar-2026 según la Resolución
# NAC-DGERCGC26-00000009 del SRI (deroga NAC-DGERCGC24-00000008). Esquema de
# 7 tramos: 0%, 1%, 1.75%, 2%, 3%, 5%, 10% — ya NO existen los tramos 2.75%
# ni 8% de resoluciones anteriores. Verificar el texto vigente antes de
# declarar si esta resolución fuera reformada.
CONCEPTOS_RENTA = [
    {"key": "honorarios", "label": "Honorarios profesionales y dietas (persona natural)", "porc": 10},
    {"key": "servicios_intelecto", "label": "Servicios donde predomina el intelecto (persona natural)", "porc": 10},
    {"key": "servicios_profesionales_sociedad", "label": "Servicios profesionales de sociedad con profesional titulado", "porc": 5},
    {"key": "servicios_mano_obra", "label": "Servicios donde predomina la mano de obra (persona natural)", "porc": 3},
    {"key": "bienes_muebles", "label": "Transferencia de bienes muebles de naturaleza corporal", "porc": 2},
    {"key": "arrendamiento", "label": "Arrendamiento de bienes inmuebles", "porc": 10},
    {"key": "arrendamiento_mercantil", "label": "Arrendamiento mercantil (leasing)", "porc": 2},
    {"key": "seguros", "label": "Seguros y reaseguros (sobre el valor total de la prima)", "porc": 2},
    {"key": "rendimientos", "label": "Rendimientos financieros / intereses (caso general: préstamos, depósitos, sociedades o personas naturales)", "porc": 3},
    {"key": "rendimientos_bancarios", "label": "Intereses pagados a bancos/entidades supervisadas SB-SEPS", "porc": 0},
    {"key": "transporte", "label": "Transporte privado de pasajeros o carga", "porc": 1},
    {"key": "agropecuario_productor", "label": "Compra de bienes agropecuarios directa al productor", "porc": 1},
    {"key": "agropecuario_comercializador", "label": "Compra de bienes agropecuarios vía comercializador (no productor)", "porc": 1.75},
    {"key": "construccion", "label": "Actividades de construcción", "porc": 2},
    {"key": "otros_1", "label": "Otras retenciones aplicables 1%", "porc": 1},
    {"key": "otros_2", "label": "Otras retenciones aplicables 2%", "porc": 2},
    {"key": "otros_3", "label": "Otras retenciones aplicables 3% (regla general — pagos sin % específico)", "porc": 3},
    {"key": "otros_5", "label": "Otras retenciones aplicables 5%", "porc": 5},
    {"key": "otros_10", "label": "Otras retenciones aplicables 10%", "porc": 10},
    {"key": "otro", "label": "Otro concepto (especificar)", "porc": None},
]


class RefRow(BaseModel):
    client_id: str
    fecha: Optional[str] = None
    ruc_proveedor: Optional[str] = ""
    nombre_proveedor: Optional[str] = ""
    nro_comprobante: Optional[str] = ""
    base_renta: Optional[float] = 0
    porc_renta: Optional[float] = 0
    concepto_renta: Optional[str] = None
    base_iva: Optional[float] = 0
    porc_iva: Optional[float] = 0


class RefUpdate(BaseModel):
    fecha: Optional[str] = None
    ruc_proveedor: Optional[str] = None
    nombre_proveedor: Optional[str] = None
    nro_comprobante: Optional[str] = None
    base_renta: Optional[float] = None
    porc_renta: Optional[float] = None
    concepto_renta: Optional[str] = None
    base_iva: Optional[float] = None
    porc_iva: Optional[float] = None


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]


def _totales(base_renta, porc_renta, base_iva, porc_iva):
    ret_renta = round((base_renta or 0) * (porc_renta or 0) / 100, 2)
    ret_iva = round((base_iva or 0) * (porc_iva or 0) / 100, 2)
    return ret_renta, ret_iva, round(ret_renta + ret_iva, 2)


def _assert_agente_retencion(supabase, client_id):
    """El SRI designa quién es agente de retención; no todos los contribuyentes
    lo son. Antes solo se filtraba en el frontend — se valida también aquí para
    no cargar retenciones efectuadas a un cliente que no está marcado como tal."""
    c = supabase.table("clients").select("es_agente_retencion").eq("id", client_id).execute().data
    if not c or not c[0].get("es_agente_retencion"):
        raise HTTPException(status_code=400, detail="Este cliente no está marcado como agente de retención")


@router.get("/conceptos-renta")
async def conceptos_renta(_: str = Depends(get_current_user)):
    return {"data": CONCEPTOS_RENTA}


@router.get("/")
async def list_ref(
    user_id: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            data = fetch_all(lambda: supabase.table("retenciones_efectuadas").select(REF_COLUMNS).eq("client_id", client_id).order("fecha", desc=True))
        else:
            data = fetch_visible_rows(supabase, "retenciones_efectuadas", REF_COLUMNS, user_id, order_col="fecha", desc=True)
        return {"data": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_ref(entry: RefRow, user_id: str = Depends(get_current_user)):
    """Carga manual de un comprobante de retención emitido por el cliente."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        _assert_agente_retencion(supabase, entry.client_id)
        ret_renta, ret_iva, total = _totales(entry.base_renta, entry.porc_renta, entry.base_iva, entry.porc_iva)
        data = entry.dict()
        client_id = data.pop("client_id")
        data.update({
            "ret_renta": ret_renta, "ret_iva": ret_iva, "total_retenido": total,
            "unique_id": f"manual-{client_id}-{entry.ruc_proveedor}-{entry.nro_comprobante}-{entry.fecha}",
        })
        res = supabase.table("retenciones_efectuadas").insert({
            "client_id": client_id, "user_id": user_id, **data,
        }).execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        if es_error_duplicado(e):
            raise HTTPException(status_code=409, detail="Ya existe un comprobante con esos datos para este cliente")
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{row_id}")
async def update_ref(row_id: str, entry: RefUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        row = supabase.table("retenciones_efectuadas").select("client_id,base_renta,porc_renta,base_iva,porc_iva").eq("id", row_id).execute().data
        if not row:
            raise HTTPException(status_code=404, detail="No encontrado")
        assert_client_owner(row[0]["client_id"], user_id)
        data = {k: v for k, v in entry.dict().items() if v is not None}
        if any(k in data for k in ("base_renta", "porc_renta", "base_iva", "porc_iva")):
            merged = {**row[0], **data}
            ret_renta, ret_iva, total = _totales(merged["base_renta"], merged["porc_renta"], merged["base_iva"], merged["porc_iva"])
            data.update({"ret_renta": ret_renta, "ret_iva": ret_iva, "total_retenido": total})
        res = supabase.table("retenciones_efectuadas").update(data).eq("id", row_id).execute()
        return res.data[0] if res.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    """Sube comprobantes de retención EMITIDOS por el cliente a sus proveedores
    (mismo esquema XML que una retención recibida — se reusa el mismo parser;
    aquí lo que nos importa como contraparte es el sujeto retenido, no el emisor)."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        _assert_agente_retencion(supabase, client_id)
        pmes, panio = periodo_cliente(supabase, client_id)
        new_count = dup_count = err_count = fp_count = 0
        fuera_periodo = []
        for file in files:
            xml_content = (await file.read()).decode("utf-8", errors="ignore")
            parsed = parse_retention_xml(xml_content)
            if not parsed:
                err_count += 1
                continue
            if es_de_otro_periodo(parsed.get("fecha"), pmes, panio):
                fp_count += 1
                fuera_periodo.append({"archivo": file.filename, "factura": parsed.get("nro_comprobante"), "fecha": parsed.get("fecha")})
                continue
            guardar_xml_original(supabase, user_id, client_id, "retencion_efectuada", xml_content)
            row = {
                "unique_id": parsed["unique_id"],
                "estado": parsed["estado"],
                "fecha": parsed["fecha"],
                "ruc_proveedor": parsed.get("ruc_sujeto"),
                "nro_comprobante": parsed["nro_comprobante"],
                "periodo_fiscal": parsed["periodo_fiscal"],
                "base_renta": parsed["base_renta"], "porc_renta": parsed["porc_renta"], "ret_renta": parsed["ret_renta"],
                "base_iva": parsed["base_iva"], "porc_iva": parsed["porc_iva"], "ret_iva": parsed["ret_iva"],
                "ret_isd": parsed["ret_isd"], "total_retenido": parsed["total_retenido"],
            }
            try:
                supabase.table("retenciones_efectuadas").insert({"client_id": client_id, "user_id": user_id, **row}).execute()
                new_count += 1
            except Exception as e:
                if es_error_duplicado(e):
                    dup_count += 1
                else:
                    print(f"Error insertando retención efectuada {row.get('unique_id')}: {e}")
                    err_count += 1
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="agente_retencion",
                      entity="Retenciones efectuadas", client_id=client_id, cantidad=new_count)
        return {"new": new_count, "duplicates": dup_count, "errors": err_count,
                "fuera_de_periodo": fp_count, "fuera_periodo": fuera_periodo,
                "periodo": etiqueta_periodo(pmes, panio)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_ref(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            supabase.table("retenciones_efectuadas").delete().eq("client_id", client_id).execute()
        else:
            supabase.table("retenciones_efectuadas").delete().eq("user_id", user_id).execute()
        return {"message": "Retenciones efectuadas eliminadas"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(payload: BulkMove, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(payload.client_id, user_id)
        _assert_agente_retencion(supabase, payload.client_id)
        if not payload.ids:
            return {"moved": 0, "skipped": 0}
        ok_ids = filter_ids_by_tenancy(supabase, "retenciones_efectuadas", payload.ids, user_id)
        if ok_ids:
            supabase.table("retenciones_efectuadas").update({"client_id": payload.client_id}).in_("id", ok_ids).execute()
        return {"moved": len(ok_ids), "skipped": len(payload.ids) - len(ok_ids)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIds, user_id: str = Depends(get_current_user)):
    try:
        if not payload.ids:
            return {"deleted": 0}
        supabase = get_supabase_client()
        ok_ids = filter_ids_by_tenancy(supabase, "retenciones_efectuadas", payload.ids, user_id)
        if ok_ids:
            supabase.table("retenciones_efectuadas").delete().in_("id", ok_ids).execute()
        return {"deleted": len(ok_ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{row_id}")
async def delete_ref(row_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        row = supabase.table("retenciones_efectuadas").select("client_id").eq("id", row_id).execute().data
        if not row:
            raise HTTPException(status_code=404, detail="No encontrado")
        assert_client_owner(row[0]["client_id"], user_id)
        supabase.table("retenciones_efectuadas").delete().eq("id", row_id).execute()
        return {"message": "Eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/excel")
async def export_excel_endpoint(
    client_id: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            rows = fetch_all(lambda: supabase.table("retenciones_efectuadas").select("*").eq("client_id", client_id).order("fecha", desc=True))
        else:
            rows = fetch_all(lambda: supabase.table("retenciones_efectuadas").select("*").eq("user_id", user_id).order("fecha", desc=True))
        # generate_retention_excel espera las columnas de "retentions" (ruc_emisor/
        # agente_retencion como contraparte); acá la contraparte es el proveedor.
        filas = [{**r, "ruc_emisor": r.get("ruc_proveedor"), "agente_retencion": r.get("nombre_proveedor")} for r in rows]
        excel_bytes = generate_retention_excel(filas)

        label = "retenciones_efectuadas"
        if client_id:
            c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
            if c.data:
                row = c.data[0]
                mes = str(row.get('periodo_mes') or '').zfill(2)
                anio = str(row.get('periodo_anio') or '')
                periodo = f"{anio}-{mes}" if anio and mes != '00' else ''
                label = f"{row.get('identificacion','')}_{row.get('nombre','')}_RET_EFECTUADAS"
                if periodo:
                    label = f"{label}_{periodo}"
                label = label.replace(" ", "_")

        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
