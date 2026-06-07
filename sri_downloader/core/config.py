"""Carga de configuración de clientes.

clientes.local.json (gitignored) contiene { "clientes": [ {ruc, clave, alias}, ... ] }.
Las credenciales nunca salen de la PC; el archivo es plano pero está en .gitignore.
Si en el futuro querés cifrado, agregamos Fernet con master password en .env.local.
"""
import json
from pathlib import Path
from typing import Optional

BASE_DIR = Path(__file__).resolve().parent.parent
CLIENTES_FILE = BASE_DIR / "clientes.local.json"
DESCARGAS_DIR = BASE_DIR / "descargas"
PLAYWRIGHT_STATE_DIR = BASE_DIR / "playwright_state"


def cargar_clientes() -> list[dict]:
    if not CLIENTES_FILE.exists():
        raise FileNotFoundError(
            f"Falta {CLIENTES_FILE}. Copiá clientes.example.json a clientes.local.json "
            "y completá los RUCs y claves de tus clientes."
        )
    data = json.loads(CLIENTES_FILE.read_text(encoding="utf-8"))
    clientes = data.get("clientes", [])
    if not clientes:
        raise ValueError(f"{CLIENTES_FILE} no contiene ningún cliente.")
    return clientes


def buscar_cliente(ruc: str) -> Optional[dict]:
    ruc = (ruc or "").strip()
    for c in cargar_clientes():
        if str(c.get("ruc", "")).strip() == ruc:
            return c
    return None


def dir_descargas_cliente(ruc: str) -> Path:
    p = DESCARGAS_DIR / ruc
    p.mkdir(parents=True, exist_ok=True)
    return p


def dir_state_cliente(ruc: str) -> Path:
    p = PLAYWRIGHT_STATE_DIR / ruc
    p.mkdir(parents=True, exist_ok=True)
    return p
