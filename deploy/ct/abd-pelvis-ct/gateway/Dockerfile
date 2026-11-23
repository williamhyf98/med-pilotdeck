FROM python:3.10-slim-bookworm

ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /opt/abd-pelvis-ct/gateway

COPY requirements-runtime.txt ./
RUN python -m pip install --no-cache-dir \
    --index-url "${PIP_INDEX_URL}" \
    -r requirements-runtime.txt \
    && chmod -R a+rX /usr/local/lib/python3.10/site-packages

COPY app.py radar_inference.py entrypoint.sh ./

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /var/lib/abd-pelvis-ct app \
    && mkdir -p /var/lib/abd-pelvis-ct/gateway \
    && chmod 0755 /opt/abd-pelvis-ct \
    && chmod -R u+rwX,go+rX /opt/abd-pelvis-ct/gateway \
    && chmod 0755 /opt/abd-pelvis-ct/gateway/entrypoint.sh \
    && chown -R app:app /opt/abd-pelvis-ct/gateway /var/lib/abd-pelvis-ct

USER 10001:10001

EXPOSE 18120

ENTRYPOINT ["/opt/abd-pelvis-ct/gateway/entrypoint.sh"]
