from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import get_current_user
from database import get_supabase_client

router = APIRouter(prefix="/api/memory", tags=["memory"])

class CardMemoryEntry(BaseModel):
    mem_key: str
    tarjeta_credito: str

@router.get("/")
async def get_memory(user_id: str = Depends(get_current_user)):
    try:
        supabase = get_supabase_client()
        response = supabase.table("card_memory")\
            .select("*")\
            .eq("user_id", user_id)\
            .execute()
        return response.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/")
async def save_memory(
    entry: CardMemoryEntry,
    user_id: str = Depends(get_current_user)
):
    try:
        supabase = get_supabase_client()

        existing = supabase.table("card_memory")\
            .select("*")\
            .eq("user_id", user_id)\
            .eq("mem_key", entry.mem_key)\
            .execute()

        if existing.data:
            response = supabase.table("card_memory")\
                .update({
                    "tarjeta_credito": entry.tarjeta_credito,
                    "updated_at": "now()"
                })\
                .eq("user_id", user_id)\
                .eq("mem_key", entry.mem_key)\
                .execute()
        else:
            response = supabase.table("card_memory")\
                .insert({
                    "user_id": user_id,
                    "mem_key": entry.mem_key,
                    "tarjeta_credito": entry.tarjeta_credito
                })\
                .execute()

        return response.data[0] if response.data else None
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
