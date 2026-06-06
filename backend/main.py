from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from contextlib import asynccontextmanager
from config import get_settings
from routers import auth, invoices, classification, memory, clients, retentions, ice, resources, ice_calc, declaraciones, products, rebajas, anexos, access
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

# Include routers — núcleo (sin restricción de módulo)
app.include_router(auth.router)
app.include_router(access.router)
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

@app.get("/debug")
async def debug():
    from database import get_supabase_client
    sb = get_supabase_client()
    r = sb.table("invoices").select("id", count="exact").execute()
    return {"invoices_in_db": r.count, "backend": "OK"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
