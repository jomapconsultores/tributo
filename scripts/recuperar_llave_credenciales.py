"""Recupera la llave de cifrado de credenciales cuando quedó dañada al copiarla.

POR QUÉ EXISTE: la llave (CREDENTIALS_MASTER_KEY) vive en las variables de
entorno del servidor y se copia a mano. Perder un carácter al pegarla —o que un
panel recorte el '=' del final— deja ilegibles TODAS las credenciales guardadas,
sin ninguna vía de recuperación desde la aplicación.

Pero una llave a la que le falta o le sobra UN carácter no está perdida: el
espacio de búsqueda es de unos pocos miles de combinaciones y se prueba cada una
contra una credencial real. Si alguna descifra, esa es la llave original.

    python scripts/recuperar_llave_credenciales.py llave_rota.txt

`llave_rota.txt` es un archivo con el valor tal cual está en el servidor (así no
viaja por chat ni queda en el historial de la terminal). El ciphertext contra el
que se prueba se toma de la base con las credenciales de backend/.env, o se pasa
con --cifrado.

La llave recuperada NO se imprime: se guarda en `llave_recuperada.txt`, al lado
del archivo de entrada, para copiarla de ahí al panel del servidor.

Requiere: cryptography (y supabase + python-dotenv si no se pasa --cifrado).
"""
import argparse
import base64
import itertools
import pathlib
import string
import sys

from cryptography.fernet import Fernet, InvalidToken

ALFABETO = string.ascii_letters + string.digits + "-_"


def cifrado_de_la_base() -> str:
    """Un ciphertext cualquiera de service_credentials, para probar candidatas."""
    raiz = pathlib.Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(raiz / "backend"))
    from dotenv import load_dotenv

    load_dotenv(raiz / "backend" / ".env")
    from database import get_supabase_client

    filas = get_supabase_client().table("service_credentials").select(
        "ciphertext").limit(1).execute().data
    if not filas:
        raise SystemExit("No hay credenciales guardadas contra las cuales probar.")
    return filas[0]["ciphertext"]


def candidatas(rota: str):
    """Variantes de la llave rota, de la más probable a la menos.

    El orden importa solo para terminar antes: todas son baratas."""
    base = rota.strip().strip('"').strip("'").strip().replace("+", "-").replace("/", "_")
    vistas = set()

    def ofrecer(v):
        if v and v not in vistas:
            vistas.add(v)
            return v
        return None

    # 1) Tal cual, y con el relleno repuesto.
    for v in (base, base.rstrip("=") + "=", base.rstrip("=") + "=="):
        r = ofrecer(v)
        if r:
            yield "tal cual / relleno", r

    cuerpo = base.rstrip("=")

    # 2) Le falta UN carácter: se prueba insertando cada uno en cada posición.
    for pos in range(len(cuerpo) + 1):
        for c in ALFABETO:
            r = ofrecer(cuerpo[:pos] + c + cuerpo[pos:] + "=")
            if r:
                yield f"insertar en {pos}", r

    # 3) Le sobra UN carácter.
    for pos in range(len(cuerpo)):
        r = ofrecer(cuerpo[:pos] + cuerpo[pos + 1:] + "=")
        if r:
            yield f"quitar el de {pos}", r

    # 4) UN carácter cambiado (por ejemplo, mayúscula por minúscula al retipear).
    for pos in range(len(cuerpo)):
        for c in ALFABETO:
            if c == cuerpo[pos]:
                continue
            r = ofrecer(cuerpo[:pos] + c + cuerpo[pos + 1:] + "=")
            if r:
                yield f"cambiar el de {pos}", r


def sirve(clave: str, cifrado: bytes) -> bool:
    try:
        crudo = base64.urlsafe_b64decode(clave.encode())
    except Exception:
        return False
    if len(crudo) != 32:
        return False
    try:
        Fernet(clave.encode()).decrypt(cifrado)
        return True
    except (InvalidToken, Exception):
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("archivo", help="archivo de texto con la llave tal cual está en el servidor")
    ap.add_argument("--cifrado", help="un ciphertext de service_credentials (si no, se toma de la base)")
    args = ap.parse_args()

    entrada = pathlib.Path(args.archivo)
    rota = entrada.read_text(encoding="utf-8").strip()
    if not rota:
        raise SystemExit("El archivo está vacío.")
    print(f"Llave leída: {len(rota)} caracteres")

    cifrado = (args.cifrado or cifrado_de_la_base()).encode()
    print("Probando variantes…")

    probadas = 0
    for como, clave in candidatas(rota):
        probadas += 1
        if probadas % 500 == 0:
            print(f"  {probadas} probadas…")
        if sirve(clave, cifrado):
            salida = entrada.with_name("llave_recuperada.txt")
            salida.write_text(clave, encoding="utf-8")
            print(f"\n*** RECUPERADA ({como}) tras {probadas} intentos.")
            print(f"Quedó en: {salida}")
            print("Copiá su contenido a CREDENTIALS_MASTER_KEY en el servidor y borrá el archivo.")
            return 0

    print(f"\nNinguna de las {probadas} variantes descifra. El daño es de más de un carácter: "
          "hay que buscar la llave original en un backup.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
