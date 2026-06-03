# Gestor SRI Web

Plataforma web para procesar, clasificar y exportar facturas del SRI (Servicio de Rentas Internas) de Ecuador.

## Arquitectura

- **Backend**: FastAPI + Python
- **Frontend**: React + Vite
- **Base de datos**: Supabase (PostgreSQL)
- **Hosting**: Render

## Setup Local

### Prerequisites
- Python 3.10+
- Node.js 18+
- Git

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Supabase

1. Crear proyecto en https://supabase.com
2. Ejecutar migraciones en `supabase/migrations/`
3. Configurar variables de entorno

## Deployment

Conectar repositorio GitHub a Render para deploy automático.
