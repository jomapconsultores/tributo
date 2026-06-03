from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import get_supabase_client_anon
from config import get_settings

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

@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest):
    try:
        supabase = get_supabase_client_anon()
        response = supabase.auth.sign_in_with_password({
            "email": request.email,
            "password": request.password
        })

        return AuthResponse(
            access_token=response.session.access_token,
            user_id=response.user.id,
            email=response.user.email
        )
    except Exception as e:
        raise HTTPException(status_code=401, detail=str(e))

@router.post("/signup", response_model=AuthResponse)
async def signup(request: SignupRequest):
    try:
        supabase = get_supabase_client_anon()
        response = supabase.auth.sign_up({
            "email": request.email,
            "password": request.password
        })

        if response.user:
            return AuthResponse(
                access_token=response.session.access_token if response.session else "",
                user_id=response.user.id,
                email=response.user.email
            )
        raise HTTPException(status_code=400, detail="Signup failed")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/logout")
async def logout():
    return {"message": "Logged out successfully"}
