# med-pilotdeck 麒麟 V10 ARM64 离线部署指南

本包面向 Linux ARM64 离线服务器。应用、Linux ARM64 Node、Linux ARM64
Python、Node 原生依赖、Python wheel 和 RAG 回退数据已经随包提供。首次启动只
会在本机从包内 wheel 创建虚拟环境，不访问 npm、PyPI 或公网。

## 1. 解压与目录

```bash
tar -xzf med-pilotdeck-kylin-v10-arm64.tar.gz
cd med-pilotdeck-kylin-v10-arm64
```

`.pilotdeck-home/` 是运行时数据根目录，保存配置、账号数据库、项目、会话、
记忆、附件和日志。发布包只带干净目录和占位配置，不带开发机历史数据或密钥。

## 2. 修改配置

先编辑部署环境：

```bash
vi config/deploy.env
```

重点配置：

```env
SERVER_PORT=3010
PILOTDECK_GATEWAY_PORT=18789
MED_SPECIALIZED_CT_ENABLED=0
MED_VLM_API_BASE=http://医学模型服务器:端口/v1
MED_RAG_SERVICE_API_BASE=http://RAG服务器:端口
MED_EMBEDDING_API_BASE=http://Embedding服务器:端口/v1
```

主 Agent 的 OpenAI 兼容模型仍配置在：

```text
.pilotdeck-home/pilotdeck.yaml
```

至少修改 `model.providers` 中的 URL、Key、模型名，以及 `agent.model` 和
`router.scenarios.default`。服务不校验 Key 时使用 `EMPTY`。

当前 `MED_SPECIALIZED_CT_ENABLED=0`，因此 RADAR、DeepChest 以及相关 Skill
保持隐藏和禁用；DICOM 本地预检和 `med-medical` 通用解析仍然可用。

## 3. 启动、停止和查看状态

```bash
bash scripts/check-offline.sh
bash scripts/start-offline.sh
bash scripts/status-offline.sh
bash scripts/stop-offline.sh
```

首次启动会：

1. 创建 `.pilotdeck-home` 的运行目录和 `med-tools` 相对软链接；
2. 使用包内 Python 和 wheel 离线创建医学、PDF、DOCX 运行环境；
3. 启动 Gateway 和生产 Web 服务；
4. 把日志写入 `.runtime/logs/`。

浏览器访问 `config/deploy.env` 中 `SERVER_PORT` 对应的地址。默认是：

```text
http://服务器地址:3010
```

## 4. 依赖和网络边界

启动脚本不会执行 `npm install`、`pnpm install` 或联网 `pip install`。主 Agent、
医学 VLM、Embedding 和 RAG 可以通过 `config/deploy.env` 访问现场内网服务。
远程 RAG 不可用时，med-tools 会尝试使用包内的本地战创伤语料。

LibreOffice、Poppler 等系统级办公程序是否可用由目标机发行版决定。缺少它们时，
对应的转换或预览能力会报告缺少系统组件，医学 DICOM 解析和主对话不受影响。

## 5. 数据备份

停止服务后备份整个目录即可：

```bash
tar -czf med-pilotdeck-data-backup.tar.gz .pilotdeck-home
```

不要把真实的 `config/deploy.env` 或 `.pilotdeck-home` 提交回 Git。

## 6. 校验发布包

在发布包旁执行：

```bash
sha256sum -c med-pilotdeck-kylin-v10-arm64.tar.gz.sha256
```

本包是在 Linux ARM64 构建容器中生成的。目标机首次启动仍需通过
`check-offline.sh`，以确认麒麟系统的 glibc、权限和端口条件满足要求。
