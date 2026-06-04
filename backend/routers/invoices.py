from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.sri_service import extract_claves_from_txt, descargar_multiples_xmls
from services.xml_parser import parse_xml_invoice
from services.export_service import generate_excel, generate_pdf

router = APIRouter(prefix="/api/invoices", tags=["invoices"])

# Columnas que se devuelven al frontend (vista completa estilo escritorio)
INVOICE_COLUMNS = (
    "id,client_id,unique_id,estado,fecha,ruc_proveedor,factura_numero,nombre_proveedor,"
    "clasificacion,concepto,forma_pago,tarjeta_credito,no_objeto_iva,exento_iva,"
    "base_0,base_15,iva_15,base_5,iva_5,desc_info,desc_manual,total,"
    "base_15_original,total_original,es_yanbal,destinatario,ruc_comprador"
)


class InvoiceUpdate(BaseModel):
    clasificacion: Optional[str] = None
    desc_manual: Optional[float] = None
    tarjeta_credito: Optional[str] = None
    forma_pago: Optional[str] = None
    concepto: Optional[str] = None
    ruc_proveedor: Optional[str] = None
    nombre_proveedor: Optional[str] = None
    fecha: Optional[str] = None


def _load_maps(supabase):
    class_response = supabase.table("classification_map").select("ruc, categoria").execute()
    classification_map = {row['ruc']: row['categoria'] for row in class_response.data or []}
    memory_response = supabase.table("card_memory").select("mem_key, tarjeta_credito").execute()
    card_memory = {row['mem_key']: row['tarjeta_credito'] for row in memory_response.data or []}
    return classification_map, card_memory


def _store_invoice(supabase, client_id: str, user_id: str, invoice: dict) -> str:
    """Inserta una factura para un cliente. Devuelve 'new' | 'duplicate' | 'error'."""
    unique_id = invoice.pop('unique_id')
    try:
        supabase.table("invoices").insert({
            "client_id": client_id,
            "user_id": user_id,
            "unique_id": unique_id,
            **invoice
        }).execute()
        return "new"
    except Exception as e:
        if "duplicate" in str(e).lower() or "unique" in str(e).lower():
            return "duplicate"
        print(f"Error insertando factura {unique_id}: {e}")
        return "error"


@router.get("/")
async def list_invoices(
    _: str = Depends(get_current_user),
    client_id: Optional[str] = Query(None),
    skip: int = 0,
    limit: int = 500
):
    try:
        supabase = get_supabase_client()

        count_q = supabase.table("invoices").select("id", count="exact")
        data_q = supabase.table("invoices").select(INVOICE_COLUMNS)

        if client_id:
            count_q = count_q.eq("client_id", client_id)
            data_q = data_q.eq("client_id", client_id)

        total = count_q.execute().count or 0
        response = data_q.order("fecha", desc=True).range(skip, skip + limit - 1).execute()

        return {
            "data": response.data or [],
            "total": total,
            "page": skip // limit + 1,
            "limit": limit
        }
    except Exception as e:
        print(f"Error in list_invoices: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/process-txt")
async def process_txt(
    file: UploadFile = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user)
):
    try:
        content = await file.read()
        txt_content = content.decode('utf-8', errors='ignore')

        claves = extract_claves_from_txt(txt_content)
        if not claves:
            raise HTTPException(status_code=400, detail="No se encontraron claves válidas en el archivo")

        claves_list = list(claves)
        xmls, errores = descargar_multiples_xmls(claves_list, max_workers=10)

        supabase = get_supabase_client()
        classification_map, card_memory = _load_maps(supabase)

        new_count = dup_count = err_count = 0
        for xml_content in xmls:
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                err_count += 1
                continue
            result = _store_invoice(supabase, client_id, user_id, invoice)
            if result == "new":
                new_count += 1
            elif result == "duplicate":
                dup_count += 1
            else:
                err_count += 1

        return {
            "processed": len(xmls),
            "new": new_count,
            "duplicates": dup_count,
            "errors": errores + err_count,
            "total_claves": len(claves)
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error in process_txt: {e}")
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        classification_map, card_memory = _load_maps(supabase)

        new_count = dup_count = err_count = 0
        for file in files:
            xml_content = (await file.read()).decode('utf-8', errors='ignore')
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                err_count += 1
                continue
            result = _store_invoice(supabase, client_id, user_id, invoice)
            if result == "new":
                new_count += 1
            elif result == "duplicate":
                dup_count += 1
            else:
                err_count += 1

        return {"new": new_count, "duplicates": dup_count, "errors": err_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_invoices(
    client_id: Optional[str] = Query(None),
    _: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        q = supabase.table("invoices").delete()
        if client_id:
            q = q.eq("client_id", client_id)
        else:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        q.execute()
        return {"message": "Facturas eliminadas"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{invoice_id}")
async def update_invoice(
    invoice_id: str,
    update: InvoiceUpdate,
    _: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        update_data = {k: v for k, v in update.dict().items() if v is not None}

        # Si cambia el descuento manual, recalcular Base 15%, IVA 15% y Total
        if "desc_manual" in update_data:
            current = supabase.table("invoices").select(
                "base_15_original,base_0,base_5,iva_5,exento_iva,no_objeto_iva"
            ).eq("id", invoice_id).execute()
            if current.data:
                row = current.data[0]
                base_15_orig = float(row.get("base_15_original") or 0)
                desc = float(update_data["desc_manual"] or 0)
                new_base_15 = max(0.0, base_15_orig - desc)
                new_iva_15 = round(new_base_15 * 0.15, 2)
                total = round(
                    float(row.get("base_0") or 0) + float(row.get("base_5") or 0)
                    + float(row.get("iva_5") or 0) + float(row.get("exento_iva") or 0)
                    + float(row.get("no_objeto_iva") or 0) + new_base_15 + new_iva_15,
                    2
                )
                update_data["base_15"] = round(new_base_15, 2)
                update_data["iva_15"] = new_iva_15
                update_data["total"] = total

        # Normalizar mayúsculas en clasificación
        if "clasificacion" in update_data and update_data["clasificacion"]:
            update_data["clasificacion"] = update_data["clasificacion"].upper()

        response = supabase.table("invoices").update(update_data).eq("id", invoice_id).execute()
        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{invoice_id}")
async def delete_invoice(invoice_id: str, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("invoices").delete().eq("id", invoice_id).execute()
        return {"message": "Deleted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _fetch_for_export(supabase, client_id: Optional[str]):
    q = supabase.table("invoices").select("*")
    if client_id:
        q = q.eq("client_id", client_id)
    return q.order("fecha", desc=True).execute().data or []


def _client_label(supabase, client_id: Optional[str]) -> str:
    if not client_id:
        return "facturas"
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    if c.data:
        row = c.data[0]
        mes = str(row.get('periodo_mes') or '').zfill(2)
        anio = str(row.get('periodo_anio') or '')
        periodo = f"{anio}-{mes}" if anio and mes != '00' else ''
        label = f"{row.get('identificacion','')}_{row.get('nombre','')}"
        if periodo:
            label = f"{label}_{periodo}"
        return label.replace(" ", "_")
    return "facturas"


@router.get("/export/excel")
async def export_excel_endpoint(
    client_id: Optional[str] = Query(None),
    _: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        data = _fetch_for_export(supabase, client_id)
        excel_bytes = generate_excel(data)
        label = _client_label(supabase, client_id)
        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/pdf")
async def export_pdf_endpoint(
    client_id: Optional[str] = Query(None),
    _: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        data = _fetch_for_export(supabase, client_id)
        pdf_bytes = generate_pdf(data)
        label = _client_label(supabase, client_id)
        return StreamingResponse(
            iter([pdf_bytes]),
            media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={label}.pdf"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
