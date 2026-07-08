import time
from fastapi import FastAPI, Depends, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from contextlib import asynccontextmanager
from config import get_settings
from routers import auth, invoices, classification, memory, clients, retentions, ice, resources, ice_calc, declaraciones, products, rebajas, anexos, access, admin, contacto, credentials, sales_iva, compradores, normativa, xml_originales, reportes, odoo_factura, capacitaciones, webauthn as webauthn_router, retenciones_efectuadas
from routers.access import require_module, require_submodule
import os
import sentry_sdk
from dotenv import load_dotenv

load_dotenv()

# --- Observabilidad (Sentry) — se activa SOLO si SENTRY_DSN está definido; si no, NO-OP total.
# Debe iniciarse ANTES de crear la app FastAPI para auto-instrumentar Starlette/FastAPI.
_sentry_dsn = os.environ.get("SENTRY_DSN", "")
if _sentry_dsn:
    sentry_sdk.init(
        dsn=_sentry_dsn,
        environment=os.environ.get("ENVIRONMENT", "production"),
        traces_sample_rate=float(os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "0")),
        send_default_pii=False,  # no enviar datos personales/credenciales
    )

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

app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts.split(","))


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
# (path_prefix, methods, limit, window_seconds)
_RATE_RULES = (
    ("/auth/login",   ("POST",), 12, 60),   # 12 intentos/min — fuerza bruta a login
    ("/auth/signup",  ("POST",), 12, 60),
    ("/auth/forgot",  ("POST",), 12, 60),
    ("/auth/reset",   ("POST",), 12, 60),
    ("/api/contacto", ("POST",), 12, 60),   # anti-spam de contacto
    # Login biométrico (WebAuthn): sin esto, /begin permite fuerza bruta Y
    # enumerar qué correos tienen biometría activada (responde distinto según
    # si el correo existe), sin ningún freno — el login con contraseña sí lo tenía.
    ("/api/webauthn/login", ("POST",), 12, 60),
    # Revelar TODAS las claves SRI de golpe: debe ser MÁS restrictivo que una
    # sola (era al revés: no tenía ningún límite). Se chequea antes que la regla
    # general de "/reveal" porque la primera regla que matchea es la que aplica.
    ("/api/credentials/", ("GET",), 3, 60, "/reveal-all"),
    # Acceso a credenciales SRI en plano: súper restrictivo (5/min) para detectar
    # exfiltración aún con sesión admin comprometida.
    ("/api/credentials/", ("GET",),  5, 60, "/reveal"),  # GET /api/credentials/{id}/reveal
    # Acceso a audit log o list también limitado pero menos estricto
    ("/api/credentials/audit-log", ("GET",), 30, 60),
)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    path = request.url.path
    method = request.method
    for rule in _RATE_RULES:
        prefix, methods = rule[0], rule[1]
        limit, ventana = rule[2], rule[3]
        suffix_match = rule[4] if len(rule) > 4 else None
        if method not in methods or not path.startswith(prefix):
            continue
        if suffix_match and not path.endswith(suffix_match):
            continue
        # OJO: se toma el ULTIMO valor de X-Forwarded-For, no el primero. El
        # primero es el que el propio visitante puede inventar antes de que la
        # peticion llegue al proxy real (Coolify); el proxy siempre AGREGA la IP
        # que el observo al final de la lista, y ese es el unico dato que un
        # atacante no puede falsificar. Tomar el primero (como estaba antes)
        # permite esquivar el limite rotando un X-Forwarded-For inventado en
        # cada intento.
        xff = request.headers.get("x-forwarded-for", "")
        partes = [p.strip() for p in xff.split(",") if p.strip()]
        ip = partes[-1] if partes else (request.client.host if request.client else "x")
        now = time.time()
        key = (ip, prefix, suffix_match or "")
        arr = [t for t in _RATE.get(key, []) if now - t < ventana]
        if len(arr) >= limit:
            return JSONResponse(status_code=429, content={"detail": "Demasiados intentos. Espera un momento."})
        arr.append(now)
        _RATE[key] = arr
        break  # Solo aplica la primera regla que matchea
    return await call_next(request)


# --- Bitácora de movimientos: registra AUTOMÁTICAMENTE toda acción que cambia
# datos (POST/PUT/DELETE exitosos). Garantiza que quede "absolutamente todo",
# sin tener que enganchar cada endpoint a mano. Los flujos con detalle fino
# (subidas con cantidad/contribuyente, declaraciones, etc.) ya se registran en
# sus routers; aquí se omiten para no duplicar. ----------------------------
import threading as _threading
from services.activity import registrar as _registrar
from auth import decode_token

# OJO: estas son categorías de visualización para la bitácora de Movimientos
# (columna `module` de activity_log), NO tienen relación con MODULOS de
# access.py (los módulos contratados que controlan permisos) — comparten la
# palabra "módulo" mas no el mismo concepto; de ahí el prefijo _AUDIT_ y el
# nombre CATEGORIES en vez de LABELS/MODULOS para no confundirlos.
_AUDIT_CATEGORIES = {
    "invoices":       ("Facturas de gastos", "gastos"),
    "classification": ("Clasificación de gastos", "gastos"),
    "sales-iva":      ("Ingresos IVA", "ingresos_iva"),
    "ice":            ("Ventas ICE", "ingresos_ice"),
    "ice-calc":       ("Cálculo ICE", "ingresos_ice"),
    "products":       ("Catálogo de productos", "ingresos_ice"),
    "rebajas":        ("Rebajas y exenciones", "ingresos_ice"),
    "compradores":    ("Compradores", "ingresos_ice"),
    "retentions":     ("Retenciones", "retenciones"),
    "declaraciones":  ("Declaración", "declaraciones"),
    "anexos":         ("Anexo", "anexos"),
    "clients":        ("Cliente", "clientes"),
    "reportes":       ("Honorarios / reportes", "facturacion"),
    "odoo":           ("Facturación Odoo", "facturacion"),
}
_AUDIT_ACTION = {"POST": "create", "PUT": "update", "PATCH": "update", "DELETE": "delete"}


def _audit_ya_registrado(method: str, path: str) -> bool:
    """True para los endpoints que YA se registran en detalle en su router."""
    if path.endswith("/process-xml") or path.endswith("/process-txt"):
        return True
    if method == "POST" and path.rstrip("/") in (
        "/api/declaraciones", "/api/anexos", "/api/clients", "/api/odoo/facturar"):
        return True
    return False


def _audit_uid(request: Request):
    """Quien hizo la accion, para la bitacora de Movimientos. Reusa la misma
    verificacion de firma que get_current_user (antes decodificaba el JWT sin
    comprobar nada, solo para leer `sub` — funcionalmente inofensivo porque
    esto solo corre sobre respuestas ya exitosas de un request ya autenticado,
    pero mantenerlo consistente evita tener dos formas de leer el mismo token)."""
    auth = request.headers.get("authorization")
    if not auth:
        return None
    try:
        scheme, token = auth.split()
        if scheme.lower() != "bearer":
            return None
        return decode_token(token)
    except Exception:
        return None


@app.middleware("http")
async def audit_mutaciones(request: Request, call_next):
    response = await call_next(request)
    try:
        method = request.method
        if method in _AUDIT_ACTION and response.status_code < 400:
            path = request.url.path
            segs = path.split("/")
            if len(segs) >= 3 and segs[1] == "api":
                seg = segs[2]
                if seg in _AUDIT_CATEGORIES and not _audit_ya_registrado(method, path):
                    uid = _audit_uid(request)
                    if uid:
                        label, module = _AUDIT_CATEGORIES[seg]
                        low = path.lower()
                        action = _AUDIT_ACTION[method]
                        if low.endswith("/clear") or "bulk-delete" in low:
                            action = "delete"
                        elif "bulk-move" in low:
                            action = "update"
                        client_id = request.query_params.get("client_id")
                        _threading.Thread(
                            target=_registrar,
                            kwargs=dict(actor_user_id=uid, action=action, module=module,
                                        entity=label, client_id=client_id,
                                        metadata={"path": path, "method": method}),
                            daemon=True,
                        ).start()
    except Exception as e:
        print(f"[audit] {e}")
    return response


# Include routers — núcleo (sin restricción de módulo)
app.include_router(auth.router)
app.include_router(access.router)
app.include_router(admin.router)
app.include_router(credentials.router)
app.include_router(contacto.router)
app.include_router(clients.router)
app.include_router(memory.router)
app.include_router(normativa.router)  # información útil: cuerpos legales consultables

# Módulos contratables (bloqueados si el usuario no los tiene)
GASTOS = [Depends(require_module("gastos"))]
RETEN = [Depends(require_module("retenciones"))]
ICEMOD = [Depends(require_module("ingresos_ice"))]
DECL = [Depends(require_module("declaraciones"))]
AGRET = [Depends(require_module("agente_retencion"))]

# Submódulos: routers de UNA sola pantalla se gatean por submódulo (que a su vez
# valida el módulo padre). Default = permitido si el admin no restringió.
def SUB(sub):
    return [Depends(require_submodule(sub))]

app.include_router(classification.router, dependencies=SUB("gastos_clasificar"))
app.include_router(invoices.router, dependencies=SUB("gastos_facturas"))
app.include_router(retentions.router, dependencies=RETEN)
app.include_router(retenciones_efectuadas.router, dependencies=SUB("agret_retenciones"))
app.include_router(ice.router, dependencies=SUB("ice_xml"))
app.include_router(ice_calc.router, dependencies=SUB("ice_calculo"))
app.include_router(sales_iva.router, dependencies=SUB("ice_ingresos_iva"))
app.include_router(products.router, dependencies=SUB("ice_catalogo"))
app.include_router(rebajas.router, dependencies=SUB("ice_rebajas"))
app.include_router(anexos.router, dependencies=SUB("ice_anexo"))
app.include_router(compradores.router, dependencies=SUB("ice_compradores"))
app.include_router(resources.router, dependencies=ICEMOD)  # referencia compartida: solo módulo
app.include_router(declaraciones.router, dependencies=DECL)  # submódulo IVA/ICE/103 se valida por tipo en el router
app.include_router(xml_originales.router)  # descarga de XML originales (gastos/ingresos/retenciones)
app.include_router(reportes.router)  # REPORTES: honorarios a cobrar por contribuyente/producto
app.include_router(odoo_factura.router)  # ODOO: facturación directa (solo admin)
app.include_router(capacitaciones.router)  # CAPACITACIONES: reservas con autorización de socio/admin
app.include_router(webauthn_router.router)  # WEBAUTHN: biometría (huella/rostro)

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
