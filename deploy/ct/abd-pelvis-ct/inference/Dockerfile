FROM python:3.10-slim-bookworm

ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu126

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /opt/abd-pelvis-ct/inference

COPY requirements-gpu.txt ./

COPY --from=hostpkgs torch /usr/local/lib/python3.10/site-packages/torch
COPY --from=hostpkgs torch-2.7.1.dist-info /usr/local/lib/python3.10/site-packages/torch-2.7.1.dist-info
COPY --from=hostpkgs nvidia /usr/local/lib/python3.10/site-packages/nvidia
COPY --from=hostpkgs cusparselt /usr/local/lib/python3.10/site-packages/cusparselt
COPY --from=hostpkgs triton /usr/local/lib/python3.10/site-packages/triton
COPY --from=hostpkgs torchgen /usr/local/lib/python3.10/site-packages/torchgen
COPY --from=hostpkgs sympy /usr/local/lib/python3.10/site-packages/sympy
COPY --from=hostpkgs mpmath /usr/local/lib/python3.10/site-packages/mpmath
COPY --from=hostpkgs networkx /usr/local/lib/python3.10/site-packages/networkx
COPY --from=hostpkgs filelock /usr/local/lib/python3.10/site-packages/filelock
COPY --from=hostpkgs fsspec /usr/local/lib/python3.10/site-packages/fsspec

RUN python -m pip install \
        --index-url "${PIP_INDEX_URL}" \
        -r requirements-gpu.txt \
    && python -m pip install --no-deps \
        --index-url "${PIP_INDEX_URL}" \
        monai==1.5.0 \
    && chmod -R a+rX /usr/local/lib/python3.10/site-packages \
    && python -c "import torch; print(torch.__version__, torch.version.cuda)"

COPY gpu_api.py radar_inference.py entrypoint.sh ./
COPY damo-radar ./damo-radar
COPY models ./models

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /var/lib/abd-pelvis-ct app \
    && mkdir -p /var/lib/abd-pelvis-ct/inference \
    && chmod 0755 /opt/abd-pelvis-ct \
    && chmod -R u+rwX,go+rX /opt/abd-pelvis-ct/inference \
    && chmod 0755 /opt/abd-pelvis-ct/inference/entrypoint.sh \
    && chown -R app:app /var/lib/abd-pelvis-ct

USER 10001:10001

EXPOSE 18221

ENTRYPOINT ["/opt/abd-pelvis-ct/inference/entrypoint.sh"]
