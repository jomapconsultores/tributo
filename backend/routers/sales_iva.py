"""Router para INGRESOS IVA (facturas de venta SIN ICE).

Para contribuyentes que solo declaran IVA (no ICE). Las facturas con ICE deben
ir al router /api/ice. Si una factura subida acá contiene ICE, se rechaza con
estado='CON_ICE' y se reporta en el resumen para que el usuario sepa.
"""
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.xml_parser_ventas import parse_venta_xml
from services.xml_store import guardar_xml_original
from tenancy import assert_client_owner

router = APIRouter(prefix="/api/sales-iva", tags=["sales_iva"])

COLUMNS = (
    "id,client_id,unique_id,estado,fecha,tipo_id_cliente,id_cliente,razon_social_cliente,"
    "factura_numero,no_objeto_iva,exento_iva,base_0,base_15,iva_15,base_5,iva_5,"
    "importe_total,notas,created_at"
)


class BulkMove(BaseModel):
    ids: List[str]
    client_id: str


class BulkIds(BaseModel):
    ids: List[str]


@router.get("/")
async def list_sales(user_id: str = Depends(get_current_user), client_id: Optional[str] = Query(None)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("sales_iva").select(COLUMNS).eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
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
        assert_client_owner(client_id, user_id)
        new_count = dup_count = err_count = rej_count = 0
        rechazadas = []  # facturas con ICE
        for file in files:
            xml_content = (await file.read()).decode("utf-8", errors="ignore")
            parsed = parse_venta_xml(xml_content)
            if parsed is None:
                err_count += 1
                continue
            if parsed.get("error") == "CON_ICE":
                rej_count += 1
                rechazadas.append({
                    "archivo": file.filename,
                    "factura": parsed.get("factura_numero"),
                    "motivo": parsed.get("message"),
                })
                continue
            guardar_xml_original(supabase, user_id, client_id, "ingreso_iva", xml_content)
            try:
                supabase.table("sales_iva").insert({
                    "client_id": client_id, "user_id": user_id, **parsed
                }).execute()
                new_count += 1
            except Exception as e:
                msg = str(e).lower()
                if "duplicate" in msg or "unique" in msg:
                    dup_count += 1
                else:
                    print(f"Error insertando sales_iva {parsed.get('unique_id')}: {e}")
                    err_count += 1
        return {
            "ok": True,
            "nuevas": new_count,
            "duplicadas": dup_count,
            "errores": err_count,
            "rechazadas_por_ice": rej_count,
            "rechazadas": rechazadas,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/clear")
async def clear(client_id: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        supabase.table("sales_iva").delete().eq("user_id", user_id).eq("client_id", client_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{sale_id}")
async def delete_one(sale_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("sales_iva").delete().eq("id", sale_id).eq("user_id", user_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(body: BulkMove, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(body.client_id, user_id)
        moved = skipped = 0
        for sale_id in body.ids:
            try:
                supabase.table("sales_iva").update({"client_id": body.client_id}).eq("id", sale_id).eq("user_id", user_id).execute()
                moved += 1
            except Exception:
                skipped += 1
        return {"ok": True, "moved": moved, "skipped": skipped}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(body: BulkIds, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        for sale_id in body.ids:
            supabase.table("sales_iva").delete().eq("id", sale_id).eq("user_id", user_id).execute()
        return {"ok": True, "deleted": len(body.ids)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
