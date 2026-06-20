from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.ice_calc_report import full_report
from services.ice_calc_export import generate_calc_excel, generate_calc_pdf
from services.ice_calc_data import TARIFAS
from tenancy import assert_client_owner, visible_client_ids

router = APIRouter(prefix="/api/ice-calc", tags=["ice-calc"])

COLUMNS = ("id,client_id,producto,categoria,por_cajas,cajas,botellas_por_caja,"
           "unidades,grado,capacidad,precio,anio,mes,created_at")


class CalcRow(BaseModel):
    client_id: str
    producto: Optional[str] = ""
    categoria: Optional[str] = "ALCOHOLICA"
    por_cajas: Optional[bool] = True
    cajas: Optional[float] = 0
    botellas_por_caja: Optional[int] = 12
    unidades: Optional[float] = 0
    grado: Optional[float] = 0
    capacidad: Optional[float] = 750
    precio: Optional[float] = 0
    anio: Optional[int] = None
    mes: Optional[int] = None


class CalcUpdate(BaseModel):
    producto: Optional[str] = None
    categoria: Optional[str] = None
    por_cajas: Optional[bool] = None
    cajas: Optional[float] = None
    botellas_por_caja: Optional[int] = None
    unidades: Optional[float] = None
    grado: Optional[float] = None
    capacidad: Optional[float] = None
    precio: Optional[float] = None


class BulkIds(BaseModel):
    ids: List[str]


def _period(supabase, client_id):
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    if c.data:
        return c.data[0]
    return {"periodo_anio": 2026, "periodo_mes": 1}


@router.get("/tarifas")
async def get_tarifas(_: str = Depends(get_current_user)):
    return {"tarifas": TARIFAS}


@router.get("/")
async def list_calc(user_id: str = Depends(get_current_user), client_id: Optional[str] = Query(None)):
    try:
        supabase = get_supabase_client()
        if client_id:
            assert_client_owner(client_id, user_id)
            rows = supabase.table("ice_calc").select(COLUMNS).eq("client_id", client_id).order("created_at").execute().data or []
        else:
            vis = visible_client_ids(user_id)   # None = admin (ve todo)
            if vis is None:
                rows = fetch_all(lambda: supabase.table("ice_calc").select(COLUMNS).order("created_at"))
            else:
                own = supabase.table("ice_calc").select(COLUMNS).eq("user_id", user_id).order("created_at").execute().data or []
                sh = fetch_in(lambda: supabase.table("ice_calc").select(COLUMNS), vis, "client_id")
                seen, rows = set(), []
                for r in own + sh:
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        rows.append(r)
                rows.sort(key=lambda x: x.get("created_at") or "")
        period = _period(supabase, client_id) if client_id else None
        return {"data": rows, "cliente": period}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_calc(entry: CalcRow, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(entry.client_id, user_id)
        data = entry.dict()
        data["user_id"] = user_id
        if data.get("anio") is None or data.get("mes") is None:
            c = _period(supabase, entry.client_id)
            data["anio"] = data.get("anio") or c.get("periodo_anio")
            data["mes"] = data.get("mes") or c.get("periodo_mes")
        res = supabase.table("ice_calc").insert(data).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{row_id}")
async def update_calc(row_id: str, entry: CalcUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        data = {k: v for k, v in entry.dict().items() if v is not None}
        res = supabase.table("ice_calc").update(data).eq("id", row_id).eq("user_id", user_id).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/clear")
async def clear_calc(client_id: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("ice_calc").delete().eq("user_id", user_id)
        if client_id:
            assert_client_owner(client_id, user_id)
            q = q.eq("client_id", client_id)
        else:
            q = q.neq("id", "00000000-0000-0000-0000-000000000000")
        q.execute()
        return {"message": "Cálculos eliminados"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{row_id}")
async def delete_calc(row_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("ice_calc").delete().eq("id", row_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/report")
async def report(user_id: str = Depends(get_current_user), client_id: str = Query(...)):
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)
        rows = supabase.table("ice_calc").select("*").eq("client_id", client_id).execute().data or []
        c = _period(supabase, client_id)
        return full_report(rows, c.get("periodo_anio") or 2026, c.get("periodo_mes") or 1)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _export(client_id, kind, user_id):
    supabase = get_supabase_client()
    rows = supabase.table("ice_calc").select("*").eq("client_id", client_id).execute().data or []
    c = _period(supabase, client_id)
    anio = c.get("periodo_anio") or 2026
    mes = c.get("periodo_mes") or 1
    label = f"{c.get('identificacion','')}_{c.get('nombre','')}_CalcICE".replace(" ", "_")
    if kind == "excel":
        return generate_calc_excel(rows, anio, mes, c), f"{label}.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return generate_calc_pdf(rows, anio, mes, c), f"{label}.pdf", "application/pdf"


@router.get("/export/excel")
async def export_excel(client_id: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        assert_client_owner(client_id, user_id)
        data, fname, media = _export(client_id, "excel", user_id)
        return StreamingResponse(iter([data]), media_type=media, headers={"Content-Disposition": f"attachment; filename={fname}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/pdf")
async def export_pdf(client_id: str = Query(...), user_id: str = Depends(get_current_user)):
    try:
        assert_client_owner(client_id, user_id)
        data, fname, media = _export(client_id, "pdf", user_id)
        return StreamingResponse(iter([data]), media_type=media, headers={"Content-Disposition": f"attachment; filename={fname}"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
