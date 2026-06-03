from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
import pandas as pd
import io
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors
from reportlab.lib.units import inch

router = APIRouter(prefix="/api/classification", tags=["classification"])

class ClassificationEntry(BaseModel):
    ruc: str
    nombre_proveedor: str
    categoria: str

@router.get("/")
async def list_classifications(_: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("*").order("nombre_proveedor").execute()
        return response.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/")
async def create_classification(
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        ruc = entry.ruc.strip()
        existing = supabase.table("classification_map").select("id").eq("ruc", ruc).execute()
        if existing.data:
            response = supabase.table("classification_map").update({
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).eq("ruc", ruc).execute()
        else:
            response = supabase.table("classification_map").insert({
                "user_id": user_id,
                "ruc": ruc,
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).execute()
        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.put("/{ruc}")
async def update_classification(
    ruc: str,
    entry: ClassificationEntry,
    _: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").update({
            "nombre_proveedor": entry.nombre_proveedor.upper(),
            "categoria": entry.categoria.upper()
        }).eq("ruc", ruc.strip()).execute()
        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{ruc}")
async def delete_classification(ruc: str, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("classification_map").delete().eq("ruc", ruc.strip()).execute()
        return {"message": "Deleted"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/import")
async def import_classifications(
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user)
):
    try:
        content = await file.read()
        df = pd.read_excel(io.BytesIO(content), header=None)

        supabase = get_supabase_client()
        new_count = 0
        updated = 0

        for _, row in df.iterrows():
            try:
                ruc = str(row[0]).strip().replace("'", "").zfill(13)
                nombre = str(row[1]).strip().upper() if len(row) > 1 else ""
                categoria = str(row[2]).strip().upper() if len(row) > 2 else ""

                if not ruc or not categoria or ruc == "NAN":
                    continue

                existing = supabase.table("classification_map").select("id").eq("ruc", ruc).execute()
                if existing.data:
                    supabase.table("classification_map").update({
                        "nombre_proveedor": nombre,
                        "categoria": categoria
                    }).eq("ruc", ruc).execute()
                    updated += 1
                else:
                    supabase.table("classification_map").insert({
                        "user_id": user_id,
                        "ruc": ruc,
                        "nombre_proveedor": nombre,
                        "categoria": categoria
                    }).execute()
                    new_count += 1
            except Exception as row_e:
                print(f"Error row {ruc}: {row_e}")

        return {"imported": new_count, "updated": updated}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/export/excel")
async def export_excel_endpoint(_: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").order("nombre_proveedor").execute()
        data = response.data or []

        df = pd.DataFrame(data)
        output = io.BytesIO()
        df.to_excel(output, index=False, header=False)
        output.seek(0)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": "attachment; filename=clasificador.xlsx"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/export/pdf")
async def export_pdf_endpoint(_: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").order("nombre_proveedor").execute()
        data = response.data or []

        output = io.BytesIO()
        doc = SimpleDocTemplate(output, pagesize=letter)
        story = [Paragraph("Clasificador de RUCs", getSampleStyleSheet()['Title']), Spacer(1, 0.3 * inch)]

        pdf_data = [["RUC", "Nombre", "Categoría"]]
        for row in data:
            pdf_data.append([row.get('ruc', ''), row.get('nombre_proveedor', '')[:30], row.get('categoria', '')])

        table = Table(pdf_data, colWidths=[2*inch, 2.5*inch, 1.5*inch])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, -1), 8),
            ('GRID', (0, 0), (-1, -1), 0.5, colors.black),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ]))
        story.append(table)
        doc.build(story)
        output.seek(0)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="application/pdf",
            headers={"Content-Disposition": "attachment; filename=clasificador.pdf"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
