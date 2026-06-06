"""Panel de administración (Fase 3). Solo para admins (app_admins).
Permite listar/crear usuarios y asignar módulos/planes con vigencia."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List
from auth import get_current_user
from database import get_supabase_client
from routers.access import es_admin, MODULOS

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Paquetes → módulos que activan
PLANES = {
    "basico": ["gastos", "retenciones"],
    "profesional": ["gastos", "retenciones", "declaraciones"],
    "premium": ["gastos", "retenciones", "ingresos_ice", "declaraciones"],
    "estudio": ["gastos", "retenciones", "ingresos_ice", "declaraciones"],
}


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
    by_user = {}
    for m in mods:
        by_user.setdefault(m["user_id"], {})[m["modulo"]] = {"activo": m["activo"], "valid_until": m.get("valid_until")}

    out = []
    for u in users:
        uid = str(u.id)
        out.append({
            "user_id": uid,
            "email": u.email,
            "created_at": str(u.created_at)[:10],
            "is_admin": uid in admins,
            "modules": by_user.get(uid, {}),
        })
    out.sort(key=lambda x: x["email"] or "")
    return out


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

    mods = body.modules if body.modules is not None else PLANES.get((body.plan or "").lower(), [])
    _aplicar_modulos(uid, mods, None)
    return {"user_id": uid, "email": body.email}


@router.put("/users/{uid}/modules")
async def set_modules(uid: str, body: ModulesIn, _: str = Depends(require_admin)):
    _aplicar_modulos(uid, body.modules, body.valid_until)
    return {"ok": True}


@router.post("/users/{uid}/plan")
async def set_plan(uid: str, body: PlanIn, _: str = Depends(require_admin)):
    mods = PLANES.get(body.plan.lower())
    if mods is None:
        raise HTTPException(status_code=400, detail="Plan inválido")
    _aplicar_modulos(uid, mods, body.valid_until)
    return {"ok": True, "modules": mods}
