from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.retention_parser import parse_retention_xml
from services.retention_export import generate_retention_excel
from services.xml_store import guardar_xml_original
from services.periodo import periodo_cliente, es_de_otro_periodo, etiqueta_periodo
from database import fetch_all, fetch_in, es_error_duplicado
from tenancy import assert_client_owner, visible_client_ids, fetch_visible_rows, filter_ids_by_tenancy
from services.activity import registrar

router = APIRouter(prefix="/api/retentions", tags=["retentions"])


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]

RETENTION_COLUMNS = (
    "id,client_id,unique_id,estado,fecha,ruc_emisor,agente_retencion,"
    "nro_comprobante,periodo_fiscal,base_renta,porc_renta,ret_renta,"
    "base_iva,porc_iva,ret_iva,ret_isd,total_retenido,ruc_sujeto"
)


def _store_retention(supabase, client_id: str, user_id: str, ret: dict) -> str:
    try:
        supabase.table("retentions").insert({
            "client_id": client_id,
            "user_id": user_id,
            **ret,
        }).execute()
        return "new"
    except Exception as e:
        if es_error_duplicado(e):
            return "duplicate"
        print(f"Error insertando retención {ret.get('unique_id')}: {e}")
        return "error"


@router.get("/")
async def list_retentions(
    user_id: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            data = fetch_all(lambda: supabase.table("retentions").select(RETENTION_COLUMNS).eq("client_id", client_id).order("fecha", desc=True))
        else:
            data = fetch_visible_rows(supabase, "retentions", RETENTION_COLUMNS, user_id, order_col="fecha", desc=True)
        return {"data": data}
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
        assert_client_owner(client_id, user_id)
        pmes, panio = periodo_cliente(supabase, client_id)
        new_count = dup_count = err_count = fp_count = 0
        fuera_periodo = []
        for file in files:
            xml_content = (await file.read()).decode("utf-8", errors="ignore")
            ret = parse_retention_xml(xml_content)
            if not ret:
                err_count += 1
                continue
            if es_de_otro_periodo(ret.get("fecha"), pmes, panio):
                fp_count += 1
                fuera_periodo.append({"archivo": file.filename, "factura": ret.get("nro_comprobante"), "fecha": ret.get("fecha")})
                continue
            guardar_xml_original(supabase, user_id, client_id, "retencion", xml_content)
            result = _store_retention(supabase, client_id, user_id, ret)
            if result == "new":
                new_count += 1
            elif result == "duplicate":
                dup_count += 1
            else:
                err_count += 1
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="retenciones",
                      entity="Retenciones", client_id=client_id, cantidad=new_count)
        return {"new": new_count, "duplicates": dup_count, "errors": err_count,
                "fuera_de_periodo": fp_count, "fuera_periodo": fuera_periodo,
                "periodo": etiqueta_periodo(pmes, panio)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_retentions(
    client_id: Optional[str] = Query(None),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            supabase.table("retentions").delete().eq("client_id", client_id).execute()
        else:
            supabase.table("retentions").delete().eq("user_id", user_id).execute()
        return {"message": "Retenciones eliminadas"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(payload: BulkMove, user_id: str = Depends(get_current_user)):
    """Reasigna varias retenciones a otro cliente. Omite las que chocarían con
    una retención ya existente (misma clave) en el cliente destino."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(payload.client_id, user_id)
        if not payload.ids:
            return {"moved": 0, "skipped": 0}
        ok_ids = filter_ids_by_tenancy(supabase, "retentions", payload.ids, user_id)
        if ok_ids:
            supabase.table("retentions").update({"client_id": payload.client_id}).in_("id", ok_ids).execute()
        return {"moved": len(ok_ids), "skipped": len(payload.ids) - len(ok_ids)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIds, user_id: str = Depends(get_current_user)):
    """Elimina varias retenciones por id."""
    try:
        if not payload.ids:
            return {"deleted": 0}
        supabase = get_supabase_client()
        ok_ids = filter_ids_by_tenancy(supabase, "retentions", payload.ids, user_id)
        if ok_ids:
            supabase.table("retentions").delete().in_("id", ok_ids).execute()
        return {"deleted": len(ok_ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{retention_id}")
async def delete_retention(retention_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        row = supabase.table("retentions").select("client_id").eq("id", retention_id).execute().data
        if not row:
            raise HTTPException(status_code=404, detail="No encontrada")
        assert_client_owner(row[0]["client_id"], user_id)
        supabase.table("retentions").delete().eq("id", retention_id).execute()
        return {"message": "Eliminada"}
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
            rows = fetch_all(lambda: supabase.table("retentions").select("*").eq("client_id", client_id).order("fecha", desc=True))
        else:
            rows = fetch_all(lambda: supabase.table("retentions").select("*").eq("user_id", user_id).order("fecha", desc=True))
        excel_bytes = generate_retention_excel(rows)

        label = "retenciones"
        if client_id:
            c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
            if c.data:
                row = c.data[0]
                mes = str(row.get('periodo_mes') or '').zfill(2)
                anio = str(row.get('periodo_anio') or '')
                periodo = f"{anio}-{mes}" if anio and mes != '00' else ''
                label = f"{row.get('identificacion','')}_{row.get('nombre','')}_RET"
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
