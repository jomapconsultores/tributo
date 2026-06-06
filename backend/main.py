import time
from fastapi import FastAPI, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from contextlib import asynccontextmanager
from config import get_settings
from routers import auth, invoices, classification, memory, clients, retentions, ice, resources, ice_calc, declaraciones, products, rebajas, anexos, access, admin, contacto
from routers.access import require_module
import os
from dotenv import load_dotenv

load_dotenv()

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Starting Tributos API")
    yield
    print("Shutting down Tributos API")

app = FastAPI(
    title="Gestor SRI Web API",
    description="API para procesar y clasificar facturas SRI",
    version="1.0.0",
    lifespan=lifespan
)

settings = get_settings()

# CORS
allowed_origins = settings.cors_origins.split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "*.onrender.com"])


# --- Endurecimiento: cabeceras de seguridad ---
@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    return resp


# --- Endurecimiento: límite de peticiones a rutas sensibles (anti fuerza bruta/spam) ---
_RATE = {}
_SENSIBLES = ("/auth/login", "/auth/signup", "/auth/forgot", "/auth/reset", "/api/contacto")
_LIMITE, _VENTANA = 12, 60  # 12 intentos por minuto por IP


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    path = request.url.path
    if request.method == "POST" and any(path.startswith(p) for p in _SENSIBLES):
        xff = request.headers.get("x-forwarded-for", "")
        ip = xff.split(",")[0].strip() or (request.client.host if request.client else "x")
        now = time.time()
        key = (ip, path)
        arr = [t for t in _RATE.get(key, []) if now - t < _VENTANA]
        if len(arr) >= _LIMITE:
            return JSONResponse(status_code=429, content={"detail": "Demasiados intentos. Espera un momento."})
        arr.append(now)
        _RATE[key] = arr
    return await call_next(request)

# Include routers — núcleo (sin restricción de módulo)
app.include_router(auth.router)
app.include_router(access.router)
app.include_router(admin.router)
app.include_router(contacto.router)
app.include_router(clients.router)
app.include_router(memory.router)

# Módulos contratables (bloqueados si el usuario no los tiene)
GASTOS = [Depends(require_module("gastos"))]
RETEN = [Depends(require_module("retenciones"))]
ICEMOD = [Depends(require_module("ingresos_ice"))]
DECL = [Depends(require_module("declaraciones"))]

app.include_router(classification.router, dependencies=GASTOS)
app.include_router(invoices.router, dependencies=GASTOS)
app.include_router(retentions.router, dependencies=RETEN)
app.include_router(ice.router, dependencies=ICEMOD)
app.include_router(ice_calc.router, dependencies=ICEMOD)
app.include_router(products.router, dependencies=ICEMOD)
app.include_router(rebajas.router, dependencies=ICEMOD)
app.include_router(anexos.router, dependencies=ICEMOD)
app.include_router(resources.router, dependencies=ICEMOD)
app.include_router(declaraciones.router, dependencies=DECL)

@app.get("/")
async def root():
    return {"message": "Gestor SRI Web API", "version": "1.0.0"}

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

if settings.environment != "production":
    @app.get("/debug")
    async def debug():
        from database import get_supabase_client
        sb = get_supabase_client()
        r = sb.table("invoices").select("id", count="exact").execute()
        return {"invoices_in_db": r.count, "backend": "OK"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
