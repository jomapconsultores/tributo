"""REPORTES de honorarios: cuadro de todos los contribuyentes con sus productos
(del catálogo, con su marca), indicando si se cobra y el valor a cobrar. Los
valores se guardan (tabla reportes_honorarios) para reutilizarse a futuro."""
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/reportes", tags=["reportes"])


class CobroIn(BaseModel):
    identificacion: str
    producto: str
    marca: Optional[str] = ""
    cobrar: Optional[bool] = True
    valor: Optional[float] = 0


def _marca_de(p):
    """Marca a mostrar: cod_prod_pvp, o la 3a parte del código ICE completo."""
    pvp = (p.get("cod_prod_pvp") or "").strip()
    if pvp:
        return pvp
    cod = (p.get("cod_prod_ice") or "").strip()
    partes = cod.split("-")
    if len(partes) == 8:
        return str(int(partes[2])) if partes[2].isdigit() else partes[2]
    return ""


@router.get("/cobros")
async def cobros(user_id: str = Depends(get_current_user)):
    """Cuadro: por cada contribuyente y cada producto de su catálogo, con la
    marca, si se cobra y el valor guardado. Incluye el total a cobrar."""
    sb = get_supabase_client()
    clients = sb.table("clients").select("identificacion,nombre").eq("user_id", user_id).execute().data or []
    # Nombre por RUC (contribuyente único)
    nombre_por_ruc = {}
    for c in clients:
        ident = c.get("identificacion")
        if ident and ident not in nombre_por_ruc:
            nombre_por_ruc[ident] = c.get("nombre") or ""

    productos = sb.table("client_products").select(
        "identificacion,nombre,cod_prod_pvp,cod_prod_ice").eq("user_id", user_id).execute().data or []

    guardados = sb.table("reportes_honorarios").select(
        "identificacion,producto,marca,cobrar,valor").eq("user_id", user_id).execute().data or []
    by_key = {(g["identificacion"], g["producto"]): g for g in guardados}

    filas = []
    total = 0.0
    for p in productos:
        ident = p.get("identificacion")
        if ident not in nombre_por_ruc:
            continue  # producto de un RUC sin cliente cargado
        prod = p.get("nombre") or ""
        g = by_key.get((ident, prod))
        cobrar = bool(g["cobrar"]) if g else True
        valor = float(g["valor"]) if g and g.get("valor") is not None else 0.0
        marca = (g.get("marca") if g and g.get("marca") else _marca_de(p)) or ""
        if cobrar:
            total += valor
        filas.append({
            "identificacion": ident,
            "contribuyente": nombre_por_ruc.get(ident, ""),
            "producto": prod,
            "marca": marca,
            "cobrar": cobrar,
            "valor": round(valor, 2),
        })

    filas.sort(key=lambda f: ((f["contribuyente"] or "").upper(), (f["producto"] or "").upper()))
    return {"data": filas, "total_a_cobrar": round(total, 2)}


@router.put("/cobros")
async def guardar_cobro(entry: CobroIn, user_id: str = Depends(get_current_user)):
    """Guarda (upsert) el 'cobrar' y 'valor' de un contribuyente+producto."""
    sb = get_supabase_client()
    prod = (entry.producto or "").strip()
    ident = (entry.identificacion or "").strip()
    if not ident or not prod:
        raise HTTPException(status_code=400, detail="Contribuyente y producto son obligatorios")
    try:
        sb.table("reportes_honorarios").upsert({
            "user_id": user_id,
            "identificacion": ident,
            "producto": prod,
            "marca": entry.marca or "",
            "cobrar": bool(entry.cobrar),
            "valor": float(entry.valor or 0),
            "updated_at": "now()",
        }, on_conflict="user_id,identificacion,producto").execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
