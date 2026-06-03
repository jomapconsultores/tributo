import requests
import xml.etree.ElementTree as ET
import re
import urllib3
from typing import Optional, List, Set
from concurrent.futures import ThreadPoolExecutor, as_completed

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SRI_URLS = [
    "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl",
    "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"
]

def descargar_xml_sri(clave_acceso: str) -> Optional[str]:
    """Descarga XML del SRI usando SOAP"""
    soap_body = f"""<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
        <soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>{clave_acceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>"""

    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }

    for url in SRI_URLS:
        try:
            response = requests.post(url, data=soap_body, headers=headers, timeout=10, verify=False)
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
                except:
                    pass
        except:
            pass

    return None

def extract_claves_from_txt(txt_content: str) -> Set[str]:
    """Extrae claves de acceso válidas de un archivo TXT"""
    found_keys = re.findall(r'\d{49}', txt_content)
    return set(k for k in found_keys if len(k) == 49)

def descargar_multiples_xmls(claves: List[str], max_workers: int = 10) -> List[Optional[str]]:
    """Descarga múltiples XMLs en paralelo"""
    results = []
    errores = 0

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_clave = {executor.submit(descargar_xml_sri, clave): clave for clave in claves}

        for future in as_completed(future_to_clave):
            try:
                xml_content = future.result()
                if xml_content:
                    results.append(xml_content)
                else:
                    errores += 1
            except Exception:
                errores += 1

    return results, errores
