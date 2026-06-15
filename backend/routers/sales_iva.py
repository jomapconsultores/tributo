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
from services.sri_service import extract_claves_from_txt, descargar_multiples_xmls
from services.activity import registrar
from database import fetch_all
from tenancy import assert_client_owner, shared_client_ids

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
        if client_id:
            assert_client_owner(client_id, user_id)
            data = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).eq("client_id", client_id).order("fecha", desc=True))
        else:
            own = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).eq("user_id", user_id).order("fecha", desc=True))
            sids = shared_client_ids(user_id)
            if sids:
                sh = fetch_all(lambda: supabase.table("sales_iva").select(COLUMNS).in_("client_id", sids).order("fecha", desc=True))
                seen, data = set(), []
                for r in own + sh:
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        data.append(r)
            else:
                data = own
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
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="ingresos_iva",
                      entity="Ingresos IVA (ventas)", client_id=client_id, cantidad=new_count)
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


def _guardar_venta(supabase, client_id, user_id, xml_content):
    """Parsea un XML de venta y lo guarda en sales_iva. Devuelve uno de:
    'new' | 'dup' | 'err' | 'con_ice'. (Reutilizado por process-xml y process-txt)."""
    parsed = parse_venta_xml(xml_content)
    if parsed is None:
        return "err", None
    if parsed.get("error") == "CON_ICE":
        return "con_ice", parsed.get("factura_numero")
    guardar_xml_original(supabase, user_id, client_id, "ingreso_iva", xml_content)
    try:
        supabase.table("sales_iva").insert({"client_id": client_id, "user_id": user_id, **parsed}).execute()
        return "new", None
    except Exception as e:
        msg = str(e).lower()
        if "duplicate" in msg or "unique" in msg:
            return "dup", None
        print(f"Error insertando sales_iva {parsed.get('unique_id')}: {e}")
        return "err", None


@router.post("/process-txt")
async def process_txt(
    file: UploadFile = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user),
):
    """Sube el reporte/lista de claves de acceso (TXT del SRI: 'Descargar reporte'
    de Comprobantes Emitidos). Extrae las claves de 49 dígitos, baja los XML por
    el servicio del SRI (con reintentos) y los guarda como ingresos (ventas)."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        content = (await file.read()).decode("utf-8", errors="ignore")
        claves = extract_claves_from_txt(content)
        if not claves:
            raise HTTPException(status_code=400, detail="No se encontraron claves de acceso (49 dígitos) en el archivo.")
        xmls, no_descargadas = descargar_multiples_xmls(list(claves), max_workers=8, max_rondas=3)

        new_count = dup_count = err_count = rej_count = 0
        rechazadas = []
        for xml_content in xmls:
            estado, info = _guardar_venta(supabase, client_id, user_id, xml_content)
            if estado == "new":
                new_count += 1
            elif estado == "dup":
                dup_count += 1
            elif estado == "con_ice":
                rej_count += 1
                rechazadas.append({"archivo": "(XML del SRI)", "factura": info, "motivo": "Contiene ICE — subir en módulo ICE-XML"})
            else:
                err_count += 1
        if new_count:
            registrar(actor_user_id=user_id, action="upload", module="ingresos_iva",
                      entity="Ingresos IVA (ventas)", client_id=client_id, cantidad=new_count)
        return {
            "ok": True,
            "total_claves": len(claves),
            "descargadas": len(xmls),
            "no_descargadas": no_descargadas,
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
        supabase.table("sales_iva").delete().eq("client_id", client_id).execute()
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
