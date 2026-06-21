"""Autenticación biométrica FIDO2/WebAuthn (huella dactilar, Face ID, Windows Hello)."""
import time
import json
import jwt as pyjwt
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import JSONResponse
from auth import get_current_user
from database import get_supabase_client
from config import get_settings

import base64 as _base64
import webauthn
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    UserVerificationRequirement,
    ResidentKeyRequirement,
    PublicKeyCredentialDescriptor,
)


def base64url_to_bytes(s: str) -> bytes:
    s += "=" * (4 - len(s) % 4)
    return _base64.urlsafe_b64decode(s)


def bytes_to_base64url(b: bytes) -> str:
    return _base64.urlsafe_b64encode(b).rstrip(b"=").decode()

router = APIRouter(prefix="/api/webauthn", tags=["webauthn"])
settings = get_settings()

_RP_NAME = "Gestor SRI"

# Challenges en memoria con TTL de 5 minutos
_challenges: dict = {}
_TTL = 300


def _rp_id() -> str:
    """Deriva el RP ID del frontend_url configurado."""
    url = (settings.frontend_url or "http://localhost:5173").rstrip("/")
    host = url.replace("https://", "").replace("http://", "").split(":")[0].split("/")[0]
    return host  # "localhost" o "tributos-web.onrender.com"


def _origin() -> str:
    return (settings.frontend_url or "http://localhost:5173").rstrip("/")


def _save_challenge(key: str, challenge: bytes):
    _challenges[key] = (challenge, time.monotonic() + _TTL)


def _pop_challenge(key: str) -> bytes:
    entry = _challenges.pop(key, None)
    if not entry:
        raise HTTPException(400, "Challenge expirado. Vuelve a intentarlo.")
    ch, exp = entry
    if time.monotonic() > exp:
        raise HTTPException(400, "Challenge expirado. Vuelve a intentarlo.")
    return ch


# ── Registro (requiere JWT activo) ─────────────────────────────────────────

@router.post("/register/begin")
async def register_begin(user_id: str = Depends(get_current_user)):
    supabase = get_supabase_client()
    try:
        u = supabase.auth.admin.get_user_by_id(user_id)
        email = u.user.email
    except Exception:
        raise HTTPException(500, "No se pudo obtener el perfil del usuario")

    existing = supabase.table("webauthn_credentials").select("credential_id") \
        .eq("user_id", user_id).execute().data or []
    exclude = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(r["credential_id"]))
        for r in existing
    ]

    opts = webauthn.generate_registration_options(
        rp_id=_rp_id(),
        rp_name=_RP_NAME,
        user_id=user_id.encode(),
        user_name=email,
        user_display_name=email,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=exclude,
    )
    _save_challenge(user_id, opts.challenge)
    return JSONResponse(content=json.loads(webauthn.options_to_json(opts)))


@router.post("/register/complete")
async def register_complete(body: dict, user_id: str = Depends(get_current_user)):
    challenge = _pop_challenge(user_id)
    supabase = get_supabase_client()

    try:
        u = supabase.auth.admin.get_user_by_id(user_id)
        email = u.user.email
    except Exception:
        raise HTTPException(500, "No se pudo obtener el perfil del usuario")

    try:
        ver = webauthn.verify_registration_response(
            credential=body,
            expected_challenge=challenge,
            expected_rp_id=_rp_id(),
            expected_origin=_origin(),
        )
    except Exception as e:
        raise HTTPException(400, f"Verificación biométrica fallida: {e}")

    cred_id = bytes_to_base64url(ver.credential_id)
    pub_key = bytes_to_base64url(ver.credential_public_key)

    supabase.table("webauthn_credentials").upsert({
        "user_id": user_id,
        "email": email.lower().strip(),
        "credential_id": cred_id,
        "public_key": pub_key,
        "sign_count": ver.sign_count,
        "device_type": str(ver.credential_device_type) if ver.credential_device_type else None,
    }, on_conflict="credential_id").execute()

    return {"ok": True, "email": email}


# ── Autenticación (sin JWT previo — solo email) ─────────────────────────────

@router.post("/login/begin")
async def login_begin(body: dict):
    email = (body.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(400, "Email requerido")

    supabase = get_supabase_client()
    rows = supabase.table("webauthn_credentials").select("credential_id") \
        .eq("email", email).execute().data or []
    if not rows:
        raise HTTPException(404, "Sin credenciales biométricas para este correo")

    allow = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(r["credential_id"]))
        for r in rows
    ]
    opts = webauthn.generate_authentication_options(
        rp_id=_rp_id(),
        allow_credentials=allow,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _save_challenge(email, opts.challenge)
    return JSONResponse(content=json.loads(webauthn.options_to_json(opts)))


@router.post("/login/complete")
async def login_complete(body: dict):
    email = (body.get("email") or "").strip().lower()
    credential = body.get("credential")
    if not email or not credential:
        raise HTTPException(400, "Email y credencial son requeridos")

    challenge = _pop_challenge(email)
    supabase = get_supabase_client()

    cred_id = credential.get("id", "")
    rows = supabase.table("webauthn_credentials").select("*") \
        .eq("credential_id", cred_id).eq("email", email).execute().data
    if not rows:
        raise HTTPException(401, "Credencial no reconocida")
    row = rows[0]

    try:
        ver = webauthn.verify_authentication_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=_rp_id(),
            expected_origin=_origin(),
            credential_public_key=base64url_to_bytes(row["public_key"]),
            credential_current_sign_count=row["sign_count"],
            require_user_verification=True,
        )
    except Exception as e:
        raise HTTPException(401, f"Autenticación biométrica fallida: {e}")

    supabase.table("webauthn_credentials").update({"sign_count": ver.new_sign_count}) \
        .eq("id", row["id"]).execute()

    token = pyjwt.encode({
        "sub": row["user_id"],
        "email": email,
        "aud": "authenticated",
        "exp": int(time.time()) + 3600 * 8,
    }, settings.jwt_secret, algorithm="HS256")

    return {"access_token": token, "user_id": row["user_id"], "email": email}


# ── Estado y gestión ────────────────────────────────────────────────────────

@router.get("/status")
async def status(user_id: str = Depends(get_current_user)):
    supabase = get_supabase_client()
    rows = supabase.table("webauthn_credentials") \
        .select("credential_id,device_type,created_at") \
        .eq("user_id", user_id).execute().data or []
    return {"registered": bool(rows), "count": len(rows)}


@router.delete("/credential/{cred_id}")
async def delete_credential(cred_id: str, user_id: str = Depends(get_current_user)):
    supabase = get_supabase_client()
    supabase.table("webauthn_credentials").delete() \
        .eq("credential_id", cred_id).eq("user_id", user_id).execute()
    return {"ok": True}
