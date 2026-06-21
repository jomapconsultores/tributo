from concurrent.futures import ThreadPoolExecutor
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client, fetch_all
from services.sri_ruc import consultar_ruc
from tenancy import visible_clients, assert_client_owner
from services.activity import registrar

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
    iva_incluido: Optional[bool] = None


def _shared_ids(supabase, user_id: str) -> list:
    """Client IDs que otro usuario compartió explícitamente con user_id."""
    rows = supabase.table("client_access").select("client_id").eq("granted_to", user_id).execute().data or []
    return [r["client_id"] for r in rows]


@router.get("/")
async def list_clients(user_id: str = Depends(get_current_user)):
    """Lista los clientes con estadísticas (# facturas y monto total)."""
    try:
        supabase = get_supabase_client()
        # Visibles según rol (admin: todos; socio: clientes+propios; cliente: propios+compartidos).
        clients = visible_clients(user_id, "*")
        # Marcar/enriquecer los que llegaron por acceso compartido (client_access).
        shared_set = set(_shared_ids(supabase, user_id))
        if shared_set:
            owner_uids = list({c["user_id"] for c in clients if c["id"] in shared_set and c.get("user_id")})
            owner_map = {}
            if owner_uids:
                try:
                    rows = supabase.table("app_admins").select("user_id,email").in_("user_id", owner_uids).execute().data or []
                    owner_map = {r["user_id"]: r["email"] for r in rows}
                except Exception:
                    pass
            for c in clients:
                if c["id"] in shared_set:
                    c["is_shared"] = True
                    c["owner_email"] = owner_map.get(c.get("user_id"), "")
        clients.sort(key=lambda x: ((x.get("nombre") or ""), -(x.get("periodo_anio") or 0), -(x.get("periodo_mes") or 0)))

        # Estadísticas por client_id (funciona independientemente del user_id)
        client_ids = [c["id"] for c in clients]
        if not client_ids:
            return clients
        invoices = fetch_all(lambda: supabase.table("invoices").select("client_id, total, clasificacion").in_("client_id", client_ids))
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


@router.get("/by-service")
async def clients_by_service(service: str = Query(...), user_id: str = Depends(get_current_user)):
    """Identificaciones (RUCs) que tienen el servicio activo en client_services."""
    try:
        supabase = get_supabase_client()
        clientes = visible_clients(user_id, "id,identificacion")
        if not clientes:
            return {"identificaciones": []}
        ids = [c["id"] for c in clientes]
        services_list = [s.strip() for s in service.split(',') if s.strip()]
        svc = supabase.table("client_services").select("client_id").in_("client_id", ids).in_("service", services_list).eq("active", True).execute().data or []
        activos = {r["client_id"] for r in svc}
        idents = list({c["identificacion"] for c in clientes if c["id"] in activos})
        return {"identificaciones": idents}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/consulta-ruc")
async def consulta_ruc(ruc: str, _: str = Depends(get_current_user)):
    """Datos básicos del RUC desde la API pública del SRI (razón social, estado,
    actividad, régimen, obligaciones). Para registrar/precargar contribuyentes."""
    return consultar_ruc(ruc)


@router.get("/contribuyentes")
async def contribuyentes(user_id: str = Depends(get_current_user)):
    """Árbol para Base de Datos: contribuyentes (por identificación) → períodos
    (año, mes) → conteo de datos por tipo (gastos/retenciones/ice/calculo)."""
    try:
        supabase = get_supabase_client()
        clients = visible_clients(user_id, "id,identificacion,nombre,tipo_identificacion,periodo_mes,periodo_anio")

        client_ids = [c["id"] for c in clients]

        def counts(table):
            if not client_ids:
                return {}
            rows = fetch_all(lambda: supabase.table(table).select("client_id").in_("client_id", client_ids))
            m = {}
            for r in rows:
                cid = r.get("client_id")
                if cid:
                    m[cid] = m.get(cid, 0) + 1
            return m

        with ThreadPoolExecutor(max_workers=4) as ex:
            f_inv = ex.submit(counts, "invoices")
            f_ret = ex.submit(counts, "retentions")
            f_ice = ex.submit(counts, "ice_sales")
            f_cal = ex.submit(counts, "ice_calc")
            inv = f_inv.result()
            ret = f_ret.result()
            ice = f_ice.result()
            cal = f_cal.result()

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
            invoices = fetch_all(lambda: supabase.table("invoices").select(
                "client_id, clasificacion, base_15, iva_15, total, estado"
            ).in_("client_id", client_ids))

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


@router.get("/services-map")
async def services_map(user_id: str = Depends(get_current_user)):
    """Mapa service → [identificaciones] para todos los servicios activos del usuario."""
    try:
        supabase = get_supabase_client()
        clientes = visible_clients(user_id, "id,identificacion")
        if not clientes:
            return {}
        id_to_ident = {c["id"]: c["identificacion"] for c in clientes}
        client_ids = list(id_to_ident.keys())
        svc_rows = supabase.table("client_services").select("client_id,service").in_("client_id", client_ids).eq("active", True).execute().data or []
        result = {}
        for row in svc_rows:
            svc = row.get("service")
            ident = id_to_ident.get(row["client_id"])
            if svc and ident:
                result.setdefault(svc, []).append(ident)
        return result
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
        nuevo = response.data[0] if response.data else None
        if nuevo:
            registrar(actor_user_id=user_id, action="create", module="clientes",
                      entity="Nuevo cliente", client_id=nuevo.get("id"),
                      identificacion=identificacion, contribuyente=entry.nombre.strip().upper(),
                      metadata={"periodo": f"{entry.periodo_mes:02d}/{entry.periodo_anio}"})
        return nuevo
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# Datos de IDENTIDAD del contribuyente: al editarlos se propagan a TODOS sus
# períodos (todo el módulo). Los de período (mes/año) solo al registro elegido.
_CAMPOS_IDENTIDAD = {"identificacion", "nombre", "tipo_identificacion", "notas", "iva_incluido"}


@router.put("/{client_id}")
async def update_client(client_id: str, entry: ClientUpdate, user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        # Autorización por ROL (no solo el dueño): la socia/admin pueden editar los
        # contribuyentes visibles, no únicamente los que creó su propio usuario.
        assert_client_owner(client_id, user_id)
        data = {k: v for k, v in entry.dict().items() if v is not None}
        if "identificacion" in data:
            data["identificacion"] = data["identificacion"].strip().replace("'", "")
        if "nombre" in data:
            data["nombre"] = data["nombre"].strip().upper()
        data["updated_at"] = "now()"
        # Identificación actual (para ubicar todos los períodos del contribuyente).
        cur = supabase.table("clients").select("identificacion").eq("id", client_id).execute().data
        ident_actual = cur[0]["identificacion"] if cur else None
        # 1) El registro seleccionado recibe TODOS los cambios (incluido período).
        response = supabase.table("clients").update(data).eq("id", client_id).execute()
        # 2) Los campos de identidad se propagan al resto de períodos del MISMO
        #    contribuyente, para que el cambio afecte a todo el módulo.
        identidad = {k: v for k, v in data.items() if k in _CAMPOS_IDENTIDAD}
        if ident_actual and identidad:
            identidad["updated_at"] = "now()"
            supabase.table("clients").update(identidad).eq(
                "identificacion", ident_actual).neq("id", client_id).execute()
        return response.data[0] if response.data else None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{client_id}")
async def delete_client(client_id: str, user_id: str = Depends(get_current_user)):
    """Elimina un cliente (este período) y todas sus facturas (cascade)."""
    try:
        supabase = get_supabase_client()
        assert_client_owner(client_id, user_id)   # autorización por rol
        supabase.table("clients").delete().eq("id", client_id).execute()
        return {"message": "Cliente eliminado"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
