"""Panel de administración (Fase 3). Solo para admins (app_admins).
Permite listar/crear usuarios y asignar módulos/planes con vigencia."""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin, MODULOS

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _add_month(d: date) -> date:
    y, m = d.year, d.month + 1
    if m > 12:
        y, m = y + 1, 1
    bisiesto = y % 4 == 0 and (y % 100 != 0 or y % 400 == 0)
    dias = [31, 29 if bisiesto else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return date(y, m, min(d.day, dias))

# Paquetes → módulos que activan
PLANES = {
    "ice": ["ingresos_ice"],
    "gastos_ret": ["gastos", "retenciones"],
    "completo": ["gastos", "retenciones", "ingresos_ice", "declaraciones"],
}
# Precio neto mensual (sin IVA) por plan
PLAN_PRECIO = {"ice": 40, "gastos_ret": 40, "completo": 150}


async def require_admin(user_id: str = Depends(get_current_user)):
    if not es_admin(user_id):
        raise HTTPException(status_code=403, detail="Solo administradores")
    return user_id


class UserIn(BaseModel):
    email: str
    password: str
    modules: Optional[List[str]] = None
    plan: Optional[str] = None


class ModulesIn(BaseModel):
    modules: List[str]
    valid_until: Optional[str] = None


class PlanIn(BaseModel):
    plan: str
    valid_until: Optional[str] = None


class SubIn(BaseModel):
    plan: Optional[str] = None
    precio_mensual: Optional[float] = None
    estado: Optional[str] = None          # prueba | activo | suspendido
    proximo_pago: Optional[str] = None    # YYYY-MM-DD


class PagoIn(BaseModel):
    monto: float = 0
    fecha: Optional[str] = None
    periodo: Optional[str] = None
    metodo: Optional[str] = None
    nota: Optional[str] = None
    avanzar_mes: bool = True


def _aplicar_modulos(uid: str, modules: List[str], valid_until: Optional[str]):
    """Activa los módulos de la lista y desactiva el resto, para un usuario."""
    sb = get_supabase_client()
    activos = set(modules or [])
    for m in MODULOS:
        data = {"activo": m in activos, "valid_until": valid_until}
        existing = sb.table("user_modules").select("id").eq("user_id", uid).eq("modulo", m).execute().data
        if existing:
            sb.table("user_modules").update(data).eq("id", existing[0]["id"]).execute()
        else:
            sb.table("user_modules").insert({"user_id": uid, "modulo": m, **data}).execute()


@router.get("/users")
async def list_users(_: str = Depends(require_admin)):
    sb = get_supabase_client()
    try:
        res = sb.auth.admin.list_users()
        users = res if isinstance(res, list) else getattr(res, "users", []) or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"No se pudo listar usuarios: {e}")

    mods = sb.table("user_modules").select("user_id,modulo,activo,valid_until").execute().data or []
    admins = {a["user_id"] for a in (sb.table("app_admins").select("user_id").execute().data or [])}
    subs = {s["user_id"]: s for s in (sb.table("subscriptions").select("*").execute().data or [])}
    by_user = {}
    for m in mods:
        by_user.setdefault(m["user_id"], {})[m["modulo"]] = {"activo": m["activo"], "valid_until": m.get("valid_until")}

    hoy = date.today().isoformat()
    out = []
    for u in users:
        uid = str(u.id)
        s = subs.get(uid)
        if s:
            vencida = bool(s.get("proximo_pago")) and str(s["proximo_pago"]) < hoy
            sub = {"plan": s.get("plan"), "precio_mensual": s.get("precio_mensual"),
                   "estado": s.get("estado"), "proximo_pago": s.get("proximo_pago"), "vencida": vencida}
        else:
            sub = None
        out.append({
            "user_id": uid,
            "email": u.email,
            "created_at": str(u.created_at)[:10],
            "is_admin": uid in admins,
            "modules": by_user.get(uid, {}),
            "subscription": sub,
        })
    out.sort(key=lambda x: x["email"] or "")
    return out


def _upsert_sub(uid: str, data: dict):
    sb = get_supabase_client()
    data = {k: v for k, v in data.items() if v is not None}
    data["updated_at"] = "now()"
    existing = sb.table("subscriptions").select("user_id").eq("user_id", uid).execute().data
    if existing:
        sb.table("subscriptions").update(data).eq("user_id", uid).execute()
    else:
        data["user_id"] = uid
        sb.table("subscriptions").insert(data).execute()


@router.put("/users/{uid}/subscription")
async def set_subscription(uid: str, body: SubIn, _: str = Depends(require_admin)):
    _upsert_sub(uid, body.dict())
    return {"ok": True}


@router.post("/users/{uid}/pago")
async def registrar_pago(uid: str, body: PagoIn, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    fecha = body.fecha or date.today().isoformat()
    sb.table("pagos").insert({
        "user_id": uid, "monto": body.monto, "fecha": fecha,
        "periodo": body.periodo, "metodo": body.metodo, "nota": body.nota,
    }).execute()
    sub_upd = {"estado": "activo"}
    if body.avanzar_mes:
        cur = sb.table("subscriptions").select("proximo_pago").eq("user_id", uid).execute().data
        base = None
        if cur and cur[0].get("proximo_pago"):
            try:
                y, m, d = map(int, str(cur[0]["proximo_pago"]).split("-"))
                base = date(y, m, d)
            except Exception:
                base = None
        hoy = date.today()
        if not base or base < hoy:
            base = hoy
        sub_upd["proximo_pago"] = _add_month(base).isoformat()
    _upsert_sub(uid, sub_upd)
    return {"ok": True, "proximo_pago": sub_upd.get("proximo_pago")}


@router.get("/users/{uid}/pagos")
async def historial_pagos(uid: str, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    return {"data": sb.table("pagos").select("*").eq("user_id", uid).order("fecha", desc=True).execute().data or []}


@router.get("/contactos")
async def listar_contactos(_: str = Depends(require_admin)):
    sb = get_supabase_client()
    return {"data": sb.table("contactos").select("*").order("created_at", desc=True).execute().data or []}


@router.post("/users")
async def create_user(body: UserIn, _: str = Depends(require_admin)):
    sb = get_supabase_client()
    try:
        res = sb.auth.admin.create_user({
            "email": body.email.strip(),
            "password": body.password,
            "email_confirm": True,
        })
        uid = str(res.user.id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo crear el usuario: {e}")

    plan = (body.plan or "").lower()
    mods = body.modules if body.modules is not None else PLANES.get(plan, [])
    _aplicar_modulos(uid, mods, None)
    if plan in PLANES:
        _upsert_sub(uid, {"plan": plan, "precio_mensual": PLAN_PRECIO.get(plan), "estado": "prueba"})
    return {"user_id": uid, "email": body.email}


@router.put("/users/{uid}/modules")
async def set_modules(uid: str, body: ModulesIn, _: str = Depends(require_admin)):
    _aplicar_modulos(uid, body.modules, body.valid_until)
    return {"ok": True}


@router.post("/users/{uid}/plan")
async def set_plan(uid: str, body: PlanIn, _: str = Depends(require_admin)):
    plan = body.plan.lower()
    mods = PLANES.get(plan)
    if mods is None:
        raise HTTPException(status_code=400, detail="Plan inválido")
    _aplicar_modulos(uid, mods, body.valid_until)
    _upsert_sub(uid, {"plan": plan, "precio_mensual": PLAN_PRECIO.get(plan)})
    return {"ok": True, "modules": mods}
