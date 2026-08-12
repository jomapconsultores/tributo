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


def _normalizar(valor) -> str:
    """Limpia lo que rodea a la llave en la variable de entorno.

    Pegar la llave en el panel del servidor con comillas ("abc…=") o con un
    espacio o salto de línea al final es lo más fácil del mundo, y Fernet la
    rechaza entera: el sistema se comporta como si NO hubiera llave y todo deja
    de guardarse y de leerse. Un `strip` acá evita esa clase de tarde perdida.
    También se acepta que hayan pegado "NOMBRE=llave" de más."""
    if not isinstance(valor, str):
        valor = (valor or b"").decode("utf-8", "ignore")
    v = valor.strip().strip('"').strip("'").strip()
    if v.upper().startswith("CREDENTIALS_MASTER_KEY"):
        # La llave termina en '=', así que se corta por el PRIMER '=' (el del
        # asignado), nunca por el último.
        _, _, resto = v.partition("=")
        v = resto.strip().strip('"').strip("'").strip()
    # Reponer el relleno de base64. Una llave Fernet son 32 bytes que en
    # base64url dan 44 caracteres terminados en '='. Ese '=' final es RELLENO:
    # no lleva información, y se pierde con una facilidad pasmosa —al copiar, al
    # pasar por un parser de variables de entorno, al recortar un espacio—.
    # Reponerlo devuelve exactamente la llave que era; no adivina ni inventa
    # nada. Sin esto, un carácter de relleno perdido en el panel del servidor
    # deja ilegible TODO lo cifrado, que es justo lo que pasó acá: la llave
    # estaba puesta, con 43 caracteres.
    if v and len(v) % 4:
        v += "=" * (4 - len(v) % 4)
    return v


def _fernet(valor, nombre: str) -> Fernet:
    limpio = _normalizar(valor)
    try:
        return Fernet(limpio.encode())
    except Exception as e:
        # Sin filtrar la llave: solo lo que hace falta para corregirla.
        raise RuntimeError(
            f"{nombre} no es una llave válida ({len(limpio)} caracteres; se esperan 44 "
            f"en base64url terminados en '='). Detalle: {e.__class__.__name__}"
        )


def _load_keys() -> dict:
    """Carga llaves desde env. V1 = CREDENTIALS_MASTER_KEY; V2 = CREDENTIALS_MASTER_KEY_V2; …"""
    keys: dict = {}
    primary = os.getenv("CREDENTIALS_MASTER_KEY")
    if not primary or not _normalizar(primary):
        raise RuntimeError(
            "CREDENTIALS_MASTER_KEY no está configurada. Generala con: "
            "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\" "
            "y pégala en las env vars del backend."
        )
    keys[1] = _fernet(primary, "CREDENTIALS_MASTER_KEY")
    v = 2
    while True:
        k = os.getenv(f"CREDENTIALS_MASTER_KEY_V{v}")
        if not k or not _normalizar(k):
            break
        keys[v] = _fernet(k, f"CREDENTIALS_MASTER_KEY_V{v}")
        v += 1
    return keys


def estado_llaves() -> dict:
    """Qué llaves ve el servidor y, si no ve ninguna, POR QUÉ.

    Es lo que convierte "no se puede guardar" en algo accionable: distingue
    "no está la variable" de "está pero mal pegada", que se arreglan distinto.
    Nunca devuelve el valor de una llave."""
    try:
        llaves = _keys()
        return {"configurada": True, "cantidad": len(llaves), "motivo": ""}
    except Exception as e:
        return {"configurada": False, "cantidad": 0, "motivo": str(e)}


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
