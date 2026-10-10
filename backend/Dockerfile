# ── Tributos Web · backend (FastAPI) · imagen para Coolify ─────────────────
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# curl: lo usa el healthcheck de Coolify dentro del contenedor.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Chromium + dependencias de sistema para Playwright (~500 MB). Desactivado el
# 10/10/2026: hoy sólo lo usa la prueba de login del SRI de routers/diagnostico.py
# —las descargas van por los marcadores (bajadores), en el navegador de la
# persona— y la imagen de Nixpacks que corría en producción tampoco lo traía.
# Si vuelve a hacer falta en el servidor, basta con descomentar la línea.
# RUN python -m playwright install --with-deps chromium

COPY . .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8000')+'/health').read()" || exit 1

# Respeta $PORT que inyecte Coolify; por defecto 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
