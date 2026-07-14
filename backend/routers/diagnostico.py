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

router = APIRouter(prefix="/api/diagnostico", tags=["diagnostico"])

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


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
