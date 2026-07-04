import requests
import time
import xml.etree.ElementTree as ET
import re
from typing import Optional, List, Set, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

SRI_URLS = [
    "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl",
    "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"
]

# Tiempo de espera por petición (el WS del SRI suele ser lento/saturado).
SRI_TIMEOUT = 25
# Reintentos dentro de una sola descarga (por cada URL del SRI).
SRI_INTENTOS_POR_LLAMADA = 2


def descargar_xml_sri(clave_acceso: str, intentos: int = SRI_INTENTOS_POR_LLAMADA) -> Optional[str]:
    """Descarga el XML de un comprobante del SRI usando SOAP.

    Reintenta en ambas URLs y varias veces, porque el servicio del SRI
    falla de forma intermitente por saturación; un fallo puntual NO debe
    descartar la factura.
    """
    # Una clave de acceso del SRI es siempre de 49 dígitos. Validamos antes
    # de interpolarla en el SOAP body para no construir un XML inválido (o,
    # si algún día llega de una fuente sin sanear, evitar inyección en el
    # payload enviado al WS del SRI).
    if not clave_acceso or not re.fullmatch(r'\d{49}', clave_acceso):
        return None

    soap_body = f"""<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
        <soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>{clave_acceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>"""

    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }

    for intento in range(max(1, intentos)):
        for url in SRI_URLS:
            try:
                response = requests.post(url, data=soap_body, headers=headers, timeout=SRI_TIMEOUT)
                if response.status_code == 200:
                    try:
                        root = ET.fromstring(response.content)
                        comprobante_str = ""
                        for node in root.iter():
                            if node.tag.endswith('comprobante') and node.text:
                                comprobante_str = node.text
                                comprobante_str = comprobante_str.replace("<![CDATA[", "").replace("]]>", "").strip()
                                break

                        if comprobante_str and "<infoTributaria>" in comprobante_str:
                            return comprobante_str
                    except Exception:
                        pass
            except Exception:
                pass
        # Pequeña pausa antes del siguiente intento para no martillar el WS.
        if intento < intentos - 1:
            time.sleep(1.5)

    return None

def extract_claves_from_txt(txt_content: str) -> Set[str]:
    """Extrae claves de acceso válidas de un archivo TXT"""
    found_keys = re.findall(r'\d{49}', txt_content)
    return set(k for k in found_keys if len(k) == 49)

def descargar_multiples_xmls(
    claves: List[str],
    max_workers: int = 8,
    max_rondas: int = 3,
) -> Tuple[List[str], int]:
    """Descarga múltiples XMLs garantizando bajar TODAS las facturas posibles.

    Estrategia: se descargan en paralelo y, las claves que fallan (el WS del
    SRI falla de forma intermitente), se vuelven a reintentar en rondas
    sucesivas. Así, si hay 30 claves, se insiste hasta bajar las 30 y no solo
    una parte. Devuelve (lista_de_xmls, n_no_descargadas).
    """
    # Quitamos duplicados conservando solo claves válidas de 49 dígitos.
    pendientes = list(dict.fromkeys(c for c in claves if c and len(c) == 49))
    resultados: List[str] = []

    for ronda in range(max(1, max_rondas)):
        if not pendientes:
            break

        fallidas: List[str] = []
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_clave = {executor.submit(descargar_xml_sri, clave): clave for clave in pendientes}
            for future in as_completed(future_to_clave):
                clave = future_to_clave[future]
                try:
                    xml_content = future.result()
                except Exception:
                    xml_content = None
                if xml_content:
                    resultados.append(xml_content)
                else:
                    fallidas.append(clave)

        pendientes = fallidas
        # Si aún quedan, esperamos un poco más en cada ronda y reintentamos.
        if pendientes and ronda < max_rondas - 1:
            time.sleep(3 * (ronda + 1))

    return resultados, len(pendientes)
