FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml ./
COPY src/ src/

RUN pip install --no-cache-dir ".[formats]" \
    && useradd --create-home --uid 10001 medical \
    && chown -R medical:medical /app

USER medical

EXPOSE 8765 8766

CMD ["medical-sidecar-api", "--config", "/medical/config/medical.yaml"]
