from fastapi import HTTPException, Depends, Header
import jwt
from jwt import PyJWKClient
from config import get_settings
from typing import Optional

settings = get_settings()

# Tokens de sesion normales (login email/password) los firma Supabase con sus
# claves asimetricas del proyecto (ES256/RS256, rotan rara vez) — se verifican
# contra el JWKS publico del proyecto. PyJWKClient cachea las claves, asi que
# no hay un round-trip de red en cada request, solo cuando cambia el `kid` o
# vence el cache.
_jwks_client = PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json", cache_keys=True)


def decode_token(token: str) -> Optional[str]:
    """Verifica un JWT (firma + expiracion + audiencia) y devuelve el user_id
    (claim `sub`), o None si no es valido. Logica compartida por
    get_current_user (dependency de FastAPI) y por el middleware de auditoria
    en main.py (_audit_uid) — antes ese middleware decodificaba el JWT sin
    verificar nada (solo base64 del payload), duplicando el mismo bug que
    tenia get_current_user antes de este fix."""
    try:
        try:
            # Caso normal: token de sesion real emitido por Supabase (ES256/RS256).
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token, signing_key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
            )
        except Exception:
            # Caso alterno: token propio del login biometrico (webauthn.py lo
            # firma con HS256 usando settings.jwt_secret, no con las claves de Supabase).
            payload = jwt.decode(
                token, settings.jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        return payload.get("sub")
    except Exception:
        return None


async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")

    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")

        user_id = decode_token(token)
        if not user_id:
            raise HTTPException(status_code=401, detail="Authentication failed")
        return user_id
    except HTTPException:
        raise
    except Exception as e:
        print(f"Auth error: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")
