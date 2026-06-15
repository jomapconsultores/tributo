from pydantic_settings import BaseSettings
from functools import lru_cache

class Settings(BaseSettings):
    supabase_url: str
    supabase_service_key: str
    supabase_anon_key: str
    jwt_secret: str
    cors_origins: str = "http://localhost:5173,http://localhost:3000"
    frontend_url: str = "http://localhost:5173"
    environment: str = "development"
    max_ips_por_usuario: int = 3

    class Config:
        env_file = ".env"
        case_sensitive = False
        extra = "ignore"  # permite vars en .env no declaradas aquí (SMTP_*, ACTIVITY_NOTIFY_EMAIL, etc.)

@lru_cache()
def get_settings():
    return Settings()
