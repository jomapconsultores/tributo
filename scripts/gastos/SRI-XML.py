import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import pandas as pd
import xml.etree.ElementTree as ET
import os
import shutil
import json
import re
import requests
import time
import platform
import subprocess
import sys
import urllib3
from datetime import datetime
from collections import Counter
# NUEVO: Importación para procesamiento paralelo (Velocidad)
from concurrent.futures import ThreadPoolExecutor, as_completed

# =============================================================================
# CONFIGURACIÓN Y CONSTANTES
# =============================================================================
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MEMORY_FILE = "invoice_memory.json"
GASTOS_PERSONALES = ["ALIMENTACIÓN", "ALIMENTACION", "EDUCACIÓN", "EDUCACION", 
                     "SALUD", "VESTIMENTA", "VIVIENDA", "VARIOS", "TURISMO", "ARTE Y CULTURA"]

# URLs del SRI (Principal y Respaldo)
SRI_URLS = [
    "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl",
    "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"
]

# =============================================================================
# 1. UTILIDADES Y CONEXIÓN
# =============================================================================
def descargar_xml_sri(clave_acceso, output_folder):
    file_path = os.path.join(output_folder, f"{clave_acceso}.xml")
    
    # Si ya existe y pesa más de 200 bytes, asumimos que es válido para ganar tiempo
    if os.path.exists(file_path): 
        try:
            if os.path.getsize(file_path) > 200:
                return file_path 
            os.remove(file_path) 
        except: pass

    soap_body = f"""<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
        <soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>{clave_acceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>"""
    
    headers = {
        'Content-Type': 'text/xml; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    # Reducción de reintentos excesivos para mejorar velocidad, confiando en el balanceo
    for url in SRI_URLS:
        try:
            # Timeout ajustado para no bloquear hilos demasiado tiempo
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
                        with open(file_path, "w", encoding="utf-8") as f: f.write(comprobante_str)
                        return file_path
                except: pass
        except: pass
            
    return None

def load_memory():
    if os.path.exists(MEMORY_FILE):
        try: 
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f: return json.load(f)
        except: return {}
    return {}

def save_memory(memory_data):
    try: 
        with open(MEMORY_FILE, 'w', encoding='utf-8') as f: json.dump(memory_data, f, ensure_ascii=False, indent=4)
    except: pass

def find_text_ignore_ns(parent, tag_name):
    if parent is None: return ""
    node = parent.find(tag_name)
    if node is not None and node.text: return node.text.strip()
    for element in parent.iter():
        if element.tag.endswith(f"}}{tag_name}") or element.tag == tag_name:
            if element.text: return element.text.strip()
    return ""

def find_node_ignore_ns(parent, tag_name):
    if parent is None: return None
    for element in parent.iter():
        if element.tag.endswith(f"}}{tag_name}") or element.tag == tag_name: return element
    return None

def get_month_name(date_str):
    try:
        m = int(date_str.split('/')[1])
        meses = ["", "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"]
        return meses[m]
    except: return "VARIOS"

def open_file_os(filepath):
    try:
        if platform.system() == 'Darwin': subprocess.call(('open', filepath))
        elif platform.system() == 'Windows': os.startfile(filepath)
        else: subprocess.call(('xdg-open', filepath))
    except Exception as e: print(f"No se pudo abrir el archivo: {e}")

# =============================================================================
# 2. PARSEO XML
# =============================================================================
def parse_xml_invoice(filepath, memory, classification_map):
    try:
        try: tree = ET.parse(filepath); root = tree.getroot()
        except: return None

        comprobante_node = find_node_ignore_ns(root, 'comprobante')
        if comprobante_node is not None and comprobante_node.text:
            inner_xml = comprobante_node.text.strip()
            inner_xml = inner_xml.replace("<![CDATA[", "").replace("]]>", "").strip()
            try: root = ET.fromstring(inner_xml)
            except: pass

        info_tributaria = find_node_ignore_ns(root, 'infoTributaria')
        info_factura = find_node_ignore_ns(root, 'infoFactura')
        if info_tributaria is None and info_factura is None: return None

        clave_acceso = find_text_ignore_ns(info_tributaria, 'claveAcceso')
        ruc = find_text_ignore_ns(info_tributaria, 'ruc')
        ruc_comprador = find_text_ignore_ns(info_factura, 'identificacionComprador')
        
        estab = find_text_ignore_ns(info_tributaria, 'estab')
        pto_emi = find_text_ignore_ns(info_tributaria, 'ptoEmi')
        secuencial = find_text_ignore_ns(info_tributaria, 'secuencial')
        factura_numero = f"{estab}-{pto_emi}-{secuencial}"
        unique_id = clave_acceso if clave_acceso else f"{ruc}-{factura_numero}"

        fecha = find_text_ignore_ns(info_factura, 'fechaEmision')
        nombre = find_text_ignore_ns(info_tributaria, 'razonSocial')
        destinatario = find_text_ignore_ns(info_factura, 'razonSocialComprador')

        clasificacion = classification_map.get(ruc, "SIN CLASIFICAR")
        
        pagos = find_node_ignore_ns(info_factura, 'pagos')
        forma_pago = "Otros"
        if pagos is not None:
            pago = find_node_ignore_ns(pagos, 'pago')
            if pago is not None:
                cod_pago = find_text_ignore_ns(pago, 'formaPago')
                if cod_pago == '01': forma_pago = "Sin Utilización del Sistema Financiero"
                elif cod_pago == '19': forma_pago = "Tarjeta de Crédito"
                elif cod_pago == '20': forma_pago = "Otros con Utilización del Sistema Financiero"
                else: forma_pago = f"Código {cod_pago}"

        detalles = find_node_ignore_ns(root, 'detalles')
        concepto_str = "VARIOS"
        if detalles is not None:
            lista_detalles = list(detalles)
            for child in lista_detalles:
                if child.tag.endswith('detalle'):
                    desc = find_text_ignore_ns(child, 'descripcion')
                    if desc:
                        concepto_str = desc
                        if len(lista_detalles) > 1: concepto_str += "..."
                        break
        
        try: total_descuento_xml = float(find_text_ignore_ns(info_factura, 'totalDescuento') or 0)
        except: total_descuento_xml = 0.0

        base_0, base_15, iva_15, base_5, iva_5, base_exento, base_no_objeto = 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0
        total_con_impuestos = find_node_ignore_ns(info_factura, 'totalConImpuestos')
        
        if total_con_impuestos is not None:
            for impuesto in total_con_impuestos:
                codigo = find_text_ignore_ns(impuesto, 'codigo')
                if codigo == '2': # IVA
                    cod_porc = find_text_ignore_ns(impuesto, 'codigoPorcentaje')
                    try: base_imponible = float(find_text_ignore_ns(impuesto, 'baseImponible') or 0)
                    except: base_imponible = 0.0
                    try: valor_impuesto = float(find_text_ignore_ns(impuesto, 'valor') or 0)
                    except: valor_impuesto = 0.0

                    if cod_porc == '0': base_0 += base_imponible
                    elif cod_porc in ['2', '3', '4', '10']: 
                        base_15 += base_imponible
                        iva_15 += valor_impuesto
                    elif cod_porc == '5':
                        base_5 += base_imponible
                        iva_5 += valor_impuesto
                    elif cod_porc == '6': base_no_objeto += base_imponible
                    elif cod_porc == '7': base_exento += base_imponible
        
        try: total = float(find_text_ignore_ns(info_factura, 'importeTotal') or 0)
        except: total = 0.0

        mem_key = f"{nombre}|{total:.2f}"
        tarjeta_credito = memory.get(mem_key, "")

        return {
            "ID": unique_id, "Estado": "OK", "Fecha": fecha, "RUC": ruc, "Factura": factura_numero,
            "Nombre": nombre, "Clasificación": clasificacion, "Concepto": concepto_str,
            "Forma Pago": forma_pago, "Tarjeta de Crédito": tarjeta_credito,
            "No Objeto IVA": round(base_no_objeto, 2), 
            "Exento IVA": round(base_exento, 2), 
            "Base 0%": round(base_0, 2), 
            "Base 15%": round(base_15, 2), 
            "IVA 15%": round(iva_15, 2),
            "Base 5%": round(base_5, 2), 
            "IVA 5%": round(iva_5, 2), 
            "Desc. Info": round(total_descuento_xml, 2), 
            "Desc. Manual": 0.00, 
            "Total": total,
            "Destinatario": destinatario, "RutaOriginal": filepath,
            "RUC_Comprador": ruc_comprador,
            "Base_15_Original": base_15, 
            "Total_Original": total        
        }
    except Exception as e:
        print(f"Error parseando {filepath}: {e}")
        return None

# =============================================================================
# INTERFAZ GRÁFICA
# =============================================================================
class InvoiceApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Gestor Tributario Pro 3.8 - Turbo Speed & Fix")
        self.root.geometry("1550x750")

        self.memory = load_memory()
        self.classification_map = {}
        self.map_file_path = None 
        self.data_rows = []     
        self.loaded_ids = set() 
        self.download_folder = "XML_Descargados"
        if not os.path.exists(self.download_folder): os.makedirs(self.download_folder)

        # Panel Superior
        frame_top = tk.Frame(root, bg="#f8f9fa", pady=10, padx=10)
        frame_top.pack(fill="x")
        btn_style = {"font": ("Segoe UI", 9, "bold"), "bd": 0, "padx": 15, "pady": 5, "cursor": "hand2"}

        tk.Button(frame_top, text="📂 1. Cargar Mapa Base", command=self.load_classification_map, bg="#6c757d", fg="white", **btn_style).pack(side="left", padx=5)
        self.lbl_map = tk.Label(frame_top, text="No cargado", bg="#f8f9fa", fg="gray")
        self.lbl_map.pack(side="left")

        tk.Frame(frame_top, width=20, bg="#f8f9fa").pack(side="left")
        
        tk.Button(frame_top, text="📥 2. Procesar TXT", command=self.process_txt_files, bg="#007bff", fg="white", **btn_style).pack(side="left", padx=5)
        tk.Button(frame_top, text="📂 3. Importar XMLs PC", command=self.process_local_xmls, bg="#ffc107", fg="black", **btn_style).pack(side="left", padx=5)
        
        tk.Frame(frame_top, width=20, bg="#f8f9fa").pack(side="left")

        tk.Button(frame_top, text="🗑 Eliminar", command=self.delete_selected_rows, bg="#8B0000", fg="white", **btn_style).pack(side="left", padx=5)
        tk.Button(frame_top, text="🧹 Limpiar Todo", command=self.clear_table, bg="#dc3545", fg="white", **btn_style).pack(side="left", padx=5)
        
        self.btn_export = tk.Button(frame_top, text="💾 Exportar", command=self.export_data, state="disabled", bg="#28a745", fg="white", **btn_style)
        self.btn_export.pack(side="left", padx=5)
        
        tk.Frame(frame_top, width=30, bg="#f8f9fa").pack(side="left") 
        tk.Button(frame_top, text="🔄 Reiniciar", command=self.restart_program, bg="#17a2b8", fg="white", **btn_style).pack(side="left", padx=5)
        tk.Button(frame_top, text="❌ Cerrar", command=self.close_program, bg="#343a40", fg="white", **btn_style).pack(side="left", padx=5)

        tk.Label(frame_top, text="🔍 Buscar:", bg="#f8f9fa", font=("Segoe UI", 10)).pack(side="left", padx=(30, 5))
        self.search_var = tk.StringVar()
        self.search_var.trace("w", self.filter_by_search)
        tk.Entry(frame_top, textvariable=self.search_var, font=("Segoe UI", 10), width=20).pack(side="left")

        self.columns = ("Estado", "Fecha", "RUC", "Factura", "Nombre", "Clasificación", "Concepto", 
                        "Forma Pago", "Tarjeta de Crédito", 
                        "No Objeto IVA", "Exento IVA", "Base 0%", "Base 15%", "IVA 15%", 
                        "Base 5%", "IVA 5%", "Desc. Info", "Desc. Manual", "Total")
        
        frame_tree = tk.Frame(root)
        frame_tree.pack(fill="both", expand=True, padx=10, pady=5)
        self.tree = ttk.Treeview(frame_tree, columns=self.columns, show="headings", selectmode="extended")
        
        sb_y = ttk.Scrollbar(frame_tree, orient="vertical", command=self.tree.yview)
        sb_x = ttk.Scrollbar(frame_tree, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscroll=sb_y.set, xscroll=sb_x.set)
        sb_y.pack(side="right", fill="y"); sb_x.pack(side="bottom", fill="x")
        self.tree.pack(fill="both", expand=True)

        col_widths = [70, 80, 100, 110, 140, 110, 140, 
                      100, 100, 
                      80, 70, 70, 70, 60, 
                      70, 60, 70, 80, 70]

        for col, w in zip(self.columns, col_widths):
            self.tree.heading(col, text=col, command=lambda c=col: self.open_filter_menu(c))
            self.tree.column(col, width=w, minwidth=50, anchor="center" if "Base" in col or "IVA" in col or "Total" in col or "Desc" in col or "Objeto" in col else "w")

        self.tree.tag_configure('duplicado', background='#ffd6d6', foreground='#b30000') 
        self.tree.tag_configure('ok', background='white')
        self.tree.tag_configure('modificado', background='#e3f2fd', foreground='#0d47a1') 
        self.tree.tag_configure('descuento_xml', background='#fff3cd', foreground='#856404') 
        
        self.tree.bind("<Double-1>", self.on_double_click)
        self.tree.bind("<Button-3>", self.show_context_menu) 
        self.tree.bind("<<TreeviewSelect>>", self.on_selection_change) 
        self.tree.bind("<Delete>", lambda e: self.delete_selected_rows())
        
        self.active_filters = {}

        self.context_menu = tk.Menu(root, tearoff=0)
        self.context_menu.add_command(label="Copiar RUC", command=lambda: self.copy_to_clipboard("RUC"))
        self.context_menu.add_command(label="Copiar Factura", command=lambda: self.copy_to_clipboard("Factura"))
        self.context_menu.add_command(label="Copiar Nombre", command=lambda: self.copy_to_clipboard("Nombre"))
        self.context_menu.add_separator()
        self.context_menu.add_command(label="🗑 Eliminar Fila(s)", command=self.delete_selected_rows)
        
        frame_bot = tk.Frame(root, bg="#e9ecef", pady=5)
        frame_bot.pack(fill="x")
        self.lbl_stats = tk.Label(frame_bot, text="Listo.", bg="#e9ecef", font=("Segoe UI", 10, "bold"))
        self.lbl_stats.pack(side="left", padx=10)
        
        self.lbl_client_info = tk.Label(frame_bot, text="", bg="#e9ecef", font=("Segoe UI", 10, "bold"), fg="#495057")
        self.lbl_client_info.pack(side="right", padx=20)

    # =============================================================================
    # LÓGICA GENERAL
    # =============================================================================
    def restart_program(self):
        if messagebox.askyesno("Reiniciar", "¿Desea cerrar y abrir nuevamente la aplicación?"):
            self.root.destroy()
            try:
                python = sys.executable
                os.execl(python, python, *sys.argv)
            except: sys.exit()

    def close_program(self):
        if messagebox.askyesno("Cerrar", "¿Desea salir de la aplicación?"):
            self.root.destroy(); sys.exit()

    def load_classification_map(self):
        f = filedialog.askopenfilename(filetypes=[("Excel", "*.xlsx *.xls")])
        if not f: return
        self.map_file_path = f 
        try:
            df = pd.read_excel(f, header=None)
            count = 0
            for _, row in df.iterrows():
                try:
                    ruc = str(row[0]).strip().replace("'", "").zfill(13)
                    cat = str(row[2]).strip().upper()
                    if ruc and cat: 
                        self.classification_map[ruc] = cat
                        count += 1
                except: continue
            self.lbl_map.config(text=f"Mapa: {os.path.basename(f)} ({count} RUCs)", fg="green")
            if self.data_rows: self.reapply_classification()
        except Exception as e: messagebox.showerror("Error", f"Error leyendo mapa: {e}")

    def reapply_classification(self):
        for row in self.data_rows:
            cat = self.classification_map.get(row['RUC'], "SIN CLASIFICAR")
            row['Clasificación'] = cat
        self.refresh_tree()

    def update_excel_map(self, ruc_target, nombre_prov, new_category):
        if not self.map_file_path: return
        try:
            df = pd.read_excel(self.map_file_path, header=None)
            df[0] = df[0].astype(str).str.strip().str.replace("'", "").str.zfill(13)
            mask = df[0] == ruc_target
            if mask.any():
                df.loc[mask, 1] = nombre_prov.upper()
                df.loc[mask, 2] = new_category.upper()
            else:
                new_row = pd.DataFrame([[ruc_target, nombre_prov.upper(), new_category.upper()]], columns=[0, 1, 2])
                df = pd.concat([df, new_row], ignore_index=True)
            df.to_excel(self.map_file_path, index=False, header=False)
        except Exception as e: messagebox.showerror("Error Guardando Mapa", f"{e}")

    def process_local_xmls(self):
        files = filedialog.askopenfilenames(title="Seleccionar archivos XML", filetypes=[("Archivos XML", "*.xml")])
        if not files: return
        self.lbl_stats.config(text=f"Analizando {len(files)} archivos locales...")
        self.root.update()
        new_c, dup_c = 0, 0
        for xml_path in files:
            row = parse_xml_invoice(xml_path, self.memory, self.classification_map)
            if row:
                uid = row.pop("ID"); orig = row.pop("RutaOriginal"); dest = row.pop("Destinatario")
                rucc = row.pop("RUC_Comprador"); base_orig = row.pop("Base_15_Original"); total_orig = row.pop("Total_Original")
                if uid in self.loaded_ids: 
                    row['Estado'] = "DUPLICADO"; dup_c += 1
                else: 
                    self.loaded_ids.add(uid); new_c += 1
                row_int = row.copy()
                row_int['ID'] = uid; row_int['RutaOriginal'] = orig; row_int['Destinatario'] = dest
                row_int['RUC_Comprador'] = rucc; row_int['Base_15_Original'] = base_orig; row_int['Total_Original'] = total_orig
                self.data_rows.append(row_int)
        self.refresh_tree(); self.update_client_stats()
        self.lbl_stats.config(text=f"Total: {len(self.data_rows)} | Nuevos: {new_c} | Duplicados: {dup_c}")
        self.btn_export.config(state="normal")
        messagebox.showinfo("Carga Local Completa", f"Se cargaron {len(files)} archivos.\nNuevos: {new_c}\nDuplicados: {dup_c}")

    def update_client_stats(self):
        nombres = [r['Destinatario'] for r in self.data_rows if r.get('Destinatario')]
        fechas = [r['Fecha'] for r in self.data_rows if r.get('Fecha')]
        txt_cliente = "Desconocido"; txt_periodo = "Varios"
        if nombres:
            try: txt_cliente = Counter(nombres).most_common(1)[0][0]
            except: pass
        if fechas:
            try:
                meses_anios = [f"{d.split('/')[1]}/{d.split('/')[2]}" for d in fechas if len(d.split('/')) == 3]
                if meses_anios:
                    comun = Counter(meses_anios).most_common(1)[0][0]
                    m, y = comun.split('/')
                    mes_nombre = ["", "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"][int(m)]
                    txt_periodo = f"{mes_nombre} {y}"
            except: pass
        self.lbl_client_info.config(text=f"CLIENTE: {txt_cliente}  |  PERÍODO: {txt_periodo}")

    # =============================================================================
    # LÓGICA DE DESCARGA MULTIHILO (OPTIMIZADA)
    # =============================================================================
    def process_txt_files(self):
        files = filedialog.askopenfilenames(filetypes=[("Archivos TXT/CSV/TSV", "*.txt *.csv *.tsv")])
        if not files: return
        claves = set()
        for f in files:
            content = ""
            read_success = False
            for encoding in ['utf-8', 'latin-1', 'cp1252']:
                try:
                    with open(f, 'r', encoding=encoding) as tf: content = tf.read(); read_success = True; break
                except UnicodeDecodeError: continue
            if not read_success: continue
            found_keys = re.findall(r'\d{49}', content)
            valid_keys = [k for k in found_keys if len(k) == 49]
            claves.update(valid_keys)
        if not claves: return messagebox.showwarning("Aviso", "No se hallaron claves válidas.")
        
        self.lbl_stats.config(text=f"Iniciando descarga masiva de {len(claves)} claves...")
        self.root.update()
        
        paths = []
        lista_claves = sorted(list(claves))
        errores_descarga = 0
        total_k = len(lista_claves)
        processed_k = 0

        # USO DE THREADS PARA DESCARGA PARALELA (10 hilos simultáneos)
        with ThreadPoolExecutor(max_workers=10) as executor:
            future_to_key = {executor.submit(descargar_xml_sri, c, self.download_folder): c for c in lista_claves}
            
            for future in as_completed(future_to_key):
                processed_k += 1
                # Actualización visual sin bloquear
                if processed_k % 5 == 0 or processed_k == total_k:
                    self.lbl_stats.config(text=f"Descargando: {processed_k} / {total_k} completados...")
                    self.root.update()
                
                try:
                    p = future.result()
                    if p: paths.append(p)
                    else: errores_descarga += 1
                except: errores_descarga += 1

        new_c, dup_c = 0, 0
        self.lbl_stats.config(text="Analizando XMLs descargados...")
        self.root.update()
        
        for xml in paths:
            row = parse_xml_invoice(xml, self.memory, self.classification_map)
            if row:
                uid = row.pop("ID"); orig = row.pop("RutaOriginal"); dest = row.pop("Destinatario")
                rucc = row.pop("RUC_Comprador"); base_orig = row.pop("Base_15_Original"); total_orig = row.pop("Total_Original")
                if uid in self.loaded_ids: 
                    row['Estado'] = "DUPLICADO"; dup_c += 1
                else: 
                    self.loaded_ids.add(uid); new_c += 1
                row_int = row.copy()
                row_int['ID'] = uid; row_int['RutaOriginal'] = orig; row_int['Destinatario'] = dest
                row_int['RUC_Comprador'] = rucc; row_int['Base_15_Original'] = base_orig; row_int['Total_Original'] = total_orig
                self.data_rows.append(row_int)
        
        self.refresh_tree(); self.update_client_stats()
        msg = f"Se encontraron {len(claves)} claves.\nSe procesaron {len(paths)} XMLs.\nNuevos: {new_c}\nDuplicados: {dup_c}"
        if errores_descarga > 0: msg += f"\n\nATENCIÓN: {errores_descarga} facturas no se pudieron descargar (SRI saturado o claves inválidas)."
        self.lbl_stats.config(text=f"Total: {len(self.data_rows)} | Nuevos: {new_c} | Duplicados: {dup_c}")
        self.btn_export.config(state="normal")
        messagebox.showinfo("Carga Rápida Completa", msg)

    def on_double_click(self, event):
        region = self.tree.identify("region", event.x, event.y)
        if region != "cell": return
        col_id = self.tree.identify_column(event.x)
        col_name = self.tree.column(col_id, "id")
        item_id = self.tree.identify_row(event.y)
        if not item_id: return
        x, y, w, h = self.tree.bbox(item_id, col_id)
        curr_vals = self.tree.item(item_id, 'values')
        curr_val = curr_vals[self.columns.index(col_name)]
        
        if col_name == "Tarjeta de Crédito":
            entry = tk.Entry(self.tree, width=20)
            entry.place(x=x, y=y, width=w, height=h)
            entry.insert(0, curr_val)
            entry.focus()
            def save_card(ev):
                new_val = entry.get().upper(); entry.destroy()
                nombre_row = curr_vals[self.columns.index("Nombre")]; total_row = float(curr_vals[self.columns.index("Total")])
                for r in self.data_rows:
                    if r['Nombre'] == nombre_row and abs(r['Total'] - total_row) < 0.01: r['Tarjeta de Crédito'] = new_val
                mem_key = f"{nombre_row}|{total_row:.2f}"; self.memory[mem_key] = new_val
                save_memory(self.memory); self.refresh_tree()
            entry.bind("<Return>", save_card); entry.bind("<FocusOut>", lambda e: entry.destroy())

        elif col_name == "Clasificación": self.show_autocomplete_popup(x, y, w, h, curr_val, item_id, curr_vals)

        elif col_name == "Desc. Manual":
            entry = tk.Entry(self.tree, width=20)
            entry.place(x=x, y=y, width=w, height=h)
            entry.insert(0, curr_val)
            entry.focus()
            entry.select_range(0, tk.END)
            def save_discount(ev):
                try: new_desc = float(entry.get())
                except: new_desc = 0.0
                entry.destroy()
                ruc_v = curr_vals[self.columns.index("RUC")]; fact_v = curr_vals[self.columns.index("Factura")]
                for r in self.data_rows:
                    if r['RUC'] == ruc_v and r['Factura'] == fact_v:
                        base_15_orig = r.get('Base_15_Original', r['Base 15%'])
                        new_base_15 = max(0, base_15_orig - new_desc); new_iva_15 = new_base_15 * 0.15
                        total_calculado = (r['Base 0%'] + r['Base 5%'] + r['IVA 5%'] + r['Exento IVA'] + r.get('No Objeto IVA',0) + new_base_15 + new_iva_15)
                        r['Desc. Manual'] = round(new_desc, 2); r['Base 15%'] = round(new_base_15, 2)
                        r['IVA 15%'] = round(new_iva_15, 2); r['Total'] = round(total_calculado, 2)
                        break
                self.refresh_tree()
            entry.bind("<Return>", save_discount); entry.bind("<FocusOut>", lambda e: entry.destroy())

    def show_autocomplete_popup(self, x, y, w, h, curr_val, item_id, curr_vals):
        options = set(GASTOS_PERSONALES); options.update(self.classification_map.values())
        current_table_opts = {r['Clasificación'] for r in self.data_rows if r['Clasificación']}
        options.update(current_table_opts); sorted_options = sorted(list(options))
        pop = tk.Toplevel(self.root); pop.wm_overrideredirect(True) 
        abs_x = self.tree.winfo_rootx() + x; abs_y = self.tree.winfo_rooty() + y
        pop.geometry(f"{250}x{200}+{abs_x}+{abs_y}") 
        entry_var = tk.StringVar(value=curr_val)
        entry = tk.Entry(pop, textvariable=entry_var, bg="#fffde7")
        entry.pack(fill="x", padx=1, pady=1)
        entry.focus_set(); entry.select_range(0, tk.END)
        listbox = tk.Listbox(pop, height=8); listbox.pack(fill="both", expand=True)
        def update_list(*args):
            search_term = entry_var.get().upper(); listbox.delete(0, tk.END)
            for item in sorted_options:
                if item.startswith(search_term): listbox.insert(tk.END, item)
        update_list(); entry_var.trace("w", update_list)
        def apply_selection(final_val):
            pop.destroy()
            if not final_val: return
            final_val = final_val.upper()
            ruc_row = curr_vals[self.columns.index("RUC")]; nombre_row = curr_vals[self.columns.index("Nombre")]
            self.classification_map[ruc_row] = final_val; self.update_excel_map(ruc_row, nombre_row, final_val)
            for r in self.data_rows:
                if r['RUC'] == ruc_row: r['Clasificación'] = final_val
            self.refresh_tree()
        def on_list_select(ev):
            if listbox.curselection(): apply_selection(listbox.get(listbox.curselection()[0]))
        def on_enter(ev):
            if listbox.curselection(): apply_selection(listbox.get(listbox.curselection()[0]))
            else: apply_selection(entry.get())
        listbox.bind("<<ListboxSelect>>", on_list_select); entry.bind("<Return>", on_enter)
        pop.bind("<Escape>", lambda e: pop.destroy()); pop.bind("<FocusOut>", lambda e: pop.destroy() if pop.focus_get() is None else None)

    def show_context_menu(self, event):
        item = self.tree.identify_row(event.y)
        if item:
            if item not in self.tree.selection(): self.tree.selection_set(item)
            self.context_menu.post(event.x_root, event.y_root)

    def copy_to_clipboard(self, field):
        selection = self.tree.selection()
        if not selection: return
        item = selection[0]; vals = self.tree.item(item, 'values')
        text_to_copy = vals[self.columns.index(field)]
        self.root.clipboard_clear(); self.root.clipboard_append(text_to_copy); self.root.update()

    def delete_selected_rows(self):
        selected_items = self.tree.selection()
        if not selected_items:
            messagebox.showwarning("Aviso", "Seleccione al menos un registro para eliminar.")
            return
        if not messagebox.askyesno("Confirmar Eliminación", f"¿Está seguro de eliminar {len(selected_items)} registros seleccionados?"):
            return
        items_to_remove = []
        for item in selected_items:
            vals = self.tree.item(item, 'values')
            ruc = vals[self.columns.index("RUC")]; factura = vals[self.columns.index("Factura")]
            items_to_remove.append((ruc, factura))
            self.tree.delete(item)
        new_rows = []
        for row in self.data_rows:
            is_deleted = False
            for r_del, f_del in items_to_remove:
                if row['RUC'] == r_del and row['Factura'] == f_del:
                    is_deleted = True
                    if row['ID'] in self.loaded_ids: self.loaded_ids.remove(row['ID'])
                    break
            if not is_deleted: new_rows.append(row)
        self.data_rows = new_rows
        self.on_selection_change(None); self.update_client_stats()
        self.lbl_stats.config(text=f"Total: {len(self.data_rows)}")

    def on_selection_change(self, event):
        selected_items = self.tree.selection()
        if not selected_items:
            self.lbl_stats.config(text=f"Total Registros: {len(self.data_rows)}")
            return
        sum_total = 0.0; count = 0; idx_total = self.columns.index("Total")
        for item in selected_items:
            try: sum_total += float(self.tree.item(item, 'values')[idx_total]); count += 1
            except: pass
        self.lbl_stats.config(text=f"SELECCIÓN: {count} facturas | SUMA TOTAL: $ {sum_total:,.2f}")

    def filter_by_search(self, *args): self.refresh_tree(self.search_var.get().lower())
    
    def open_filter_menu(self, col_name):
        values = sorted(list({str(r.get(col_name, "")) for r in self.data_rows}))
        top = tk.Toplevel(self.root); top.geometry("250x400"); top.title(f"Filtrar: {col_name}")
        btn_frame = tk.Frame(top, pady=5); btn_frame.pack(side="bottom", fill="x") 
        canvas = tk.Canvas(top); sb = ttk.Scrollbar(top, command=canvas.yview)
        frame = tk.Frame(canvas); canvas.create_window((0,0), window=frame, anchor="nw")
        canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y"); canvas.pack(side="left", fill="both", expand=True)
        frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        vars_ = {}
        def toggle(s): 
            for v in vars_.values(): v.set(s)
        tk.Button(frame, text="Seleccionar Todo", command=lambda: toggle(True), font=("Segoe UI", 8)).pack(fill='x')
        tk.Button(frame, text="Deseleccionar Todo", command=lambda: toggle(False), font=("Segoe UI", 8)).pack(fill='x')
        for v in values:
            var = tk.BooleanVar(value=True)
            if col_name in self.active_filters: var.set(v in self.active_filters[col_name])
            vars_[v] = var
            tk.Checkbutton(frame, text=v, variable=var, anchor='w').pack(fill='x')
        def apply():
            sel = {v for v, vr in vars_.items() if vr.get()}
            if len(sel) == len(values) and col_name in self.active_filters: del self.active_filters[col_name]
            elif len(sel) != len(values): self.active_filters[col_name] = sel
            self.refresh_tree(); top.destroy()
        tk.Button(btn_frame, text="APLICAR FILTRO", command=apply, bg="#28a745", fg="white", font=("Segoe UI", 10, "bold")).pack(fill='x', padx=10)

    def refresh_tree(self, query=""):
        self.tree.delete(*self.tree.get_children())
        for row in self.data_rows:
            if query and query not in " ".join([str(v) for v in row.values()]).lower(): continue
            skip = False
            for col, allowed in self.active_filters.items():
                if str(row.get(col, "")) not in allowed: skip = True; break
            if skip: continue
            tag = 'ok'
            desc_info = float(row.get('Desc. Info', 0) or 0); desc_man = float(row.get('Desc. Manual', 0) or 0)
            if row['Estado'] == 'DUPLICADO': tag = 'duplicado'
            elif desc_man > 0: tag = 'modificado'
            elif desc_info > 0: tag = 'descuento_xml'
            self.tree.insert("", "end", values=[row.get(c, "") for c in self.columns], tags=(tag,))

    def clear_table(self):
        self.tree.delete(*self.tree.get_children()); self.data_rows = []; self.loaded_ids = set()
        self.lbl_stats.config(text="Limpio"); self.btn_export.config(state="disabled")

    def export_data(self):
        save_path = filedialog.asksaveasfilename(defaultextension=".xlsx", filetypes=[("Excel", "*.xlsx")])
        if not save_path: return
        rucs_comprador = [r['RUC_Comprador'] for r in self.data_rows if r.get('RUC_Comprador')]
        fechas = [r['Fecha'] for r in self.data_rows if r['Fecha']]
        ruc_final = "DESCONOCIDO"
        if rucs_comprador: ruc_final = Counter(rucs_comprador).most_common(1)[0][0]
        mes_final = "VARIOS"
        if fechas: mes_final = get_month_name(fechas[0]) 
        folder_name = f"{ruc_final}_{mes_final}_xml"
        xml_folder = os.path.join(os.path.dirname(save_path), folder_name)
        os.makedirs(xml_folder, exist_ok=True)
        rows_exp = []; sin_clasif = set(); file_name_counter = {}

        for row in self.data_rows:
            if row['Estado'] != 'OK': continue
            if not row['Clasificación'] or row['Clasificación'] == "SIN CLASIFICAR":
                sin_clasif.add((row['RUC'], row['Nombre']))
            try:
                safe_name = re.sub(r'[\\/*?:"<>|]', "", row['Nombre']).strip()
                d, m, y = row['Fecha'].split('/'); iso_date = f"{y}-{m}-{d}"
                base_filename = f"{safe_name}_{iso_date}"
                if base_filename in file_name_counter:
                    file_name_counter[base_filename] += 1
                    final_filename = f"{base_filename}({file_name_counter[base_filename]}).xml"
                else:
                    file_name_counter[base_filename] = 0; final_filename = f"{base_filename}.xml"
                dest = os.path.join(xml_folder, final_filename)
                shutil.copy2(row['RutaOriginal'], dest); link = dest
            except Exception as e: print(e); link = ""
            # --- Corrección: Convertir explícitamente a float para evitar texto en Excel ---
            r = {}
            for k in self.columns:
                val = row.get(k, "")
                if k in ["No Objeto IVA", "Exento IVA", "Base 0%", "Base 15%", "IVA 15%", "Base 5%", "IVA 5%", "Total"]:
                    try: r[k] = float(val)
                    except: r[k] = 0.0
                else:
                    r[k] = val
            r['Ruta_XML'] = link; r['Destinatario'] = row.get('Destinatario', '')
            rows_exp.append(r)

        if not rows_exp: return

        try:
            df = pd.DataFrame(rows_exp)
            with pd.ExcelWriter(save_path, engine='xlsxwriter') as writer:
                wb = writer.book
                cols = list(self.columns) + ['Destinatario', 'Ruta_XML']
                df[cols].to_excel(writer, index=False, sheet_name='DATOS')
                ws = writer.sheets['DATOS']
                fmt_link = wb.add_format({'font_color': 'blue', 'underline': 1}); fmt_curr = wb.add_format({'num_format': '$#,##0.00'})
                link_col = len(cols)-1
                for i, u in enumerate(df['Ruta_XML']):
                    if u: ws.write_url(i+1, link_col, f"external:{u}", string="ABRIR XML", cell_format=fmt_link)
                for i, c in enumerate(cols):
                    if any(x in c for x in ["Base", "IVA", "Total", "Exento", "Desc", "Objeto"]): ws.set_column(i, i, 12, fmt_curr)

                ws_res = wb.add_worksheet('RESUMEN')
                cats = sorted(list(set(df['Clasificación'].dropna())))
                l_pers = [c for c in cats if c in GASTOS_PERSONALES]
                l_ejer = [c for c in cats if c not in GASTOS_PERSONALES and c != "SIN CLASIFICAR"]

                def write_summary_table(start_row, title, cat_list, color_hex):
                    fmt_head = wb.add_format({'bold':True, 'bg_color':color_hex, 'font_color':'white', 'border':1, 'align':'center'})
                    fmt_cell = wb.add_format({'border':1}); fmt_num = wb.add_format({'num_format': '$#,##0.00', 'border':1})
                    fmt_total_lbl = wb.add_format({'bold':True, 'bg_color':color_hex, 'font_color':'white', 'border':1, 'align':'center'})
                    fmt_total_int = wb.add_format({'num_format': '0', 'border':1, 'bold': True})
                    fmt_total_num = wb.add_format({'num_format': '$#,##0.00', 'border':1, 'bold': True})
                    
                    headers = ["Concepto", "# Facturas", "No Objeto IVA", "Exento IVA", "Base 0%", "Base 5%", "IVA 5%", "Base 15%", "IVA 15%", "Total"]
                    ws_res.merge_range(start_row, 0, start_row, 9, title, wb.add_format({'bold':True, 'font_size':12}))
                    for i, h in enumerate(headers): ws_res.write(start_row+1, i, h, fmt_head)

                    curr = start_row + 2
                    for c in cat_list:
                        crit = f'"{c}"'
                        ws_res.write(curr, 0, c, fmt_cell)
                        ws_res.write_formula(curr, 1, f'=COUNTIF(DATOS!F:F, {crit})', fmt_cell) 
                        ws_res.write_formula(curr, 2, f'=SUMIF(DATOS!F:F, {crit}, DATOS!J:J)', fmt_num) 
                        ws_res.write_formula(curr, 3, f'=SUMIF(DATOS!F:F, {crit}, DATOS!K:K)', fmt_num) 
                        ws_res.write_formula(curr, 4, f'=SUMIF(DATOS!F:F, {crit}, DATOS!L:L)', fmt_num) 
                        ws_res.write_formula(curr, 5, f'=SUMIF(DATOS!F:F, {crit}, DATOS!O:O)', fmt_num) 
                        ws_res.write_formula(curr, 6, f'=SUMIF(DATOS!F:F, {crit}, DATOS!P:P)', fmt_num) 
                        ws_res.write_formula(curr, 7, f'=SUMIF(DATOS!F:F, {crit}, DATOS!M:M)', fmt_num) 
                        ws_res.write_formula(curr, 8, f'=SUMIF(DATOS!F:F, {crit}, DATOS!N:N)', fmt_num) 
                        ws_res.write_formula(curr, 9, f'=SUMIF(DATOS!F:F, {crit}, DATOS!S:S)', fmt_num) 
                        curr += 1
                    
                    ws_res.write(curr, 0, "TOTAL GENERAL", fmt_total_lbl)
                    col_char_fact = "B"
                    # Corrección Fórmula: Si curr está en fila 5, la data termina en 4. Start_row+3 es la primera fila de datos.
                    ws_res.write_formula(curr, 1, f'=SUM({col_char_fact}{start_row+3}:{col_char_fact}{curr})', fmt_total_int)
                    for col_idx in range(2, 10):
                        col_char = chr(65 + col_idx) 
                        ws_res.write_formula(curr, col_idx, f'=SUM({col_char}{start_row+3}:{col_char}{curr})', fmt_total_num)
                    return curr + 3

                row_cursor = 0
                row_cursor = write_summary_table(row_cursor, "GASTOS PERSONALES", l_pers, "#28a745")
                row_cursor = write_summary_table(row_cursor, "GASTOS DEL EJERCICIO", l_ejer, "#007bff")
                ws_res.set_column(0, 0, 30); ws_res.set_column(1, 9, 15)
                if sin_clasif: pd.DataFrame(list(sin_clasif), columns=["RUC","Nombre"]).to_excel(writer, sheet_name='PENDIENTES', index=False)
            messagebox.showinfo("Reporte Generado", f"Archivo creado exitosamente.")
            open_file_os(save_path)
        except Exception as e: messagebox.showerror("Error Export", f"{e}")

if __name__ == "__main__":
    root = tk.Tk(); app = InvoiceApp(root); root.mainloop()