from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.ice_parser import parse_ice_invoice
from services.ice_calc import full_report
from services.ice_export import generate_ice_excel, generate_ice_pdf
from services.ice_anexo import generar_anexo_ice, anexo_rows, catalogo_con_codigos
from services.ice_data import TAX_DB

router = APIRouter(prefix="/api/ice", tags=["ice"])

ICE_COLUMNS = (
    "id,client_id,unique_id,estado,fecha,tipo_id_cliente,id_cliente,razon_social_cliente,"
    "codigo_producto,nombre_producto,cod_marca,presentacion,capacidad,unidad,grado_alcoholico,"
    "cod_impuesto,tipo_producto,es_pack,botellas_por_caja,cantidad_cajas,unidades_botellas,"
    "precio_unitario,precio_total_sin_impuesto,precio_por_caja,precio_por_botella,"
    "base_ice,valor_ice,base_iva,valor_iva,importe_total"
)


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]


@router.get("/tax-years")
async def tax_years(_: str = Depends(get_current_user)):
    return {"years": list(TAX_DB.keys()), "params": TAX_DB}


@router.get("/")
async def list_ice(_: str = Depends(get_current_user), client_id: Optional[str] = Query(None)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").select(ICE_COLUMNS)
        if client_id:
            q = q.eq("client_id", client_id)
        res = q.order("fecha", desc=True).execute()
        return {"data": res.data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        new_count = dup_count = err_count = 0
        for file in files:
            xml_content = (await file.read()).decode("utf-8", errors="ignore")
            registros = parse_ice_invoice(xml_content)
            if not registros:
                err_count += 1
                continue
            for reg in registros:
                try:
                    supabase.table("ice_sales").insert({
                        "client_id": client_id, "user_id": user_id, **reg
                    }).execute()
                    new_count += 1
                except Exception as e:
                    if "duplicate" in str(e).lower() or "unique" in str(e).lower():
                        dup_count += 1
                    else:
                        print(f"Error insertando ICE {reg.get('unique_id')}: {e}")
                        err_count += 1
        return {"new": new_count, "duplicates": dup_count, "errors": err_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/report")
async def report(
    _: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
    anio: str = Query("2026"),
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").select("*")
        if client_id:
            q = q.eq("client_id", client_id)
        rows = q.execute().data or []
        return full_report(rows, anio)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(payload: BulkMove, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        moved = skipped = 0
        for iid in payload.ids:
            try:
                supabase.table("ice_sales").update({"client_id": payload.client_id}).eq("id", iid).execute()
                moved += 1
            except Exception as e:
                print(f"No se pudo mover ICE {iid}: {e}")
                skipped += 1
        return {"moved": moved, "skipped": skipped}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIds, _: str = Depends(get_current_user)):
    try:
        if not payload.ids:
            return {"deleted": 0}
        supabase = get_supabase_client()
        supabase.table("ice_sales").delete().in_("id", payload.ids).execute()
        return {"deleted": len(payload.ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_ice(client_id: Optional[str] = Query(None), _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").delete()
        if client_id:
            q = q.eq("client_id", client_id)
        else:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        q.execute()
        return {"message": "ICE eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{ice_id}")
async def delete_ice(ice_id: str, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("ice_sales").delete().eq("id", ice_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _cliente(supabase, client_id):
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    return c.data[0] if c.data else {}


def _catalogo_cliente(supabase, identificacion):
    if not identificacion:
        return []
    r = supabase.table("client_products").select("nombre,cod_prod_ice").eq("identificacion", identificacion).execute()
    return r.data or []


@router.get("/catalog")
async def catalog(_: str = Depends(get_current_user)):
    return {"catalogo": catalogo_con_codigos()}


@router.get("/anexo-rows")
async def get_anexo_rows(
    client_id: str = Query(...),
    act_import: str = Query("02"),
    _: str = Depends(get_current_user),
):
    """Filas del anexo ICE de un cliente, listas para el editor de Anexo PVP+ICE."""
    try:
        supabase = get_supabase_client()
        rows = supabase.table("ice_sales").select("*").eq("client_id", client_id).execute().data or []
        c = _cliente(supabase, client_id)
        cat = _catalogo_cliente(supabase, c.get("identificacion"))
        return anexo_rows(rows, c, c.get("periodo_anio") or 2026, c.get("periodo_mes") or 1, act_import, cat)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/anexo")
async def generar_anexo(
    client_id: str = Query(...),
    act_import: str = Query("02"),
    _: str = Depends(get_current_user),
):
    """Genera el anexo ICE (XML) para subir al SRI, agrupado por cliente y producto."""
    try:
        supabase = get_supabase_client()
        rows = supabase.table("ice_sales").select("*").eq("client_id", client_id).execute().data or []
        c = _cliente(supabase, client_id)
        anio = c.get("periodo_anio") or 2026
        mes = c.get("periodo_mes") or 1
        cat = _catalogo_cliente(supabase, c.get("identificacion"))
        return generar_anexo_ice(rows, c, anio, mes, act_import, cat)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/pdf")
async def export_pdf_endpoint(
    client_id: Optional[str] = Query(None),
    anio: str = Query("2026"),
    _: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").select("*")
        if client_id:
            q = q.eq("client_id", client_id)
        rows = q.execute().data or []
        cliente = _cliente(supabase, client_id) if client_id else {}
        pdf = generate_ice_pdf(rows, anio, cliente)
        label = f"{cliente.get('identificacion','')}_{cliente.get('nombre','')}_ICE_{anio}".replace(" ", "_") if cliente else "ICE"
        return StreamingResponse(iter([pdf]), media_type="application/pdf",
                                 headers={"Content-Disposition": f"attachment; filename={label}.pdf"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/excel")
async def export_excel_endpoint(
    client_id: Optional[str] = Query(None),
    anio: str = Query("2026"),
    _: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").select("*")
        if client_id:
            q = q.eq("client_id", client_id)
        rows = q.execute().data or []
        excel_bytes = generate_ice_excel(rows, anio)
        label = "ICE"
        if client_id:
            c = supabase.table("clients").select("identificacion,nombre").eq("id", client_id).execute()
            if c.data:
                label = f"{c.data[0].get('identificacion','')}_{c.data[0].get('nombre','')}_ICE_{anio}".replace(" ", "_")
        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"},
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
