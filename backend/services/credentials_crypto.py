"""Cifrado/descifrado de credenciales de servicios externos (portal SRI, IESS, etc.).

Modelo de amenaza:
- Atacante con SELECT a la tabla service_credentials → ve ciphertext inútil sin MASTER_KEY.
- Atacante con la anon key de Supabase → ya no puede leer la tabla (RLS activado, sin policies).
- Atacante con el bundle JS del frontend → la MASTER_KEY NO está ahí, solo en el backend (env vars del servidor).
- Atacante con la MASTER_KEY → puede descifrar todo. Por eso vive solo en env var y nunca en repo.

Rotación: cada ciphertext lleva su key_version. Para rotar:
  1) Generar CREDENTIALS_MASTER_KEY_V2 y agregarla a env (sin borrar V1).
  2) Actualizar CURRENT_KEY_VERSION abajo a 2 y deployar.
  3) Las nuevas escrituras usan V2; las lecturas viejas siguen funcionando con V1.
  4) Migración asíncrona puede re-cifrar los registros con key_version=1 a 2.
  5) Cuando no queden filas con key_version=1, eliminar CREDENTIALS_MASTER_KEY del env.
"""
import os
from cryptography.fernet import Fernet, InvalidToken

CURRENT_KEY_VERSION = 1


def _load_keys() -> dict:
    """Carga llaves desde env. V1 = CREDENTIALS_MASTER_KEY; V2 = CREDENTIALS_MASTER_KEY_V2; …"""
    keys: dict = {}
    primary = os.getenv("CREDENTIALS_MASTER_KEY")
    if not primary:
        raise RuntimeError(
            "CREDENTIALS_MASTER_KEY no está configurada. Generala con: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
            "y pégala en las env vars del backend."
        )
    keys[1] = Fernet(primary.encode() if isinstance(primary, str) else primary)
    v = 2
    while True:
        k = os.getenv(f"CREDENTIALS_MASTER_KEY_V{v}")
        if not k:
            break
        keys[v] = Fernet(k.encode() if isinstance(k, str) else k)
        v += 1
    return keys


_KEYS = None


def _keys() -> dict:
    global _KEYS
    if _KEYS is None:
        _KEYS = _load_keys()
    return _KEYS


def encrypt(plaintext: str) -> tuple:
    """Devuelve (ciphertext_ascii, key_version). Ciphertext es Fernet base64-url ASCII."""
    if not plaintext:
        raise ValueError("plaintext vacío")
    kv = CURRENT_KEY_VERSION
    f = _keys().get(kv)
    if f is None:
        raise RuntimeError(f"No hay llave para key_version={kv}")
    token = f.encrypt(plaintext.encode("utf-8"))
    return token.decode("ascii"), kv


def decrypt(ciphertext_ascii: str, key_version: int) -> str:
    f = _keys().get(key_version)
    if f is None:
        raise RuntimeError(
            f"No hay llave para key_version={key_version}. ¿Falta CREDENTIALS_MASTER_KEY_V{key_version} en env?"
        )
    try:
        return f.decrypt(ciphertext_ascii.encode("ascii")).decode("utf-8")
    except InvalidToken:
        raise RuntimeError("Ciphertext corrupto o llave incorrecta")


def key_configured() -> bool:
    """True si hay una llave maestra disponible (sin lanzar excepción)."""
    try:
        _keys()
        return True
    except Exception:
        return False


def can_decrypt(ciphertext_ascii: str, key_version: int) -> bool:
    """True si el ciphertext se puede descifrar con la llave actual.
    Sirve para detectar credenciales cifradas con una llave anterior (deben reingresarse)."""
    try:
        decrypt(ciphertext_ascii, key_version)
        return True
    except Exception:
        return False
