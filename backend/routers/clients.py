from fastapi import APIRouter, Depends, HTTPException
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/clients", tags=["clients"])


class ClientCreate(BaseModel):
    identificacion: str
    nombre: str
    periodo_mes: int
    periodo_anio: int
    tipo_identificacion: Optional[str] = "RUC"
    notas: Optional[str] = None


class ClientUpdate(BaseModel):
    identificacion: Optional[str] = None
    nombre: Optional[str] = None
    periodo_mes: Optional[int] = None
    periodo_anio: Optional[int] = None
    tipo_identificacion: Optional[str] = None
    notas: Optional[str] = None


@router.get("/")
async def list_clients(user_id: str = Depends(get_current_user)):
    """Lista los clientes con estadísticas (# facturas y monto total)."""
    try:
        supabase = get_supabase_client()
        clients = supabase.table("clients").select("*")\
            .eq("user_id", user_id)\
            .order("nombre")\
            .order("periodo_anio", desc=True)\
            .order("periodo_mes", desc=True)\
            .execute().data or []

        # Estadísticas por cliente
        invoices = supabase.table("invoices").select("client_id, total, clasificacion").eq("user_id", user_id).execute().data or []
        stats = {}
        for inv in invoices:
            cid = inv.get("client_id")
            if not cid:
                continue
            s = stats.setdefault(cid, {"count": 0, "total": 0.0, "sin_clasificar": 0})
            s["count"] += 1
            s["total"] += float(inv.get("total") or 0)
            if not inv.get("clasificacion") or inv.get("clasificacion") == "SIN CLASIFICAR":
                s["sin_clasificar"] += 1

        for c in clients:
            s = stats.get(c["id"], {"count": 0, "total": 0.0, "sin_clasificar": 0})
            c["num_facturas"] = s["count"]
            c["monto_total"] = round(s["total"], 2)
            c["sin_clasificar"] = s["sin_clasificar"]

        return clients
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/contribuyentes")
async def contribuyentes(user_id: str = Depends(get_current_user)):
    """Árbol para Base de Datos: contribuyentes (por identificación) → períodos
    (año, mes) → conteo de datos por tipo (gastos/retenciones/ice/calculo)."""
    try:
        supabase = get_supabase_client()
        clients = supabase.table("clients").select(
            "id,identificacion,nombre,tipo_identificacion,periodo_mes,periodo_anio"
        ).eq("user_id", user_id).execute().data or []

        def counts(table):
            rows = supabase.table(table).select("client_id").eq("user_id", user_id).execute().data or []
            m = {}
            for r in rows:
                cid = r.get("client_id")
                if cid:
                    m[cid] = m.get(cid, 0) + 1
            return m

        inv = counts("invoices")
        ret = counts("retentions")
        ice = counts("ice_sales")
        cal = counts("ice_calc")

        ag = {}
        for c in clients:
            ident = c["identificacion"]
            g = ag.setdefault(ident, {
                "identificacion": ident, "nombre": c["nombre"],
                "tipo_identificacion": c.get("tipo_identificacion", "RUC"),
                "periodos": [], "totales": {"gastos": 0, "retenciones": 0, "ice": 0, "calculo_ice": 0},
            })
            cid = c["id"]
            datos = {"gastos": inv.get(cid, 0), "retenciones": ret.get(cid, 0),
                     "ice": ice.get(cid, 0), "calculo_ice": cal.get(cid, 0)}
            g["periodos"].append({"client_id": cid, "anio": c.get("periodo_anio"),
                                  "mes": c.get("periodo_mes"), "datos": datos})
            for k in datos:
                g["totales"][k] += datos[k]
            g["nombre"] = c["nombre"]

        out = []
        for g in ag.values():
            g["periodos"].sort(key=lambda p: (-(p["anio"] or 0), -(p["mes"] or 0)))
            out.append(g)
        out.sort(key=lambda g: (g["nombre"] or "").upper())
        return out
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summary/{identificacion}")
async def client_summary(identificacion: str, user_id: str = Depends(get_current_user)):
    """Resumen de TODO lo trabajado para un contribuyente, agregado por
    año → mes → producto (clasificación). Recorre todos sus períodos."""
    try:
        supabase = get_supabase_client()
        ident = identificacion.strip()
        recs = supabase.table("clients").select("*").eq("identificacion", ident).eq("user_id", user_id).execute().data or []
        if not recs:
            raise HTTPException(status_code=404, detail="No hay registros para esa identificación")

        nombre = recs[0].get("nombre")
        id_to_period = {r["id"]: (r.get("periodo_anio"), r.get("periodo_mes")) for r in recs}
        client_ids = list(id_to_period.keys())

        invoices = []
        if client_ids:
            invoices = supabase.table("invoices").select(
                "client_id, clasificacion, base_15, iva_15, total, estado"
            ).in_("client_id", client_ids).execute().data or []

        agg = {}
        for inv in invoices:
            anio, mes = id_to_period.get(inv["client_id"], (None, None))
            clasif = inv.get("clasificacion") or "SIN CLASIFICAR"
            key = (anio, mes, clasif)
            a = agg.setdefault(key, {
                "anio": anio, "mes": mes, "clasificacion": clasif,
                "num_facturas": 0, "base_15": 0.0, "iva_15": 0.0, "total": 0.0
            })
            a["num_facturas"] += 1
            a["base_15"] += float(inv.get("base_15") or 0)
            a["iva_15"] += float(inv.get("iva_15") or 0)
            a["total"] += float(inv.get("total") or 0)

        filas = sorted(
            agg.values(),
            key=lambda x: (-(x["anio"] or 0), -(x["mes"] or 0), x["clasificacion"])
        )
        for f in filas:
            f["base_15"] = round(f["base_15"], 2)
            f["iva_15"] = round(f["iva_15"], 2)
            f["total"] = round(f["total"], 2)

        periodos = sorted(
            [{"client_id": r["id"], "anio": r.get("periodo_anio"), "mes": r.get("periodo_mes")} for r in recs],
            key=lambda x: (-(x["anio"] or 0), -(x["mes"] or 0))
        )
        return {"identificacion": ident, "nombre": nombre, "periodos": periodos, "filas": filas}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{client_id}")
async def get_client(client_id: str, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("clients").select("*").eq("id", client_id).eq("user_id", user_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Cliente no encontrado")
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/")
async def create_client(entry: ClientCreate, user_id: str = Depends(get_current_user)):
    """Crea un cliente para un período (mes+año). Si ya existe ese mismo
    contribuyente en ese período, devuelve el existente."""
    try:
        supabase = get_supabase_client()
        identificacion = entry.identificacion.strip().replace("'", "")
        if not identificacion or not entry.nombre.strip():
            raise HTTPException(status_code=400, detail="Identificación y Nombre son obligatorios")
        if not (1 <= entry.periodo_mes <= 12):
            raise HTTPException(status_code=400, detail="El mes debe estar entre 1 y 12")
        if not (2000 <= entry.periodo_anio <= 2100):
            raise HTTPException(status_code=400, detail="Año inválido")

        existing = supabase.table("clients").select("*")\
            .eq("user_id", user_id)\
            .eq("identificacion", identificacion)\
            .eq("periodo_mes", entry.periodo_mes)\
            .eq("periodo_anio", entry.periodo_anio)\
            .execute()
        if existing.data:
            return existing.data[0]

        response = supabase.table("clients").insert({
            "user_id": user_id,
            "identificacion": identificacion,
            "nombre": entry.nombre.strip().upper(),
            "tipo_identificacion": entry.tipo_identificacion or "RUC",
            "periodo_mes": entry.periodo_mes,
            "periodo_anio": entry.periodo_anio,
            "notas": entry.notas,
        }).execute()
        return response.data[0] if response.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{client_id}")
async def update_client(client_id: str, entry: ClientUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        data = {k: v for k, v in entry.dict().items() if v is not None}
        if "identificacion" in data:
            data["identificacion"] = data["identificacion"].strip().replace("'", "")
        if "nombre" in data:
            data["nombre"] = data["nombre"].strip().upper()
        data["updated_at"] = "now()"
        response = supabase.table("clients").update(data).eq("id", client_id).eq("user_id", user_id).execute()
        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{client_id}")
async def delete_client(client_id: str, user_id: str = Depends(get_current_user)):
    """Elimina un cliente y todas sus facturas (cascade)."""
    try:
        supabase = get_supabase_client()
        supabase.table("clients").delete().eq("id", client_id).eq("user_id", user_id).execute()
        return {"message": "Cliente eliminado"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
