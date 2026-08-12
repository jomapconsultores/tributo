# ------------------------------------------------------------
# Desarrollado por Marco Antonio Posligua San Martín
# ------------------------------------------------------------
"""Cifrado/descifrado de credenciales de servicios externos (portal SRI, IESS, etc.).

Modelo de amenaza:
- Atacante con SELECT a la tabla service_credentials → ve ciphertext inútil sin MASTER_KEY.
- Atacante con la anon key de Supabase → ya no puede leer la tabla (RLS activado, sin policies).
- Atacante con el bundle JS del frontend → la MASTER_KEY NO está ahí, solo en el backend (env vars del servidor).
- Atacante con la MASTER_KEY → puede descifrar todo. Por eso vive solo en env var y nunca en repo.

Recuperación: al descifrar se prueban TODAS las llaves configuradas, no solo la de
la key_version de la fila. Si alguna vez se cambió CREDENTIALS_MASTER_KEY sin migrar,
las filas viejas siguen diciendo key_version=1 y con la llave nueva no abren; en vez de
darlas por perdidas, basta con agregar la llave vieja al entorno (como V2, V3…) y
vuelven a leerse sin tocar un registro.

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
    """Descifra probando primero la llave declarada y, si no, TODAS las demás.

    El key_version dice con cuál se cifró, pero es un dato de la fila y la fila
    puede mentir: si alguna vez se cambió CREDENTIALS_MASTER_KEY sin migrar, las
    filas siguen diciendo 1 y con la llave 1 de ahora ya no abren. Probar solo la
    versión declarada convierte eso en pérdida total; probando todas, recuperar
    el acceso es pegar la llave vieja en el entorno (como V2, V3…) y listo, sin
    tocar un solo registro. No debilita nada: sin la llave correcta, ninguna
    abre — Fernet autentica el mensaje, no hay forma de acertar por azar.
    """
    llaves = _keys()
    datos = ciphertext_ascii.encode("ascii")
    orden = [key_version] + [v for v in sorted(llaves) if v != key_version]
    for v in orden:
        f = llaves.get(v)
        if f is None:
            continue
        try:
            return f.decrypt(datos).decode("utf-8")
        except InvalidToken:
            continue
    if not llaves:
        raise RuntimeError("No hay ninguna llave de cifrado configurada en el servidor")
    raise RuntimeError(
        f"Ninguna de las {len(llaves)} llave(s) configuradas descifra esta credencial "
        f"(se guardó con key_version={key_version}). Falta la llave con la que se cifró: "
        "agregala al entorno como CREDENTIALS_MASTER_KEY_V2 y vuelve a abrirse sola."
    )


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
