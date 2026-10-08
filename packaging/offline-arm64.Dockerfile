# syntax=docker/dockerfile:1.7
FROM --platform=$TARGETPLATFORM node:22.23.2-bookworm-slim

ARG TARGETARCH
ARG PYTHON_VERSION=3.12.13
ARG PYTHON_STANDALONE_TAG=20260325
ARG PNPM_VERSION=10.32.1
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONUNBUFFERED=1
ENV PIP_INDEX_URL=${PIP_INDEX_URL}

WORKDIR /src

RUN sed -i \
    -e 's@deb.debian.org/debian@mirrors.tuna.tsinghua.edu.cn/debian@g' \
    -e 's@security.debian.org/debian-security@mirrors.tuna.tsinghua.edu.cn/debian-security@g' \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl file g++ make pkg-config python3 python3-pip python3-venv \
    libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN npm config set registry "${NPM_REGISTRY}" \
  && npm install --global "pnpm@${PNPM_VERSION}" \
  && pnpm install --frozen-lockfile \
  && npm run build \
  && pnpm --dir ui run build

RUN test "$TARGETARCH" = "arm64" \
  && mkdir -p /tmp/python /staging/med-pilotdeck-kylin-v10-arm64/.runtime \
  && curl -fsSL --retry 3 \
    -o /tmp/python.tar.gz \
    "https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/cpython-${PYTHON_VERSION}+${PYTHON_STANDALONE_TAG}-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz" \
  && tar -xzf /tmp/python.tar.gz -C /tmp/python \
  && mv /tmp/python/python /staging/med-pilotdeck-kylin-v10-arm64/.runtime/python \
  && rm -rf /tmp/python /tmp/python.tar.gz

RUN mkdir -p /staging/med-pilotdeck-kylin-v10-arm64/offline/python-wheels \
  && cat > /tmp/offline-requirements.txt <<'EOF'
-r /src/plugins/med-tools/requirements.txt
-r /src/skills/pdf/runtime/requirements.txt
-r /src/skills/docx/requirements.txt
EOF
RUN /staging/med-pilotdeck-kylin-v10-arm64/.runtime/python/bin/python3 \
    -m pip wheel --disable-pip-version-check \
    --wheel-dir /staging/med-pilotdeck-kylin-v10-arm64/offline/python-wheels \
    -r /tmp/offline-requirements.txt

RUN mkdir -p /staging/med-pilotdeck-kylin-v10-arm64/.runtime/node/bin \
  && cp -L /usr/local/bin/node /staging/med-pilotdeck-kylin-v10-arm64/.runtime/node/bin/node

RUN set -eux; \
  stage=/staging/med-pilotdeck-kylin-v10-arm64; \
  mkdir -p "$stage/config" "$stage/ui" "$stage/.pilotdeck-home/plugins"; \
  cp -a dist "$stage/"; \
  cp -a src "$stage/"; \
  cp -a ui/dist ui/server ui/shared ui/public ui/package.json "$stage/ui/"; \
  cp -a node_modules "$stage/"; \
  cp -a ui/node_modules "$stage/ui/"; \
  cp -a scripts skills plugins package.json pnpm-lock.yaml pnpm-workspace.yaml "$stage/"; \
  cp -a config/deploy.env.example "$stage/config/"; \
  cp -a README-OFFLINE.zh-CN.md "$stage/"; \
  cp -a "$stage/config/deploy.env.example" "$stage/config/deploy.env"; \
  PILOT_HOME="$stage/.pilotdeck-home" node "$stage/scripts/bootstrap-pilotdeck-config.mjs"; \
  ln -sfn ../../plugins/med-tools "$stage/.pilotdeck-home/plugins/med-tools"; \
  printf '%s\n' "$stage" > /tmp/stage-path

RUN stage="$(cat /tmp/stage-path)"; \
  export PATH="$stage/.runtime/node/bin:$PATH"; \
  export XDG_CACHE_HOME="$stage/.runtime/cache/xdg"; \
  mkdir -p "$XDG_CACHE_HOME"; \
  bash "$stage/skills/pptx/scripts/pptx.sh" bootstrap-runtime >/dev/null; \
  bash "$stage/skills/spreadsheets/scripts/spreadsheet.sh" bootstrap-runtime >/dev/null

RUN stage="$(cat /tmp/stage-path)"; \
  node - "$stage" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stage = process.argv[2];
const manifest = {
  product: "med-pilotdeck",
  package: "kylin-v10-arm64",
  target: "linux/arm64",
  node: readFileSync("/usr/local/bin/node").length > 0 ? "22.23.2" : "unknown",
  python: "3.12.13",
  specializedCtEnabled: false,
  generatedAt: new Date().toISOString(),
  notes: [
    "Built in a Linux ARM64 container.",
    "RADAR and DeepChest are disabled by default.",
    "Python virtual environments are created offline on first start from bundled wheels.",
  ],
};
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of [
  "scripts/check-offline.sh",
  "scripts/prepare-offline-runtime.sh",
  "scripts/start-offline.sh",
  "scripts/stop-offline.sh",
  "scripts/status-offline.sh",
]) chmodSync(join(stage, name), 0o755);
NODE

FROM scratch AS package
COPY --from=0 /staging/med-pilotdeck-kylin-v10-arm64 /
