from supabase import create_client, Client
from config import get_settings
from functools import lru_cache

settings = get_settings()

@lru_cache()
def get_supabase_client() -> Client:
    return create_client(settings.supabase_url, settings.supabase_service_key)

def get_supabase_client_anon() -> Client:
    return create_client(settings.supabase_url, settings.supabase_anon_key)
