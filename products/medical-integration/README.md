# Medical Integration Feature Pack

这是基于 PilotDeck 原生实现的医疗领域 Feature Pack。PilotDeck 继续负责 Agent 会话、模型路由、生成、权限和 transcript；本目录提供 Dialogue、Med-trauma、表格 OCR、Gallery、Volume、M3D adapter、医疗工作流、结构化契约和不直连生成模型的 Python sidecar。

> 本项目仅用于辅助决策和工程集成，不替代医生诊断、分诊或处置。高风险结论必须由具备资质的人员复核。

## 目录

```text
medical-integration/
  config/                     无秘密示例配置
  data/                       经授权复制、校验并去标识化的本地制品
  fixtures/                   无 PHI 的验收用合成文件
  profiles/                   声明式医疗 Agent Profile
  reference-ui/               只用于视觉/契约核对的旧界面基线
  skills/                     六类医疗工作流
  docker-compose.medical.yml  单机离线交付编排
  plugins/medical-tools/      PilotDeck MCP 插件 manifest
  sidecar/
    src/medical_sidecar/
      api/                    localhost-only FastAPI
      mcp/                    streamable HTTP MCP 入口
      ingestion/              附件格式、manifest 与安全路径
      rag/                    检索输入、来源和余弦检索契约
      table/                  表格规范化与安全 CSV
      imaging/                Gallery、Volume/TTL 存储与 M3D adapter
      clinical/               诊疗、翻译、病例库、Eval/Compare 契约
      trauma/                 六阶段 prompt builder
    sample_data/              人工构造、无 PHI 小样例
    tests/                    无网络、无模型、无数据库单元测试
```

## 已实现边界

- 附件：TXT、Markdown、JSON、XML/CDA/aECG 的内存解析；PDF 文本/受限页面预览、常见图片 metadata/缩放、DICOM 脱敏 metadata/均匀受限帧、WFDB 配套文件解析均采用可选依赖，缺少依赖或配套文件时返回明确 `degraded`。
- RAG：从 `data.root` 下读取已复制的版本化 JSONL/NPY 制品，校验 license、SHA-256、行数和维度；向量矩阵按行懒读取；既支持 PilotDeck 提供 query vector，也可在显式配置 embedding boundary 后检索文本 query。embedding 不可用时使用确定性本地词法降级并明确标识 `lexical-fallback`，不会伪造结果或下载数据。
- 表格：容错读取 JSON、Markdown、HTML；列宽对齐、预算限制、原始输出追溯；CSV 公式注入防护；`table-ocr.v1` 提供图像 manifest、PilotDeck prompt、JSON Schema 与解析契约。
- 临床工作流：`clinical-workflows.v1` 覆盖多来源诊疗方案、医学翻译、去标识化病例库记录、Eval 和 Compare。sidecar 只构造 prompt、校验输入/输出 JSON，实际生成始终由 PilotDeck 完成。
- 战创伤：伤员发生地、野战分类场、收容处置组、重伤救治组、手术组、洗消组六阶段；`eval`/`plain` prompt；五段固定输出结构；图片 ID、标签和顺序 metadata。
- Gallery：按配置扫描 `data.root` 下的数据集、病例目录和图像切片；拒绝遍历与符号链接逃逸，不返回目录或报告正文，切片会重编码并标记为非诊断级。
- Volume：保留无状态 prepare，并新增上传、列表、详情、指定轴位切片和删除。默认 `temporary` 仅保存在进程内并按 TTL 清理；`filesystem` 必须显式配置可信根并设置 `persist_phi: true`，且仍按 TTL 删除。
- M3D：可选 feature flag；只允许固定回环 origin 与固定 health/infer path，拒绝重定向和请求中的本地路径，使用配置硬超时。未启用、未启动或超时时均返回 `unavailable`。
- 服务：FastAPI 与 MCP 同步暴露附件、RAG、OCR/临床契约、Gallery、Volume 和 M3D 工具。两种服务默认均只允许监听回环地址。

`data/asset-manifest.json` 记录经授权复制制品的源版本、文件数、大小和 SHA-256。影像已安全重编码并移除元数据；未复制远端 runtime、数据库、日志、模型权重、配置秘密或未获授权数据。`reference-ui/` 只用于视觉与契约核对，不接入生产运行。

## 模型与网络职责

- sidecar 不定义、读取、保存或调用任何生成模型 API Key。
- 所有生成和多模态模型调用必须由 PilotDeck ModelRuntime 完成。
- embedding 默认关闭。启用时 URL 的主机必须在显式 allowlist 中，并且解析出的所有地址都必须是 loopback 或 private；客户端拒绝 link-local/云 metadata 地址、凭据、重定向和非 HTTP(S) URL。
- `data.root` 是所有本地制品的唯一可信锚点；RAG、Gallery 和持久化 Volume 只接受其下的相对路径，解析后还会再次检查根目录边界。
- PHI 默认不持久化：附件、OCR、临床 prompt 和 Gallery 均不落盘；Volume 默认为内存 TTL。只有部署方显式启用 `filesystem` 和 `persist_phi: true` 才会保存原始 Volume。
- FastAPI 与 MCP 启动器拒绝 `0.0.0.0`、公网 IP 和非回环主机。
- 默认关闭医疗场景的跨会话 Memory、Web Search 和 Telemetry；是否实际生效以部署时使用的 PilotDeck 主配置为准。

## 配置

1. 将 `config/pilotdeck.example.yaml` 中的安全项合并到已有 `~/.pilotdeck/pilotdeck.yaml`。示例故意不提供模型 Provider 或秘密。
2. 复制 `config/medical.example.yaml` 到部署配置目录，再按内网资产填写允许项。
   先设置 `data.root`。启用 RAG 时必须填写该根下的 JSONL/NPY 相对路径、两份制品的 SHA-256、版本、embedding 模型标识和 license；sidecar 不会从远端下载制品。
   Gallery 数据集路径与 filesystem Volume 根同样只能使用 `data.root` 下的相对路径。
3. 将 `plugins/medical-tools` 链接或复制到项目级 `.pilotdeck/plugins/medical-tools`；插件会同时注册 MCP 与 `agents/` 下的四个医疗 Agent Profile。
4. 将需要的 `skills/*` 链接或复制到项目级 `.pilotdeck/skills/`。
5. `profiles/` 保存可审阅的 Profile 模板；运行时使用 `plugins/medical-tools/agents/`，两处修改时应保持同步。
6. UI Server 通过 `PILOTDECK_MEDICAL_SIDECAR_URL=http://127.0.0.1:8765/` 连接 REST capability API；可用 `PILOTDECK_MEDICAL_SIDECAR_ALLOWED_PORTS=8765` 进一步锁定端口。
7. `customer-presets/` 保存无秘密、可版本化的单位差异清单；当前离线战创伤交付使用 `offline-military/manifest.yaml`。客户差异应通过 preset、feature flag、Profile 和 Plugin 组合发布，不建立长期源码分支。

视觉模型必须在 PilotDeck 配置中真实声明多模态能力，否则一键 OCR 会拒绝发送图片：

```yaml
model:
  providers:
    approved-provider:
      models:
        approved-vision-model:
          multimodal:
            input: [text, image]
```

插件默认连接 `http://127.0.0.1:8766/mcp`。如修改 MCP 端口，请同步修改部署后的 `plugin.json` 或项目 MCP 配置。

## Sidecar 本地运行

需要 Python 3.11+。依赖范围见 `sidecar/pyproject.toml` 和 `sidecar/requirements.txt`；本目录不附带虚拟环境或运行时。

```bash
cd products/medical-integration/sidecar
# 分别在两个终端启动：
python -m medical_sidecar.api --config ../config/medical.yaml
python -m medical_sidecar.mcp --config ../config/medical.yaml
```

采用 `src` 布局且未安装包时，可临时将 `sidecar/src` 加入 `PYTHONPATH`。两个入口默认分别监听 `127.0.0.1:8765` 和 `127.0.0.1:8766`；MCP 路径为 `/mcp`。

Windows 开发环境可在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\products\medical-integration\scripts\start-dev.ps1 `
  -Config .\products\medical-integration\config\medical.yaml
```

该脚本会复用已运行的 8765/8766 服务，或启动本地 sidecar，然后以前台方式启动 PilotDeck；按 `Ctrl+C` 后会清理由脚本启动的 sidecar。

## Docker 单机离线交付

先在审阅后的 `pilotdeck.yaml` 中配置批准的模型端点和多模态声明，或通过秘密管理系统提供 PilotDeck 的模型环境变量。随后在仓库根目录执行：

```bash
docker compose -f products/medical-integration/docker-compose.medical.yml up --build
```

API 与 MCP sidecar 通过 `network_mode: service:pilotdeck` 与 PilotDeck 共用网络命名空间，因此仍只监听 `127.0.0.1:8765/8766`，不会向宿主机或容器网络暴露医疗内部端口。医疗数据和插件采用只读 bind mount，PilotDeck 状态使用独立持久卷。

## 纯单元测试

测试只读取仓库内人工样例和测试临时目录，不访问远端、数据库或模型；原有 45 项测试保留，扩展后共 58 项：

```bash
cd products/medical-integration/sidecar
PYTHONPATH=src python -m unittest discover -s tests -v
```

PowerShell：

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

## 来源与整理原则

契约和初版解析参考了只读医疗项目中的 `ingestion/models.py`、`ingestion/parsers.py`、`ingestion/service.py`、`war_trauma_rag.py`、`volume3d.py`、`table_ocr.py`、`gallery3d.py` 与 Trauma prompt builder。实现进行了重新分层和安全收口，没有复用其模型直调、上传落盘、SQLite、绝对数据根或外部服务配置。

## 明确边界

- 未安装 `PyMuPDF`、`Pillow`、`pydicom`、`wfdb`、`numpy`/`nibabel` 时，对应 PDF、图片缩放、DICOM 帧、WFDB 波形、NIfTI 能力会明确降级；Docker sidecar 默认安装完整 formats 依赖。
- embedding 只支持显式 allowlist 的内部接口；未配置时采用有标识的词法降级，不等价于语义向量检索。
- filesystem Volume 是显式开启的单机 TTL 存储，不是多节点对象存储；默认仍为内存 temporary 模式。
- 不附带 GPU、医学模型权重或 M3D 服务本体；M3D 仅在批准的 localhost 服务已部署且 feature flag 开启时可用。
- 结果用于辅助决策，不具备诊断级承诺；DICOM burned-in PHI 未确认清除时禁止预览。

