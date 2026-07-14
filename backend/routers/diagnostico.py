"""Diagnóstico de conectividad (Fase 0 del scraping SRI server-side).

Prueba, DESDE EL SERVIDOR, si se puede alcanzar el portal del SRI
(srienlinea.sri.gob.ec, login Keycloak) — que es el host que habría que scrapear
para bajar los listados de comprobantes. Se compara contra el SOAP
(cel.sri.gob.ec) que ya funciona en producción, como baseline.

NOTA: endpoint temporal/ops. Es PÚBLICO a propósito (para poder llamarlo sin
sesión durante la validación) y solo consulta URLs FIJAS del SRI — no recibe
input del usuario, así que no hay riesgo de SSRF. Quitar o proteger tras la Fase 0.
"""
import time
import requests
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/diagnostico", tags=["diagnostico"])

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")

_PERFIL_URL = "https://srienlinea.sri.gob.ec/sri-en-linea/contribuyente/perfil"
_HOST = "srienlinea.sri.gob.ec"
_USER_SEL = "input#username, input[name='username'], input#usuario, input[name='usuario']"
_PASS_SEL = "input#password, input[name='password'], input#clave, input[name='clave']"
_SUBMIT_SEL = "input#kc-login, button[type='submit'], input[type='submit']"
_CAPTCHA_SEL = "iframe[src*='recaptcha'], .g-recaptcha, [class*='captcha'], [id*='captcha']"


def _probe(url: str, timeout: int = 15) -> dict:
    t0 = time.monotonic()
    try:
        r = requests.get(url, timeout=timeout, allow_redirects=True,
                         headers={"User-Agent": _UA,
                                  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"})
        low = (r.text or "").lower()
        return {
            "url": url,
            "ok": True,
            "status": r.status_code,
            "final_url": str(r.url),
            "elapsed_ms": round((time.monotonic() - t0) * 1000),
            "bytes": len(r.content or b""),
            "parece_login": any(k in low for k in ("keycloak", "j_username", "kc-login", "id=\"username\"", "name=\"password\"", "name=\"clave\"")),
            "parece_bloqueo": r.status_code in (403, 429, 503) or any(k in low for k in ("access denied", "forbidden", "cloudflare", "captcha", "recaptcha", "just a moment")),
        }
    except requests.exceptions.Timeout:
        return {"url": url, "ok": False, "error": "timeout", "elapsed_ms": round((time.monotonic() - t0) * 1000)}
    except Exception as e:
        return {"url": url, "ok": False, "error": str(e)[:200], "elapsed_ms": round((time.monotonic() - t0) * 1000)}


@router.get("/sri-portal")
async def sri_portal():
    """Fase 0: ¿el servidor alcanza el portal del SRI (login) y el SOAP (baseline)?"""
    return {
        "portal_perfil": _probe("https://srienlinea.sri.gob.ec/sri-en-linea/contribuyente/perfil"),
        "portal_tuportal": _probe("https://srienlinea.sri.gob.ec/tuportal-internet/"),
        "soap_baseline": _probe("https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"),
    }


class _LoginIn(BaseModel):
    ruc: str
    clave: str


async def _sri_login_test(ruc: str, clave: str) -> dict:
    """Login headless al portal SRI (Keycloak) DESDE EL SERVIDOR con Playwright.
    Replica el flujo de sri_downloader/core/sri_login.py. Solo prueba: no descarga
    ni guarda nada. Detecta captcha, credenciales rechazadas y timeouts."""
    from playwright.async_api import async_playwright, TimeoutError as PWT
    res = {"ok": False}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            ctx = await browser.new_context(user_agent=_UA, viewport={"width": 1366, "height": 820}, locale="es-EC")
            page = await ctx.new_page()
            page.set_default_timeout(30000)
            await page.goto(_PERFIL_URL, wait_until="domcontentloaded", timeout=45000)
            try:
                await page.wait_for_url("**/auth/realms/**", timeout=20000)
            except PWT:
                if _HOST in page.url and "auth/realms" not in page.url:
                    res.update(ok=True, resultado="sesion ya activa (sin login)", final_url=page.url)
                    return res
                raise
            res["captcha_detectado"] = bool(await page.query_selector(_CAPTCHA_SEL))
            await page.fill(_USER_SEL, ruc)
            await page.fill(_PASS_SEL, clave)
            await page.click(_SUBMIT_SEL)
            try:
                await page.wait_for_url(f"**{_HOST}/**", timeout=60000)
                if _HOST in page.url and "auth/realms" not in page.url:
                    res.update(ok=True, resultado="login exitoso", final_url=page.url)
                else:
                    res.update(ok=False, resultado="quedo en keycloak tras submit", final_url=page.url)
            except PWT:
                body = (await page.content()).lower()
                if any(m in body for m in ("credenciales", "inválid", "invalido", "incorrect")):
                    res.update(ok=False, resultado="credenciales rechazadas por el SRI", final_url=page.url)
                elif _HOST in page.url and "auth/realms" not in page.url:
                    res.update(ok=True, resultado="login exitoso (redirect lento)", final_url=page.url)
                else:
                    res.update(ok=False, resultado="timeout tras submit (posible captcha/2FA)",
                               final_url=page.url, captcha_detectado=bool(await page.query_selector(_CAPTCHA_SEL)))
        except Exception as e:
            res.update(ok=False, error=str(e)[:250])
        finally:
            await browser.close()
    return res


@router.post("/sri-login")
async def sri_login(body: _LoginIn):
    """Fase 0b: prueba de login headless al portal SRI con credenciales pasadas
    explícitamente. Endpoint TEMPORAL — quitar tras la validación."""
    t0 = time.monotonic()
    res = await _sri_login_test((body.ruc or "").strip(), body.clave or "")
    res["elapsed_ms"] = round((time.monotonic() - t0) * 1000)
    res["ruc"] = (body.ruc or "").strip()
    return res
