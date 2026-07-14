"""Cliente del tributos-api (iteración 4: upload automático).

La config vive en clientes.local.json, clave raíz "api":

    {
      "api": {
        "base_url": "http://localhost:8000",
        "email": "usuario@ejemplo.com",
        "password": "..."
      },
      "clientes": [ ... ]
    }

El TXT del listado del SRI se sube tal cual a POST /api/invoices/process-txt:
el backend extrae las claves de acceso y baja los XML por SOAP, con la misma
clasificación automática que una subida manual desde la web.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import httpx

from core.config import CLIENTES_FILE


class ApiError(Exception):
    pass


def _config_api() -> dict:
    data = json.loads(CLIENTES_FILE.read_text(encoding="utf-8"))
    api = data.get("api") or {}
    if not api.get("base_url") or not api.get("email") or not api.get("password"):
        raise ApiError(
            'Falta la config "api" en clientes.local.json. Agregá:\n'
            '  "api": {"base_url": "https://tu-api", "email": "...", "password": "..."}'
        )
    return api


class TributosApi:
    def __init__(self):
        cfg = _config_api()
        self.base = cfg["base_url"].rstrip("/")
        self._client = httpx.Client(timeout=httpx.Timeout(330.0, connect=15.0))
        r = self._client.post(
            f"{self.base}/auth/login",
            json={"email": cfg["email"], "password": cfg["password"]},
        )
        if r.status_code != 200:
            raise ApiError(f"Login al API falló ({r.status_code}): {r.text[:300]}")
        token = (r.json() or {}).get("access_token") or (r.json() or {}).get("token")
        if not token:
            raise ApiError(f"Login OK pero no vino token: {r.text[:300]}")
        self._client.headers["Authorization"] = f"Bearer {token}"

    def buscar_client_id(self, identificacion: str, mes: int, anio: int) -> Optional[str]:
        """clients.id del contribuyente EN ESE PERÍODO (cada período es una fila)."""
        r = self._client.get(f"{self.base}/api/clients/")
        r.raise_for_status()
        rows = r.json()
        if isinstance(rows, dict):
            rows = rows.get("data") or []
        for c in rows:
            if (
                str(c.get("identificacion", "")).strip() == identificacion
                and int(c.get("periodo_mes") or 0) == mes
                and int(c.get("periodo_anio") or 0) == anio
            ):
                return c.get("id")
        return None

    def subir_txt_gastos(self, client_id: str, txt_path: Path) -> dict:
        """Sube el listado TXT a /api/invoices/process-txt (gastos/compras)."""
        with open(txt_path, "rb") as fh:
            r = self._client.post(
                f"{self.base}/api/invoices/process-txt",
                data={"client_id": client_id},
                files={"file": (txt_path.name, fh, "text/plain")},
            )
        if r.status_code != 200:
            raise ApiError(f"Upload falló ({r.status_code}): {r.text[:500]}")
        return r.json()

    def subir_txt_retenciones(self, client_id: str, txt_path: Path) -> dict:
        """Sube el listado TXT a /api/retentions/process-txt (retenciones RECIBIDAS).

        El listado tipo=retención del portal de Comprobantes RECIBIDOS son las
        retenciones que terceros le hicieron al cliente → tabla `retentions`, NO
        `retenciones_efectuadas` (esas son las que el cliente EMITE como agente,
        y salen del portal de Emitidos). Espejo de subir_txt_gastos: el backend
        extrae las claves, baja los XML por SOAP y los guarda como retenciones."""
        with open(txt_path, "rb") as fh:
            r = self._client.post(
                f"{self.base}/api/retentions/process-txt",
                data={"client_id": client_id},
                files={"file": (txt_path.name, fh, "text/plain")},
            )
        if r.status_code != 200:
            raise ApiError(f"Upload falló ({r.status_code}): {r.text[:500]}")
        return r.json()

    def subir_txt_ventas(self, client_id: str, txt_path: Path) -> dict:
        """Sube el listado TXT a /api/sales-iva/process-txt (ingresos/ventas).

        Espejo de subir_txt_gastos: el backend extrae las claves de acceso, baja
        los XML emitidos por SOAP y los guarda como ingresos IVA (ventas).
        OJO: la respuesta de este endpoint viene en ESPAÑOL
        (nuevas/duplicadas/errores/rechazadas_por_ice/fuera_de_periodo)."""
        with open(txt_path, "rb") as fh:
            r = self._client.post(
                f"{self.base}/api/sales-iva/process-txt",
                data={"client_id": client_id},
                files={"file": (txt_path.name, fh, "text/plain")},
            )
        if r.status_code != 200:
            raise ApiError(f"Upload falló ({r.status_code}): {r.text[:500]}")
        return r.json()

    def close(self):
        self._client.close()
