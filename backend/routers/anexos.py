from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.anexo_export import generar_anexo_excel, generar_anexo_pdf
from tenancy import assert_client_owner

router = APIRouter(prefix="/api/anexos", tags=["anexos"])


class AnexoIn(BaseModel):
    client_id: str
    tipo: str
    datos: dict


class AnexoUpdate(BaseModel):
    tipo: Optional[str] = None
    datos: Optional[dict] = None


class AnexoExport(BaseModel):
    tipo: str
    header: dict
    rows: List[dict]


@router.get("/")
async def listar(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("anexos").select("id,client_id,tipo,datos,created_at").eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
            q = q.eq("client_id", client_id)
        return {"data": q.order("created_at", desc=True).execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def guardar(entry: AnexoIn, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        res = supabase.table("anexos").insert({
            "client_id": entry.client_id, "user_id": user_id,
            "tipo": entry.tipo.upper(), "datos": entry.datos,
        }).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{anexo_id}")
async def actualizar(anexo_id: str, entry: AnexoUpdate, user_id: str = Depends(get_current_user)):
    """Actualiza un anexo guardado (al volver a guardar uno recuperado no se duplica)."""
    try:
        supabase = get_supabase_client()
        data = {}
        if entry.tipo is not None:
            data["tipo"] = entry.tipo.upper()
        if entry.datos is not None:
            data["datos"] = entry.datos
        if not data:
            raise HTTPException(status_code=400, detail="Nada que actualizar")
        res = supabase.table("anexos").update(data).eq("id", anexo_id).eq("user_id", user_id).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Anexo no encontrado")
        return res.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/export/excel")
async def export_excel(payload: AnexoExport, _: str = Depends(get_current_user)):
    """Exporta el anexo en edición (cabecera + filas) a Excel."""
    try:
        contenido = generar_anexo_excel(payload.tipo, payload.header, payload.rows)
        nombre = f"Anexo_{payload.tipo.upper()}_{payload.header.get('Anio','')}{str(payload.header.get('Mes','')).zfill(2)}.xlsx"
        return StreamingResponse(
            iter([contenido]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={nombre}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/export/pdf")
async def export_pdf(payload: AnexoExport, _: str = Depends(get_current_user)):
    """Exporta el anexo en edición (cabecera + filas) a PDF."""
    try:
        contenido = generar_anexo_pdf(payload.tipo, payload.header, payload.rows)
        nombre = f"Anexo_{payload.tipo.upper()}_{payload.header.get('Anio','')}{str(payload.header.get('Mes','')).zfill(2)}.pdf"
        return StreamingResponse(
            iter([contenido]), media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename={nombre}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{anexo_id}")
async def eliminar(anexo_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("anexos").delete().eq("id", anexo_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
