"""Descarga de los XML originales subidos, agrupados por contribuyente,
período y módulo, en un ZIP nombrado Tipo_RUC_nombre_mes_año."""
import io
import re
import zipfile
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from auth import get_current_user
from database import get_supabase_client
from tenancy import assert_client_owner

router = APIRouter(prefix="/api/xml-originales", tags=["xml-originales"])

TIPO_LABEL = {
    "gasto": "Gastos", "ingreso_ice": "IngresosICE",
    "ingreso_iva": "IngresosIVA", "retencion": "Retenciones",
}


def _slug(s):
    return (re.sub(r"[^A-Za-z0-9]+", "", (s or "").upper())[:20]) or "CLIENTE"


@router.get("/contar")
async def contar(client_id: str = Query(...), modulo: str = Query(...), user_id: str = Depends(get_current_user)):
    assert_client_owner(client_id, user_id)
    sb = get_supabase_client()
    r = sb.table("xml_originales").select("id", count="exact").eq(
        "client_id", client_id).eq("modulo", modulo).execute()
    return {"count": r.count or 0}


@router.get("/descargar")
async def descargar(client_id: str = Query(...), modulo: str = Query(...), user_id: str = Depends(get_current_user)):
    assert_client_owner(client_id, user_id)
    sb = get_supabase_client()
    rows = sb.table("xml_originales").select("unique_id,xml_content").eq(
        "client_id", client_id).eq("modulo", modulo).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="No hay XML originales guardados para este módulo y período. Se guardan automáticamente desde ahora, al subir nuevos XML.")
    cl = sb.table("clients").select("identificacion,nombre,periodo_mes,periodo_anio").eq("id", client_id).execute().data
    c = cl[0] if cl else {}
    ruc = c.get("identificacion", "") or ""
    nombre = _slug(c.get("nombre", ""))
    mes = str(c.get("periodo_mes") or "").zfill(2)
    anio = str(c.get("periodo_anio") or "")
    base = f"{TIPO_LABEL.get(modulo, modulo)}_{ruc}_{nombre}_{mes}_{anio}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for i, row in enumerate(rows, 1):
            z.writestr(f"{base}_{i:03d}.xml", row.get("xml_content") or "")
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={base}.zip"})
