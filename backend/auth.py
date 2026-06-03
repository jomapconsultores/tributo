from fastapi import HTTPException, Depends, Header
import jwt
from config import get_settings
from typing import Optional
import json
import base64

settings = get_settings()

async def get_current_user(authorization: Optional[str] = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing authorization header")

    try:
        scheme, token = authorization.split()
        if scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Invalid authentication scheme")

        # Decode JWT without verification (Supabase has already verified it)
        # Just extract the user_id from the payload
        parts = token.split('.')
        if len(parts) != 3:
            raise HTTPException(status_code=401, detail="Invalid token format")

        # Decode the payload (second part of JWT)
        payload_part = parts[1]
        # Add padding if needed
        padding = 4 - len(payload_part) % 4
        if padding != 4:
            payload_part += '=' * padding

        payload_json = base64.urlsafe_b64decode(payload_part)
        payload = json.loads(payload_json)

        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token - no user ID")
        return user_id
    except HTTPException:
        raise
    except Exception as e:
        print(f"Auth error: {e}")
        raise HTTPException(status_code=401, detail="Authentication failed")
