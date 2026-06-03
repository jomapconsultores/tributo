from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.sri_service import extract_claves_from_txt, descargar_multiples_xmls
from services.xml_parser import parse_xml_invoice
from services.export_service import generate_excel, generate_pdf
import io

router = APIRouter(prefix="/api/invoices", tags=["invoices"])

class InvoiceUpdate(BaseModel):
    clasificacion: Optional[str] = None
    desc_manual: Optional[float] = None
    tarjeta_credito: Optional[str] = None

@router.get("/")
async def list_invoices(
    user_id: str = Depends(get_current_user),
    skip: int = 0,
    limit: int = 20
):
    try:
        supabase = get_supabase_client()

        # Get total count
        count_response = supabase.table("invoices")\
            .select("id", count="exact")\
            .eq("user_id", user_id)\
            .execute()
        total = count_response.count or 0

        # Get paginated data
        response = supabase.table("invoices")\
            .select("id,fecha,ruc_proveedor,nombre_proveedor,clasificacion,concepto,base_15,iva_15,total,estado")\
            .eq("user_id", user_id)\
            .order("created_at", desc=True)\
            .range(skip, skip + limit - 1)\
            .execute()

        return {
            "data": response.data or [],
            "total": total,
            "page": skip // limit + 1,
            "limit": limit
        }
    except Exception as e:
        print(f"Error in list_invoices: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")

@router.post("/process-txt")
async def process_txt(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user)
):
    try:
        content = await file.read()
        txt_content = content.decode('utf-8', errors='ignore')

        # Extraer claves
        claves = extract_claves_from_txt(txt_content)
        if not claves:
            raise HTTPException(status_code=400, detail="No se encontraron claves válidas")

        # Limitar a 50 claves por solicitud para evitar timeouts
        claves_list = list(claves)[:50]

        # Descargar XMLs con timeout
        xmls, errores = descargar_multiples_xmls(claves_list, max_workers=5)

        # Obtener clasificador del usuario
        supabase = get_supabase_client()
        class_response = supabase.table("classification_map")\
            .select("ruc, categoria")\
            .eq("user_id", user_id)\
            .execute()
        classification_map = {row['ruc']: row['categoria'] for row in class_response.data or []}

        # Obtener memoria de tarjetas
        memory_response = supabase.table("card_memory")\
            .select("mem_key, tarjeta_credito")\
            .eq("user_id", user_id)\
            .execute()
        card_memory = {row['mem_key']: row['tarjeta_credito'] for row in memory_response.data or []}

        # Parsear y guardar
        new_count = 0
        dup_count = 0

        for xml_content in xmls:
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                continue

            unique_id = invoice.pop('unique_id')
            _ = invoice.pop('base_15_original', None)
            _ = invoice.pop('total_original', None)

            try:
                response = supabase.table("invoices")\
                    .insert({
                        "user_id": user_id,
                        "unique_id": unique_id,
                        **invoice
                    })\
                    .execute()
                if response.data:
                    new_count += 1
            except Exception as insert_e:
                if "duplicate" in str(insert_e).lower():
                    dup_count += 1

        return {
            "processed": len(xmls),
            "new": new_count,
            "duplicates": dup_count,
            "errors": errores,
            "total_claves": len(claves)
        }
    except Exception as e:
        print(f"Error in process_txt: {e}")
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/process-xml")
async def process_xml(
    files: List[UploadFile] = File(...),
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        class_response = supabase.table("classification_map")\
            .select("ruc, categoria")\
            .eq("user_id", user_id)\
            .execute()
        classification_map = {row['ruc']: row['categoria'] for row in class_response.data}

        memory_response = supabase.table("card_memory")\
            .select("mem_key, tarjeta_credito")\
            .eq("user_id", user_id)\
            .execute()
        card_memory = {row['mem_key']: row['tarjeta_credito'] for row in memory_response.data}

        new_count = 0
        dup_count = 0

        for file in files:
            xml_content = (await file.read()).decode('utf-8', errors='ignore')
            invoice = parse_xml_invoice(xml_content, classification_map, card_memory)
            if not invoice:
                continue

            unique_id = invoice.pop('unique_id')
            _ = invoice.pop('base_15_original', None)
            _ = invoice.pop('total_original', None)

            try:
                response = supabase.table("invoices")\
                    .insert({
                        "user_id": user_id,
                        "unique_id": unique_id,
                        **invoice
                    })\
                    .execute()
                if response.data:
                    new_count += 1
            except Exception as e:
                if "duplicate" in str(e).lower():
                    dup_count += 1

        return {"new": new_count, "duplicates": dup_count}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/clear")
async def clear_invoices(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("invoices")\
            .delete()\
            .eq("user_id", user_id)\
            .execute()
        return {"message": "All invoices cleared"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.put("/{invoice_id}")
async def update_invoice(
    invoice_id: str,
    update: InvoiceUpdate,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        update_data = {k: v for k, v in update.dict().items() if v is not None}
        response = supabase.table("invoices")\
            .update(update_data)\
            .eq("user_id", user_id)\
            .eq("id", invoice_id)\
            .execute()
        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{invoice_id}")
async def delete_invoice(
    invoice_id: str,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        supabase.table("invoices")\
            .delete()\
            .eq("user_id", user_id)\
            .eq("id", invoice_id)\
            .execute()
        return {"message": "Deleted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/export/excel")
async def export_excel_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("invoices")\
            .select("*")\
            .eq("user_id", user_id)\
            .execute()

        excel_bytes = generate_excel(response.data)
        return StreamingResponse(
            iter([excel_bytes]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=facturas.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/export/pdf")
async def export_pdf_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("invoices")\
            .select("*")\
            .eq("user_id", user_id)\
            .execute()

        pdf_bytes = generate_pdf(response.data)
        return StreamingResponse(
            iter([pdf_bytes]),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=resumen_facturas.pdf"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
