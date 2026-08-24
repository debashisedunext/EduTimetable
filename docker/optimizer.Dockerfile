# Phase 6 (§5.6) — OR-Tools CP-SAT optimizer microservice.
# Single dependency (ortools); the service itself is stdlib HTTP.
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY apps/optimizer/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Dev target: source is bind-mounted by the compose override.
FROM base AS dev
CMD ["python", "-u", "/app/apps/optimizer/server.py"]

FROM base AS prod
COPY apps/optimizer/server.py /app/server.py
CMD ["python", "-u", "/app/server.py"]
