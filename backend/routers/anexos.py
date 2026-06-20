from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.anexo_export import generar_anexo_excel, generar_anexo_pdf
from tenancy import assert_client_owner, visible_client_ids
from services.activity import registrar

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
        if client_id:
            assert_client_owner(client_id, user_id)
            data = supabase.table("anexos").select("id,client_id,tipo,datos,created_at").eq("client_id", client_id).order("created_at", desc=True).execute().data or []
        else:
            cols = "id,client_id,tipo,datos,created_at"
            vis = visible_client_ids(user_id)   # None = admin (ve todo)
            if vis is None:
                data = fetch_all(lambda: supabase.table("anexos").select(cols).order("created_at", desc=True))
            else:
                own = supabase.table("anexos").select(cols).eq("user_id", user_id).order("created_at", desc=True).execute().data or []
                sh = fetch_in(lambda: supabase.table("anexos").select(cols), vis, "client_id")
                seen, data = set(), []
                for r in own + sh:
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        data.append(r)
                data.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return {"data": data}
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
        registrar(actor_user_id=user_id, action="save", module="anexos",
                  entity=f"Anexo {entry.tipo.upper()}", client_id=entry.client_id)
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
