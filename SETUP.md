# Guía de Setup - Gestor Tributario Web

## Resumen del Proyecto

Se ha creado una plataforma web completa que migra el script `SRI-XML.py` a una arquitectura moderna:

- **Backend**: FastAPI + Python
- **Frontend**: React + Vite
- **Base de datos**: Supabase PostgreSQL
- **Autenticación**: Supabase Auth
- **Funcionalidades**: Procesar XMLs del SRI, clasificar facturas, exportar Excel/PDF

---

## Paso 1: Configurar Supabase

### 1.1 Crear Proyecto
1. Ve a https://supabase.com y crea una cuenta
2. Crear nuevo proyecto
3. Copiar:
   - Project URL → `SUPABASE_URL`
   - Service Role Key → `SUPABASE_SERVICE_KEY`
   - Anon Public Key → `SUPABASE_ANON_KEY`

### 1.2 Ejecutar Migraciones
1. En el SQL Editor de Supabase, ejecutar:
   ```
   supabase/migrations/001_initial.sql
   ```
2. Esto creará las tablas y políticas de RLS

### 1.3 Configurar Variables de Entorno

**Backend** (`backend/.env`):
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGc...
SUPABASE_ANON_KEY=eyJhbGc...
JWT_SECRET=your-secret-key-min-32-chars
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

**Frontend** (`frontend/.env.local`):
```
VITE_API_URL=http://localhost:8000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
```

---

## Paso 2: Setup Local

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```
API disponible en: http://localhost:8000

### Frontend
```bash
cd frontend
npm install
npm run dev
```
App disponible en: http://localhost:5173

### Testing
1. Ir a http://localhost:5173
2. Crear cuenta (email/password)
3. Importar `Clasificación.xlsx`:
   - Ve a /clasificador
   - Usa el botón "Importar Excel"
4. Procesar facturas:
   - Dashboard → "Procesar TXT" o "Importar XMLs"

---

## Paso 3: Crear Repositorio GitHub

```bash
cd tributos-web
git remote add origin https://github.com/YOUR_USERNAME/tributos-web.git
git branch -M main
git push -u origin main
```

---

## Información Importante

### Clasificador
- **Importación**: Soporta Excel con formato: RUC | Nombre | Categoría
- **Edición**: Doble click en las celdas para editar inline
- **Persistencia**: Se guarda en Supabase automáticamente

### Procesar Facturas
- **TXT**: Extrae claves de 49 dígitos y descarga XMLs del SRI
- **XML**: Sube XMLs locales directamente
- **Clasificación automática**: Usa el mapa RUC-Categoría

### Exportación
- **Excel**: Genera hoja DATOS + RESUMEN (igual al script original)
- **PDF**: Reporte simple con tabla de facturas

### Seguridad
- Cada usuario ve solo sus datos (RLS habilitado)
- Tokens JWT para autenticación
- CORS configurado

---

## Troubleshooting

### Error de Conexión a Supabase
- Verificar `SUPABASE_URL` y claves en `.env`
- Comprobar que las tablas estén creadas
- Ver logs en Supabase Dashboard

### Error de CORS
- Agregar dominio en `CORS_ORIGINS` del backend

### XMLs No Se Descargan del SRI
- El SRI puede estar saturado
- Reintentar más tarde
- Los errores se reportan en la respuesta

---

## Soporte

Para problemas específicos:
1. Comprobar variables de entorno
2. Verificar estado del SRI: https://www.sri.gob.ec

---

## Próximas Mejoras (Opcional)

- [ ] Integración con webhooks para procesos automáticos
- [ ] Dashboard de analytics
- [ ] API de reportes con filtros avanzados
- [ ] App mobile con React Native
- [ ] Backup automático de datos
