import io
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client
from services.declaracion import declaracion_iva, declaracion_ice
from services.declaracion_oficial import llenar_oficial

router = APIRouter(prefix="/api/declaraciones", tags=["declaraciones"])


class SaveDecl(BaseModel):
    client_id: str
    tipo: str
    datos: dict


def _cliente(supabase, client_id):
    c = supabase.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute()
    return c.data[0] if c.data else {}


def _calcular(supabase, client_id, tipo):
    c = _cliente(supabase, client_id)
    anio = c.get("periodo_anio") or 2026
    if tipo.upper() == "ICE":
        ice = supabase.table("ice_sales").select("*").eq("client_id", client_id).execute().data or []
        decl = declaracion_ice(ice, anio)
    else:
        invoices = supabase.table("invoices").select("*").eq("client_id", client_id).execute().data or []
        ventas = supabase.table("ice_sales").select("*").eq("client_id", client_id).execute().data or []
        decl = declaracion_iva(invoices, ventas)
    decl["cliente"] = c
    decl["anio"] = anio
    decl["mes"] = c.get("periodo_mes")
    return decl


@router.get("/calcular")
async def calcular(client_id: str = Query(...), tipo: str = Query("IVA"), _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        return _calcular(supabase, client_id, tipo)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/")
async def listar(client_id: Optional[str] = Query(None), tipo: Optional[str] = Query(None), _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        q = supabase.table("declaraciones").select("*")
        if client_id:
            q = q.eq("client_id", client_id)
        if tipo:
            q = q.eq("tipo", tipo.upper())
        return {"data": q.order("created_at", desc=True).execute().data or []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def guardar(entry: SaveDecl, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        c = _cliente(supabase, entry.client_id)
        res = supabase.table("declaraciones").insert({
            "client_id": entry.client_id, "user_id": user_id, "tipo": entry.tipo.upper(),
            "anio": c.get("periodo_anio"), "mes": c.get("periodo_mes"), "datos": entry.datos,
        }).execute()
        return res.data[0] if res.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{decl_id}")
async def eliminar(decl_id: str, _: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("declaraciones").delete().eq("id", decl_id).execute()
        return {"message": "Eliminada"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/export/oficial")
async def export_oficial(client_id: str = Query(...), tipo: str = Query("IVA"), _: str = Depends(get_current_user)):
    """Llena el formulario oficial del SRI (borrador) con los valores calculados."""
    try:
        supabase = get_supabase_client()
        decl = _calcular(supabase, client_id, tipo)
        c = decl.get("cliente", {})
        data, llenados, omitidos = llenar_oficial(tipo, decl)
        label = f"Formulario_{tipo.upper()}_{c.get('identificacion','')}_{decl.get('anio')}{str(decl.get('mes') or '').zfill(2)}".replace(" ", "_")
        return StreamingResponse(
            iter([data]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f"attachment; filename={label}.xlsx",
                "X-Codigos-Llenados": ",".join(llenados),
                "X-Codigos-Omitidos": ",".join(omitidos),
            },
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export/excel")
async def export_excel(client_id: str = Query(...), tipo: str = Query("IVA"), _: str = Depends(get_current_user)):
    try:
        import xlsxwriter
        supabase = get_supabase_client()
        decl = _calcular(supabase, client_id, tipo)
        c = decl.get("cliente", {})
        output = io.BytesIO()
        wb = xlsxwriter.Workbook(output, {"in_memory": True})
        ws = wb.add_worksheet(f"Declaración {tipo.upper()}")
        title = wb.add_format({"bold": True, "font_color": "#1a5276", "font_size": 13})
        head = wb.add_format({"bold": True, "bg_color": "#1a5276", "font_color": "white", "border": 1})
        cell = wb.add_format({"border": 1})
        money = wb.add_format({"border": 1, "num_format": "#,##0.00"})
        ws.write(0, 0, f"DECLARACIÓN {tipo.upper()} — {c.get('identificacion','')} {c.get('nombre','')} · {decl.get('mes')}/{decl.get('anio')}", title)
        ws.write(2, 0, "Sección", head); ws.write(2, 1, "Código SRI", head)
        ws.write(2, 2, "Concepto", head); ws.write(2, 3, "Valor", head)
        r = 3
        for f in decl["filas"]:
            ws.write(r, 0, f.get("seccion", ""), cell)
            ws.write(r, 1, f.get("codigo", ""), cell)
            ws.write(r, 2, f.get("concepto", ""), cell)
            ws.write(r, 3, f.get("valor", 0), money)
            r += 1
        ws.set_column(0, 0, 16); ws.set_column(1, 1, 11); ws.set_column(2, 2, 60); ws.set_column(3, 3, 16)
        wb.close()
        output.seek(0)
        label = f"Declaracion_{tipo.upper()}_{c.get('identificacion','')}_{decl.get('anio')}{str(decl.get('mes') or '').zfill(2)}".replace(" ", "_")
        return StreamingResponse(iter([output.getvalue()]),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={label}.xlsx"})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
