from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all
from services.ice_parser import parse_ice_invoice
from services.ice_calc import full_report
from services.ice_export import generate_ice_excel, generate_ice_pdf
from services.ice_anexo import generar_anexo_ice, anexo_rows, catalogo_con_codigos
from services.ice_data import TAX_DB
from services.codigos_ice import buscar_tokens_bd
from services.compradores import extraer_compradores, upsert_compradores
from services.xml_store import guardar_xml_original
from tenancy import assert_client_owner, shared_client_ids

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
async def list_ice(user_id: str = Depends(get_current_user), client_id: Optional[str] = Query(None)):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            data = fetch_all(lambda: supabase.table("ice_sales").select(ICE_COLUMNS).eq("client_id", client_id).order("fecha", desc=True))
        else:
            own = fetch_all(lambda: supabase.table("ice_sales").select(ICE_COLUMNS).eq("user_id", user_id).order("fecha", desc=True))
            sids = shared_client_ids(user_id)
            if sids:
                sh = fetch_all(lambda: supabase.table("ice_sales").select(ICE_COLUMNS).in_("client_id", sids).order("fecha", desc=True))
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
        new_count = dup_count = err_count = 0
        compradores_xml = {}
        for file in files:
            xml_content = (await file.read()).decode("utf-8", errors="ignore")
            registros = parse_ice_invoice(xml_content)
            if not registros:
                err_count += 1
                continue
            guardar_xml_original(supabase, user_id, client_id, "ingreso_ice", xml_content)
            for c in extraer_compradores(registros):
                compradores_xml[c["ruc"]] = c
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
        # Guarda los clientes compradores (aparte de la tabla clients)
        try:
            c = _cliente(supabase, client_id)
            upsert_compradores(supabase, user_id, c.get("identificacion"), list(compradores_xml.values()))
        except Exception as e:
            print(f"No se pudieron guardar los compradores: {e}")
        return {"new": new_count, "duplicates": dup_count, "errors": err_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/report")
async def report(
    user_id: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
    anio: str = Query("2026"),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        else:
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("user_id", user_id))
        return full_report(rows, anio)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-move")
async def bulk_move(payload: BulkMove, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(payload.client_id, user_id)
        moved = skipped = 0
        for iid in payload.ids:
            try:
                supabase.table("ice_sales").update({"client_id": payload.client_id}).eq("id", iid).eq("user_id", user_id).execute()
                moved += 1
            except Exception as e:
                print(f"No se pudo mover ICE {iid}: {e}")
                skipped += 1
        return {"moved": moved, "skipped": skipped}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkIds, user_id: str = Depends(get_current_user)):
    try:
        if not payload.ids:
            return {"deleted": 0}
        supabase = get_supabase_client()
        supabase.table("ice_sales").delete().in_("id", payload.ids).eq("user_id", user_id).execute()
        return {"deleted": len(payload.ids)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_ice(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_sales").delete().eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
            q = q.eq("client_id", client_id)
        else:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        q.execute()
        return {"message": "ICE eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{ice_id}")
async def delete_ice(ice_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("ice_sales").delete().eq("id", ice_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _cliente(supabase, client_id):
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    return c.data[0] if c.data else {}


def _catalogo_cliente(supabase, identificacion, user_id):
    if not identificacion:
        return []
    r = supabase.table("client_products").select("nombre,cod_prod_ice").eq("identificacion", identificacion).eq("user_id", user_id).execute()
    return r.data or []


def _buscador_oficial(supabase):
    """Buscador de marcas en el catálogo oficial de Códigos ICE, para resolver
    productos que no están en el catálogo del cliente ni en el base."""
    return lambda q: buscar_tokens_bd(supabase, q, 20)


@router.get("/catalog")
async def catalog(_: str = Depends(get_current_user)):
    return {"catalogo": catalogo_con_codigos()}


@router.get("/anexo-rows")
async def get_anexo_rows(
    client_id: str = Query(...),
    act_import: str = Query("02"),
    tipo: str = Query("ICE"),
    user_id: str = Depends(get_current_user),
):
    """Filas del anexo (ICE o PVP, a elegir) de un cliente, para el editor de Anexo PVP+ICE."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        c = _cliente(supabase, client_id)
        cat = _catalogo_cliente(supabase, c.get("identificacion"), user_id)
        return anexo_rows(rows, c, c.get("periodo_anio") or 2026, c.get("periodo_mes") or 1, act_import, cat,
                          buscar_oficial=_buscador_oficial(supabase), tipo=tipo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/anexo")
async def generar_anexo(
    client_id: str = Query(...),
    act_import: str = Query("02"),
    user_id: str = Depends(get_current_user),
):
    """Genera el anexo ICE (XML) para subir al SRI, agrupado por cliente y producto."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        c = _cliente(supabase, client_id)
        anio = c.get("periodo_anio") or 2026
        mes = c.get("periodo_mes") or 1
        cat = _catalogo_cliente(supabase, c.get("identificacion"), user_id)
        return generar_anexo_ice(rows, c, anio, mes, act_import, cat,
                                 buscar_oficial=_buscador_oficial(supabase))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/pdf")
async def export_pdf_endpoint(
    client_id: Optional[str] = Query(None),
    anio: str = Query("2026"),
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        else:
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("user_id", user_id))
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
    user_id: str = Depends(get_current_user),
):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("client_id", client_id))
        else:
            rows = fetch_all(lambda: supabase.table("ice_sales").select("*").eq("user_id", user_id))
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
