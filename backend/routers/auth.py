from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel
from database import get_supabase_client_anon, get_supabase_client
from config import get_settings
from auth import get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


class LoginRequest(BaseModel):
    email: str
    password: str


class SignupRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    access_token: str
    user_id: str
    email: str


class ForgotRequest(BaseModel):
    email: str


class ResetRequest(BaseModel):
    access_token: str
    password: str


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "desconocida"


def _es_admin(user_id: str) -> bool:
    try:
        r = get_supabase_client().table("app_admins").select("user_id").eq("user_id", user_id).execute()
        return bool(r.data)
    except Exception:
        return False


def _control_ip(user_id: str, ip: str):
    """Permite máximo N IPs por usuario. Lanza 403 si se supera."""
    if _es_admin(user_id):
        return
    sb = get_supabase_client()
    rows = sb.table("user_ips").select("ip").eq("user_id", user_id).execute().data or []
    ips = {r["ip"] for r in rows}
    if ip in ips:
        sb.table("user_ips").update({"last_seen": "now()"}).eq("user_id", user_id).eq("ip", ip).execute()
        return
    if len(ips) >= settings.max_ips_por_usuario:
        raise HTTPException(
            status_code=403,
            detail=f"Límite de {settings.max_ips_por_usuario} dispositivos/IP alcanzado. "
                   f"Contacta al administrador para restablecer tus accesos.",
        )
    sb.table("user_ips").insert({"user_id": user_id, "ip": ip}).execute()


@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest, req: Request):
    try:
        supabase = get_supabase_client_anon()
        response = supabase.auth.sign_in_with_password({
            "email": request.email, "password": request.password,
        })
    except Exception as e:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    if not response or not response.user:
        raise HTTPException(status_code=401, detail="Credenciales inválidas")
    # Control de IPs (máximo permitido por usuario; admins exentos)
    _control_ip(str(response.user.id), client_ip(req))
    return AuthResponse(
        access_token=response.session.access_token,
        user_id=str(response.user.id),
        email=response.user.email,
    )


@router.post("/signup", response_model=AuthResponse)
async def signup(request: SignupRequest):
    try:
        supabase = get_supabase_client_anon()
        response = supabase.auth.sign_up({"email": request.email, "password": request.password})
        if response.user:
            # Alta automática: prueba gratuita + aviso al administrador (correo y
            # Movimientos 🔔). Defensivo: nunca rompe el registro si algo falla.
            try:
                from services.onboarding import provisionar_prueba_y_avisar
                provisionar_prueba_y_avisar(user_id=str(response.user.id), email=response.user.email)
            except Exception as e:
                print(f"[signup] onboarding falló (no crítico): {e}")
            return AuthResponse(
                access_token=response.session.access_token if response.session else "",
                user_id=str(response.user.id),
                email=response.user.email,
            )
        raise HTTPException(status_code=400, detail="No se pudo registrar")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/forgot")
async def forgot(request: ForgotRequest):
    """Envía un correo con el enlace para restablecer la contraseña."""
    try:
        supabase = get_supabase_client_anon()
        supabase.auth.reset_password_for_email(
            request.email.strip(),
            {"redirect_to": settings.frontend_url.rstrip("/") + "/reset-password"},
        )
    except Exception:
        pass  # no revelar si el correo existe o no
    return {"message": "Si el correo está registrado, te enviamos un enlace para restablecer la contraseña."}


@router.post("/reset")
async def reset(request: ResetRequest):
    """Cambia la contraseña usando el token de recuperación recibido por correo."""
    if len(request.password or "") < 6:
        raise HTTPException(status_code=400, detail="La contraseña debe tener al menos 6 caracteres")
    try:
        anon = get_supabase_client_anon()
        user = anon.auth.get_user(request.access_token)  # valida el token contra Supabase
        uid = str(user.user.id)
    except Exception:
        raise HTTPException(status_code=400, detail="Enlace inválido o expirado. Solicita uno nuevo.")
    try:
        get_supabase_client().auth.admin.update_user_by_id(uid, {"password": request.password})
        return {"message": "Contraseña actualizada. Ya puedes iniciar sesión."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/logout")
async def logout():
    return {"message": "Logged out successfully"}


@router.get("/whoami")
async def whoami(user_id: str = Depends(get_current_user)):
    """Identidad del portador del token (Supabase o biométrico). Lo usa el
    Sistema MAP para el login único (SSO): valida el token contra tributos-web
    —única fuente de auth— y obtiene el email para mapear al usuario en su padrón."""
    email = ""
    try:
        from services.activity import _email_de
        email = _email_de(user_id) or ""
    except Exception:
        email = ""
    return {"user_id": user_id, "email": email}
