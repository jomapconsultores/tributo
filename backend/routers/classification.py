from fastapi import APIRouter, Depends, HTTPException, File, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all
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


def _propagate_classification(supabase, ruc: str, categoria: str, user_id: str) -> int:
    """Aplica la categoría a TODAS las facturas de ese RUC del usuario: las que
    están SIN CLASIFICAR y también las que ya tenían OTRA categoría. Así, al
    cambiar la clasificación de un RUC, se reclasifican todos sus comprobantes
    (una clasificación por RUC, consistente). Devuelve cuántas facturas cambiaron
    de categoría (no cuenta las que ya tenían esa misma categoría)."""
    ruc = (ruc or "").strip()
    categoria = (categoria or "").strip().upper()
    if not ruc or not categoria:
        return 0
    try:
        rows = supabase.table("invoices").select("id,clasificacion")\
            .eq("ruc_proveedor", ruc).eq("user_id", user_id).execute().data or []
    except Exception as e:
        print(f"Error leyendo facturas del RUC {ruc}: {e}")
        return 0
    # Solo las que tienen una categoría distinta (incluye SIN CLASIFICAR / null)
    a_cambiar = [r["id"] for r in rows
                 if (r.get("clasificacion") or "").strip().upper() != categoria]
    if not a_cambiar:
        return 0
    cambiadas = 0
    for i in range(0, len(a_cambiar), 200):  # en lotes, por si el RUC tiene muchas
        lote = a_cambiar[i:i + 200]
        try:
            r = supabase.table("invoices").update({"clasificacion": categoria}).in_("id", lote).execute()
            cambiadas += len(r.data or [])
        except Exception as e:
            print(f"Error propagando clasificación {ruc}: {e}")
    return cambiadas

def _rucs_calificados(supabase, user_id, is_admin):
    """Set de RUC calificados (del catálogo de proveedores de Rebajas/Exenciones)."""
    try:
        if is_admin:
            prov = fetch_all(lambda: supabase.table("rebajas_proveedores").select("ruc,calificado"))
        else:
            prov = supabase.table("rebajas_proveedores").select("ruc,calificado").eq("user_id", user_id).execute().data or []
        return {(p.get("ruc") or "").strip() for p in prov if p.get("calificado")}
    except Exception:
        return set()


@router.get("/")
async def list_classifications(user_id: str = Depends(get_current_user)):
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        is_admin = rol_de(user_id) == "admin"
        if is_admin:
            # El admin ve TODO el clasificador del equipo (cualquier usuario),
            # deduplicado por RUC (una clasificación por RUC).
            filas = fetch_all(lambda: supabase.table("classification_map").select("*").order("nombre_proveedor"))
            vistos = {}
            for r in filas:
                k = (r.get("ruc") or "").strip()
                if not k:
                    continue
                if k not in vistos or (not (vistos[k].get("categoria") or "").strip() and (r.get("categoria") or "").strip()):
                    vistos[k] = r
            rows = sorted(vistos.values(), key=lambda r: (r.get("nombre_proveedor") or ""))
        else:
            rows = supabase.table("classification_map").select("*").eq("user_id", user_id).order("nombre_proveedor").execute().data or []
        califs = _rucs_calificados(supabase, user_id, is_admin)
        for r in rows:
            r["calificado"] = (r.get("ruc") or "").strip() in califs
        return rows
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
        existing = supabase.table("classification_map").select("id").eq("ruc", ruc).eq("user_id", user_id).execute()
        if existing.data:
            response = supabase.table("classification_map").update({
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).eq("ruc", ruc).eq("user_id", user_id).execute()
        else:
            response = supabase.table("classification_map").insert({
                "user_id": user_id,
                "ruc": ruc,
                "nombre_proveedor": entry.nombre_proveedor.upper(),
                "categoria": entry.categoria.upper()
            }).execute()
        reclasificadas = _propagate_classification(supabase, ruc, entry.categoria, user_id)
        result = response.data[0] if response.data else {}
        return {**result, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.put("/by-id/{entry_id}")
async def update_classification_by_id(
    entry_id: str,
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    """Actualiza un registro por id, permitiendo cambiar el RUC. El admin puede
    editar registros de cualquier usuario (la reclasificación afecta al dueño)."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        cur = supabase.table("classification_map").select("user_id").eq("id", entry_id).execute().data
        if not cur:
            raise HTTPException(status_code=404, detail="Registro no encontrado")
        owner = cur[0]["user_id"]
        if owner != user_id and rol_de(user_id) != "admin":
            raise HTTPException(status_code=404, detail="Registro no encontrado")
        new_ruc = entry.ruc.strip().replace("'", "")
        upd = supabase.table("classification_map").update({
            "ruc": new_ruc,
            "nombre_proveedor": entry.nombre_proveedor.upper(),
            "categoria": entry.categoria.upper(),
            "updated_at": "now()"
        }).eq("id", entry_id)
        if owner == user_id:
            upd = upd.eq("user_id", user_id)
        response = upd.execute()
        reclasificadas = _propagate_classification(supabase, new_ruc, entry.categoria, owner)
        result = response.data[0] if response.data else {}
        return {**result, "reclasificadas": reclasificadas}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/by-id/{entry_id}")
async def delete_classification_by_id(entry_id: str, user_id: str = Depends(get_current_user)):
    """Elimina por id. El admin puede eliminar registros de cualquier usuario."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        cur = supabase.table("classification_map").select("user_id").eq("id", entry_id).execute().data
        if not cur:
            return {"message": "Deleted"}
        owner = cur[0]["user_id"]
        if owner != user_id and rol_de(user_id) != "admin":
            raise HTTPException(status_code=404, detail="Registro no encontrado")
        supabase.table("classification_map").delete().eq("id", entry_id).execute()
        return {"message": "Deleted"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{ruc}")
async def update_classification(
    ruc: str,
    entry: ClassificationEntry,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").update({
            "nombre_proveedor": entry.nombre_proveedor.upper(),
            "categoria": entry.categoria.upper()
        }).eq("ruc", ruc.strip()).eq("user_id", user_id).execute()
        reclasificadas = _propagate_classification(supabase, ruc, entry.categoria, user_id)
        result = response.data[0] if response.data else {}
        return {**result, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/{ruc}")
async def delete_classification(ruc: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("classification_map").delete().eq("ruc", ruc.strip()).eq("user_id", user_id).execute()
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
        reclasificadas = 0

        for _, row in df.iterrows():
            try:
                ruc = str(row[0]).strip().replace("'", "").zfill(13)
                nombre = str(row[1]).strip().upper() if len(row) > 1 else ""
                categoria = str(row[2]).strip().upper() if len(row) > 2 else ""

                if not ruc or not categoria or ruc == "NAN":
                    continue

                existing = supabase.table("classification_map").select("id").eq("ruc", ruc).eq("user_id", user_id).execute()
                if existing.data:
                    supabase.table("classification_map").update({
                        "nombre_proveedor": nombre,
                        "categoria": categoria
                    }).eq("ruc", ruc).eq("user_id", user_id).execute()
                    updated += 1
                else:
                    supabase.table("classification_map").insert({
                        "user_id": user_id,
                        "ruc": ruc,
                        "nombre_proveedor": nombre,
                        "categoria": categoria
                    }).execute()
                    new_count += 1
                reclasificadas += _propagate_classification(supabase, ruc, categoria, user_id)
            except Exception as row_e:
                print(f"Error row {ruc}: {row_e}")

        return {"imported": new_count, "updated": updated, "reclasificadas": reclasificadas}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/export/excel")
async def export_excel_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").eq("user_id", user_id).order("nombre_proveedor").execute()
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
async def export_pdf_endpoint(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("classification_map").select("ruc, nombre_proveedor, categoria").eq("user_id", user_id).order("nombre_proveedor").execute()
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
