from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from auth import get_current_user
from database import get_supabase_client, fetch_all, fetch_in
from services.compradores import sync_desde_ventas
from tenancy import visible_clients, can_access_identificacion

router = APIRouter(prefix="/api/compradores", tags=["compradores"])

COLUMNS = "id,identificacion,ruc,tipo_id,nombre,actividad,created_at"


def _compradores_visibles(supabase, user_id, identificacion):
    from routers.access import rol_de
    if identificacion:
        if not can_access_identificacion(user_id, identificacion):
            return []
        return supabase.table("compradores").select(COLUMNS).eq("identificacion", identificacion).order("nombre").execute().data or []
    if rol_de(user_id) == "admin":
        return fetch_all(lambda: supabase.table("compradores").select(COLUMNS).order("nombre"))
    idents = sorted({c.get("identificacion") for c in visible_clients(user_id, "identificacion") if c.get("identificacion")})
    if not idents:
        return []
    rows = fetch_in(lambda: supabase.table("compradores").select(COLUMNS), idents, "identificacion")
    rows.sort(key=lambda r: (r.get("nombre") or ""))
    return rows


def _mapas_enriquecimiento(supabase, user_id):
    """Mapas RUC -> categoría (clasificador) y RUC -> datos de proveedor calificado."""
    from routers.access import rol_de
    is_admin = rol_de(user_id) == "admin"
    try:
        if is_admin:
            cl = fetch_all(lambda: supabase.table("classification_map").select("ruc,categoria,actividad"))
            pr = fetch_all(lambda: supabase.table("rebajas_proveedores").select("ruc,calificado,categoria,vigencia_inicio,vigente_hasta,actividad"))
        else:
            cl = supabase.table("classification_map").select("ruc,categoria,actividad").eq("user_id", user_id).execute().data or []
            pr = supabase.table("rebajas_proveedores").select("ruc,calificado,categoria,vigencia_inicio,vigente_hasta,actividad").eq("user_id", user_id).execute().data or []
    except Exception:
        cl, pr = [], []
    cmap = {}
    for c in cl:
        k = (c.get("ruc") or "").strip()
        if k and k not in cmap:
            cmap[k] = c
    pmap = {}
    for p in pr:
        k = (p.get("ruc") or "").strip()
        if k and (k not in pmap or (p.get("calificado") and not pmap[k].get("calificado"))):
            pmap[k] = p
    return cmap, pmap


@router.get("/enriquecido")
async def listar_enriquecido(identificacion: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Compradores + su clasificación (categoría del clasificador de gastos),
    calificación (catálogo de proveedores: tipo y vigencia) y actividad económica (SRI)."""
    try:
        supabase = get_supabase_client()
        rows = _compradores_visibles(supabase, user_id, identificacion)
        cmap, pmap = _mapas_enriquecimiento(supabase, user_id)
        out = []
        for r in rows:
            k = (r.get("ruc") or "").strip()
            c = cmap.get(k) or {}
            p = pmap.get(k) or {}
            out.append({
                **r,
                "categoria": c.get("categoria") or "",
                "calificado": bool(p.get("calificado")),
                "calif_categoria": p.get("categoria") or "",
                "calif_inicio": p.get("vigencia_inicio") or "",
                "calif_fin": p.get("vigente_hasta") or "",
                "actividad": (r.get("actividad") or "").strip() or (p.get("actividad") or "") or (c.get("actividad") or ""),
            })
        return {"data": out}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/enriquecer-actividades")
async def enriquecer_actividades(identificacion: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Trae la actividad económica del SRI para los compradores sin actividad (por lotes)."""
    try:
        from services.min_produccion import consultar_sri
        supabase = get_supabase_client()
        rows = _compradores_visibles(supabase, user_id, identificacion)
        faltan = [r for r in rows if (r.get("ruc") or "").strip() and not (r.get("actividad") or "").strip()]
        lote = faltan[:8]
        actualizados = 0
        for r in lote:
            ruc = (r.get("ruc") or "").strip()
            try:
                sri = consultar_sri(ruc, timeout=6) or {}
            except Exception:
                sri = {}
            ae = (sri.get("actividad_economica") or "").strip() or "—"
            try:
                supabase.table("compradores").update({"actividad": ae}).eq("id", r["id"]).execute()
                if ae != "—":
                    actualizados += 1
            except Exception:
                pass
        return {"actualizados": actualizados, "procesados": len(lote), "restantes": max(0, len(faltan) - len(lote))}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/")
async def listar(identificacion: Optional[str] = Query(None), user_id: str = Depends(get_current_user)):
    """Compradores visibles según el ROL: se comparten por contribuyente (RUC),
    igual que el catálogo de productos; el admin ve todos. Así no se pierden los que
    importó otro usuario del mismo contribuyente."""
    try:
        from routers.access import rol_de
        supabase = get_supabase_client()
        if identificacion:
            if not can_access_identificacion(user_id, identificacion):
                return {"data": []}
            rows = supabase.table("compradores").select(COLUMNS)\
                .eq("identificacion", identificacion).order("nombre").execute().data or []
            return {"data": rows}
        if rol_de(user_id) == "admin":
            return {"data": fetch_all(lambda: supabase.table("compradores").select(COLUMNS).order("nombre"))}
        idents = sorted({c.get("identificacion") for c in visible_clients(user_id, "identificacion") if c.get("identificacion")})
        if not idents:
            return {"data": []}
        rows = fetch_in(lambda: supabase.table("compradores").select(COLUMNS), idents, "identificacion")
        rows.sort(key=lambda r: (r.get("nombre") or ""))
        return {"data": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sync")
async def sincronizar(user_id: str = Depends(get_current_user)):
    """Reconstruye los clientes importados desde las ventas ICE ya guardadas."""
    try:
        supabase = get_supabase_client()
        total = sync_desde_ventas(supabase, user_id)
        return {"message": "Clientes sincronizados", "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{comprador_id}")
async def eliminar(comprador_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        supabase.table("compradores").delete().eq("id", comprador_id).eq("user_id", user_id).execute()
        return {"message": "Eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
