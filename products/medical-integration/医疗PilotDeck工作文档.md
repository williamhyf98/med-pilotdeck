# 医疗 PilotDeck 工作文档

> 基于 PilotDeck 开源 AI Agent 操作系统的医疗领域 Feature Pack 开发全过程记录

---

## 目录

- [第一部分：PilotDeck 框架熟悉](#第一部分pilotdeck-框架熟悉)
- [第二部分：改进部分](#第二部分改进部分)
- [第三部分：还存在哪些问题](#第三部分还存在哪些问题)
- [第四部分：下一步优化方向](#第四部分下一步优化方向)

---

# 第一部分：PilotDeck 框架熟悉

## 1.1 PilotDeck 是什么

PilotDeck 是由清华大学 THUNLP 实验室、面壁智能、OpenBMB 与 AI9Stars 联合研发并开源的 **AI Agent 操作系统**。它以 **WorkSpace（工作舱）** 为核心设计，面向长周期、多项目并行的生产力场景。

### 核心设计理念

| 维度 | 传统 AI Agent（黑盒） | PilotDeck（白盒） |
|------|----------------------|-------------------|
| 可见性 | 看不到 AI 记住了什么 | 随时查看记忆内容、时间、归属 |
| 可控性 | 写入后无法修改/删除 | 手动改/删/标记关键节点 |
| 可追溯 | 出错无法定位根因 | 全链路可查可改 |
| 隔离性 | 共享记忆池，跨项目污染 | 按 WorkSpace 隔离 |

### 四大核心能力

1. **WorkSpace 级隔离与沉淀**：每个项目拥有独立的文件系统、记忆库与技能集
2. **白盒记忆**：记忆的生成→抽取→存储→使用全链路可见，支持一键回滚
3. **智能路由与成本优化**：复杂任务调用强力模型，简单任务降级至轻量模型，实测节省 ~70% 成本
4. **Always-on 常驻执行**：用户离开后 Agent 仍能后台推进任务、汇报进展

## 1.2 框架架构全景

```
PilotDeck 核心框架（TypeScript / Node.js）
├── src/
│   ├── agent/          # Agent 会话管理与生命周期
│   ├── cli/            # CLI 入口（pilotdeck server / skills migrate）
│   ├── context/        # 上下文记忆系统（EdgeClaw Memory Core）
│   ├── cron/           # 定时任务调度
│   ├── extension/      # 插件系统（plugin.json、hooks、agents、commands）
│   ├── gateway/        # API 网关
│   ├── lifecycle/      # 生命周期钩子（PreToolUse、UserPromptSubmit 等）
│   ├── mcp/            # MCP 协议原生支持
│   ├── model/          # 模型路由与 Provider 适配（OpenAI / Anthropic / Gemini / DeepSeek 等）
│   ├── network/        # 网络层
│   ├── permission/     # 权限管理
│   ├── pilot/          # 核心调度引擎
│   ├── router/         # ClawXRouter 智能路由
│   ├── session/        # 会话管理
│   ├── status/         # 状态管理
│   ├── task/           # 任务编排
│   ├── telemetry/      # 遥测（可配置关闭）
│   ├── tool/           # 工具注册与调用框架
│   └── web/            # Web 服务
├── ui/                 # React + Vite + Tailwind CSS + shadcn/ui 前端
├── skills/             # 内置技能库（35+ 技能）
├── products/           # 产品定制目录（Feature Pack）
│   ├── _example/       # 产品定制模板
│   └── medical-integration/  # ★ 医疗 Feature Pack（本次工作核心）
└── docs/               # 文档
```

### 产品定制机制（Feature Pack 模式）

PilotDeck 核心框架通过 `products/` 目录支持**产品级定制**，无需修改核心代码：

```
products/<product-name>/
├── config/           # 无秘密示例配置（YAML）
├── plugins/          # MCP 插件 + Agent Profiles + Slash Commands
├── skills/           # 领域技能（SKILL.md）
├── profiles/         # 声明式 Agent Profile 模板
├── customer-presets/ # 客户差异预设（manifest.yaml）
├── scripts/          # 辅助脚本
├── data/             # 经授权的本地数据制品
├── reference-ui/     # 旧版 UI 基线（仅用于视觉/契约核对）
├── sidecar/          # 独立服务（不耦合核心框架语言/运行时）
└── docker-compose.*.yml  # 交付编排
```

### 插件系统架构

```
plugin.json
{
  "name": "medical-tools",
  "agents": "agents/",          # Agent Profile 目录
  "commands": "commands/",      # Slash Command 目录
  "mcpServers": {               # MCP 服务注册
    "medical-sidecar": {
      "url": "http://127.0.0.1:8766/mcp",
      "instructions": "..."
    }
  },
  "settings": {
    "generationOwner": "pilotdeck",   # 明确：生成模型由 PilotDeck 调用
    "localhostOnly": true,            # 强制仅本地
    "memoryDefault": "disabled",      # 医疗场景默认关闭跨会话记忆
    "publicWebDefault": "disabled"    # 默认关闭公网搜索
  }
}
```

### 关键设计原则（与后续医疗工作密切相关）

1. **生成模型职责分离**：PilotDeck 的 `ModelRuntime` 是唯一调用 LLM 的组件，Sidecar/插件永不直接调用生成模型
2. **配置驱动**：通过 `~/.pilotdeck/pilotdeck.yaml` 管理所有 Provider、模型、API Key
3. **MCP 原生支持**：所有外部工具通过 MCP 协议接入，跨前端（Web/CLI/IM）行为一致
4. **生命周期钩子**：`PreToolUse`、`UserPromptSubmit` 等钩子允许在关键节点注入逻辑
5. **Agent Profile**：声明式定义 Agent 的行为边界、工具集和系统提示

## 1.3 框架学习路径与关键理解

在接触 PilotDeck 框架的过程中，重点学习和理解了以下层次：

### 第一层：运行时与部署
- Node.js 22.13+ 运行时要求（内置 SQLite）
- pnpm workspace monorepo 结构
- TypeScript 编译与 dist 目录组织
- CLI 入口 `pilotdeck server` 启动流程
- 开发模式（`npm run dev`）vs 生产模式（`npm run server`）
- Docker 单机部署模式

### 第二层：核心抽象
- **WorkSpace**：项目级隔离单元，承载文件、记忆、技能
- **Agent Profile**：声明式 Agent 定义（系统提示 + 可用工具 + 行为约束）
- **Skill**：Markdown 格式的工作流指令，由 Agent 加载执行
- **MCP Tool**：通过 MCP 协议注册的外部工具，Agent 通过 Tool Call 调用
- **Lifecycle Hook**：拦截 Agent 生命周期的关键事件

### 第三层：数据流
```
用户输入 → Gateway → Router（模型选择）→ Agent Session
  → Tool Call（可选）→ MCP Server → Sidecar 处理
  → ModelRuntime（LLM 推理）→ 响应 → 记忆抽取 → 持久化
```

### 第四层：安全模型
- 插件代码与核心严格隔离
- MCP 服务默认仅监听回环地址
- 配置文件分层（全局 ~/.pilotdeck/ vs 项目级 .pilotdeck/）
- 权限审批机制（Bash、文件读写等需用户确认）

---

# 第二部分：改进部分

## 2.1 总体改进概述

原始的医疗代码（参考只读医疗项目）存在以下架构问题：
- **直接调用生成模型**：parser、trauma builder 等模块内嵌了 LLM API 调用
- **文件上传落盘**：附件直接写入磁盘，存在 PHI 泄露风险
- **SQLite 持久化**：使用 SQLite 存储数据，增加部署复杂度
- **绝对数据根**：硬编码服务器绝对路径，不可移植
- **外部服务强依赖**：依赖外部 embedding 服务、M3D 服务等

本次工作对上述问题进行了**全面重构**，同时保持了功能的完整性。核心改进思路是：**将 Sidecar 定位为"纯结构化工具层"，只构造 prompt、校验输入/输出 JSON，实际生成始终由 PilotDeck 完成。**

## 2.2 架构改进详解

### 改进 1：从"直调模型"到"Sidecar 模式"

**原始问题**：原代码在 Python 侧直接调用 OpenAI/Anthropic API 进行生成。

**改进方案**：建立严格的职责边界

```
改进前（直接调用）:
  Python Code → OpenAI API → 返回结果

改进后（Sidecar 模式）:
  Python Sidecar → 构造 Prompt + JSON Schema → MCP → PilotDeck Agent
    → ModelRuntime → LLM → 解析输出 → 返回结构化结果
```

**具体实现**：
- 所有 Python 模块的 prompt builder 只返回 `system_prompt` + `user_prompt` + `output_schema`
- 每个返回体标注 `"generation_owner": "pilotdeck"` 和 `"sidecar_calls_model": False`
- MCP 工具描述中明确声明"不调用生成模型、不接收 LLM API Key"

**影响范围**：
- `trauma/prompt_builder.py`：六阶段战创伤 prompt 构建，从不调用模型
- `clinical/workflows.py`：五个临床工作流的 prompt 构建和输出解析
- `table/ocr.py`：表格 OCR 的 prompt 构建和输出解析
- `mcp/tools.py`：所有 25+ 个 MCP 工具方法

### 改进 2：PHI 安全防护体系

**原始问题**：原代码将附件落盘、PHI 信息可能留存文件系统。

**改进方案**：建立多层 PHI 防护

| 层级 | 措施 | 说明 |
|------|------|------|
| 内存处理 | 所有附件解析在内存中完成 | `BytesIO` 处理，不写临时文件 |
| 默认不持久化 | Volume 默认 `temporary` 模式 | 仅保存在进程内存，TTL 自动清理 |
| 显式授权 | `persist_phi: true` 必须显式配置 | filesystem 模式需同时满足多项条件 |
| DICOM 防护 | 移除患者身份字段 + 烧录文字检查 | `BurnedInAnnotation` 未确认时阻止预览 |
| 路径过滤 | 拒绝输出中的路径、密钥、令牌 | `_public_value()` 递归过滤敏感字段 |

**具体实现**：
```python
# 附件解析全程内存操作
def parse_attachment(data: bytes, ...) -> ParseOutcome:
    # 使用 BytesIO，不创建临时文件
    with Image.open(BytesIO(data)) as source:
        ...

# DICOM 字段白名单
safe_fields = (
    "Modality", "BodyPartExamined", "Manufacturer",
    "ManufacturerModelName", "Rows", "Columns",
    "NumberOfFrames", "PhotometricInterpretation",
)
# 敏感字段哈希化
removed_fields = [
    "PatientName", "PatientID", "PatientBirthDate",
    "PatientAddress", "AccessionNumber", ...
]

# PHI 持久化显式授权
if self.volume_storage.mode == "filesystem":
    if not self.volume_storage.persist_phi:
        raise ValueError("filesystem Volume storage requires explicit persist_phi=true")
```

### 改进 3：网络安全加固

**原始问题**：原代码可能监听 `0.0.0.0` 或公网 IP。

**改进方案**：

```python
def require_loopback_host(host: str) -> str:
    """只允许 localhost 或 loopback IP"""
    value = (host or "").strip().lower()
    if value == "localhost":
        return value
    address = ipaddress.ip_address(value)
    if not address.is_loopback:
        raise ValueError(f"non-loopback bind address is forbidden: {host!r}")
    return address.compressed
```

**加固措施**：
- FastAPI + MCP 启动器拒绝 `0.0.0.0`、公网 IP 和非回环主机
- TrustedHostMiddleware 仅允许 `127.0.0.1`、`localhost`、`::1`
- Embedding 端点需通过 allowlist 校验 + DNS 解析后地址验证
- 拒绝 link-local（169.254.x.x）和云 metadata 地址
- Docker 部署使用 `network_mode: "service:pilotdeck"` 共用网络命名空间

### 改进 4：路径安全与沙箱

**原始问题**：原代码使用绝对路径，存在路径遍历风险。

**改进方案**：

```python
def safe_relative_path(path: str, max_depth: int = 8) -> PurePosixPath:
    """拒绝绝对路径、遍历和过深嵌套"""
    # 拒绝: /etc/passwd, C:/secret, ../escape, a/../../secret
    # 拒绝: 超过 max_depth 层的路径
    ...

def resolve_under_root(root: str | Path, relative: str, must_exist: bool = False) -> Path:
    """解析后再次检查根目录边界，拒绝符号链接逃逸"""
    candidate = Path(root).joinpath(*relative.split("/")).resolve()
    candidate.relative_to(root)  # 确保不逃逸
    return candidate
```

**影响范围**：
- RAG 制品读取（JSONL corpus + NPY embeddings）
- Gallery 数据集扫描
- Volume 文件系统持久化
- 所有 `data.root` 下的相对路径引用

### 改进 5：配置系统从零构建

**原始问题**：原代码配置分散、缺少校验。

**改进方案**：构建了完整的分层配置系统

```
配置加载优先级（从低到高）：
1. 代码默认值（SidecarSettings dataclass 工厂）
2. YAML 配置文件（medical.yaml）
3. 环境变量覆盖（MEDICAL_* 前缀，40+ 个变量）

配置校验层次：
1. 类型校验（int/float/bool/str）
2. 范围校验（端口 1-65535、超时 (0, 120]、像素预算等）
3. 关系校验（default_top_k ≤ max_top_k、max_file_bytes ≤ max_total_bytes）
4. 安全校验（loopback 地址、路径不逃逸、SHA-256 格式、无凭据泄露）
5. 依赖校验（Gallery 开启需 version+license、filesystem 需 persist_phi）
```

**配置结构（config.py，720 行）**：
```python
@dataclass(frozen=True)
class SidecarSettings:
    api_host: str = "127.0.0.1"
    api_port: int = 8765
    mcp_enabled: bool = True
    mcp_host: str = "127.0.0.1"
    mcp_port: int = 8766
    embedding: EmbeddingSettings      # embedding 子配置
    data: DataSettings                # 数据根目录
    ingestion: IngestionLimits        # 附件预算
    rag: RagLimits                    # RAG 配置
    table: TableLimits                # 表格预算
    imaging: ImagingLimits            # 影像预算
    gallery: GallerySettings          # Gallery 数据集
    volume_storage: VolumeStorageSettings  # Volume 持久化
    m3d: M3DSettings                  # M3D adapter
    workflows: WorkflowLimits         # 临床工作流预算
```

### 改进 6：附件解析系统重构

**原始问题**：原代码格式支持有限，错误处理不足。

**改进方案**：统一解析框架 + 显式降级

**支持的格式矩阵**：

| 格式类别 | 具体格式 | 依赖 | 降级策略 |
|----------|----------|------|----------|
| 文本 | TXT, Markdown | 无 | 无 |
| 结构化文本 | JSON, XML, CDA | 无 | JSON 语法错误→文本降级；XML DTD→拒绝 |
| 心电 | aECG XML, WFDB (.hea+.dat) | wfdb（可选） | 无 wfdb→metadata 提取；无配套文件→明确标识 |
| 文档 | PDF | PyMuPDF（可选） | 无 PyMuPDF→degraded；无文本层→扫描版 |
| 图像 | PNG, JPEG, BMP, GIF, WebP | Pillow（可选） | 无 Pillow→基础尺寸检测 |
| 医学影像 | DICOM | pydicom（可选） | 无 pydicom→degraded；像素超预算→metadata only |

**统一解析接口**：
```python
@dataclass
class ParseOutcome:
    kind: str           # document / image / dicom / ecg
    subtype: str        # pdf / dicom_ct / aecg_xml / ...
    status: str         # ready / degraded
    summary: str        # 人类可读摘要
    metadata: dict      # 结构化元数据
    warnings: list[str] # 降级/安全警告
    included: bool      # 是否纳入 Agent 上下文
    previews: list      # 受限预览（文本或非诊断级图像）
```

### 改进 7：RAG 检索系统重构

**原始问题**：原 RAG 代码与生成逻辑耦合，缺少离线降级。

**改进方案**：版本化制品 + 双重检索策略

**核心设计**：
```
┌─────────────────────────────────────────────┐
│ RAG 检索流程                                │
├─────────────────────────────────────────────┤
│ 1. 制品校验                                 │
│    ├── SHA-256 完整性校验                   │
│    ├── 行数一致性校验（corpus ↔ embeddings） │
│    └── 维度/行数预算校验                    │
│                                             │
│ 2. 检索策略选择                             │
│    ├── embedding 可用 → 余弦相似度检索       │
│    │   └── Top-K heap 排序，min_score 过滤   │
│    └── embedding 不可用 → 词法降级           │
│        ├── 中文 bigram 分词                 │
│        ├── 英文/数字 token 匹配             │
│        └── 精确短语匹配加分（score ≥ 0.95）  │
│                                             │
│ 3. 结果追溯                                 │
│    ├── source_id / chunk_id / score         │
│    ├── title / section / source / preview   │
│    └── corpus_version / embedding_model     │
└─────────────────────────────────────────────┘
```

**词法降级实现亮点**：
```python
def _lexical_tokens(query: str) -> tuple[str, ...]:
    """中文使用 bigram 分词，英文使用单词 token"""
    for raw in re.findall(r"[a-zA-Z0-9_.-]+|[\u4e00-\u9fff]+", query.lower()):
        if re.fullmatch(r"[\u4e00-\u9fff]+", raw) and len(raw) > 2:
            tokens.extend(raw[i:i+2] for i in range(len(raw)-1))
        else:
            tokens.append(raw)
```

### 改进 8：临床工作流契约化

**原始问题**：原代码缺少输出格式约束，结果不可靠。

**改进方案**：五类临床工作流 + JSON Schema 严格校验

| 工作流 | 用途 | 输入要求 | 输出 Schema |
|--------|------|----------|-------------|
| treatment_plan | 多来源诊疗方案综合 | ≥2 sources | summary + assessments[] + plan[] + uncertainties + safety_escalations |
| translation | 医学文本翻译 | text + target_language | translated_text + terms[] + uncertainties |
| case_library | 去标识化病例库 | ≥1 source | case_record + learning_points + deidentification |
| eval | 候选方案评估 | ≥2 candidates | scores[] + preferred_candidate_id + rationale + safety_findings |
| compare | 候选方案对比 | ≥2 candidates | dimensions[] + consensus + differences + recommendation |

**校验层次**：
```python
def parse_clinical_output(workflow, model_output, limits):
    # 1. 去除 <think> 标签
    # 2. 多策略 JSON 提取（裸 JSON / code block / 首尾花括号）
    # 3. 类型匹配校验（递归 Schema 验证）
    # 4. 必需字段校验
    # 5. 非有限数值拒绝
    # 6. 输出大小预算检查
    # 7. 嵌套深度限制（≤32 层）
```

### 改进 9：战创伤六阶段 Prompt 工程

**原始问题**：原代码 prompt 模板固化，场景适配性差。

**改进方案**：双模式 + 六阶段 + 图像元数据管理

```
战创伤 Prompt 构建器（prompt_builder.py）
├── 六阶段覆盖全救治链
│   ├── 伤员发生地（现场急救 + 伤标/后送）
│   ├── 野战分类场（分类 + 分流）
│   ├── 收容处置组（复查 + 完善检查）
│   ├── 重伤救治组（识别危重 + 复苏/手术决策）
│   ├── 手术组（围手术期 + 术后去向）
│   └── 洗消组（污染控制 + 复测分流）
│
├── 两种风格
│   ├── eval：战时分级救治规则 + 五段固定输出
│   └── plain：民用急诊创伤思路 + 自由格式
│
└── 图像处理
    ├── 五类：创面 / X光 / 心电 / CT / 其他
    ├── 身份校验：image_id 唯一性 + index 唯一性
    ├── 排序输出：按 index → image_id 稳定排序
    └── 逐图判读：多图时强制逐张判读后再综合
```

### 改进 10：表格处理安全化

**原始问题**：原代码缺少 CSV 注入防护。

**改进方案**：公式注入防护 + 多格式兼容

```python
def safe_csv_cell(value: str) -> str:
    """CSV 公式注入防护"""
    if value and value[0] in "=+-@\t\r":
        return f"'{value}"  # 单引号前缀防公式执行
    return value

# 支持的表格输入格式
# - JSON: {"title": "...", "columns": [...], "rows": [[...]]}
# - Markdown: | A | B |\n|---|---|\n| 1 | 2 |
# - HTML: <table>...</table>（通过 Markdown 转换）
```

### 改进 11：Gallery/Volume 影像系统

**原始问题**：原代码影像路径硬编码，缺少安全边界。

**改进方案**：

**Gallery（3D 影像浏览）**：
- 配置驱动的数据集注册（dataset_id + path + modality + version + license_id）
- 按数据集→病例→切片的层级扫描
- 切片安全重编码（PNG、非诊断级标记）
- 拒绝目录遍历和符号链接逃逸
- 每数据集病例数预算、每切片字节预算

**Volume（3D 体积存储）**：
- 两种模式：`temporary`（进程内存 + TTL）vs `filesystem`（显式授权 + TTL）
- 完整的 CRUD API：upload / list / get / slice / delete
- 多格式支持：.npy / .nii.gz / .mhd
- 切片重编码为非诊断级 PNG
- TTL 自动清理机制

### 改进 12：MCP 工具接口标准化

共实现 **25+ MCP 工具**，统一接口规范：

| 工具类别 | 工具名称 | 用途 |
|----------|----------|------|
| 附件 | `describe_attachment` | 附件格式检测 |
| 附件 | `prepare_attachments` | 批量附件解析 |
| RAG | `rag_contract` | RAG 检索契约 |
| RAG | `search_rag` | 向量检索 |
| RAG | `query_rag` | 文本查询（自动选择向量/词法） |
| 表格 | `normalize_table` | 表格规范化 |
| 表格 | `safe_csv` | 安全 CSV 生成 |
| 表格 | `table_ocr_prompt` | 表格 OCR prompt |
| 表格 | `table_ocr_parse` | 表格 OCR 解析 |
| 临床 | `clinical_prompt` | 临床工作流 prompt |
| 临床 | `clinical_parse` | 临床输出解析 |
| 临床 | `clinical_contract` | 工作流契约文档 |
| 战创伤 | `trauma_prompt` | 战创伤研判 prompt |
| 影像 | `validate_volume` | Volume 元数据校验 |
| 影像 | `prepare_volume` | Volume 无状态准备 |
| 影像 | `upload_volume` | Volume 上传 |
| 影像 | `list_volumes` | Volume 列表 |
| 影像 | `get_volume` | Volume 详情 |
| 影像 | `get_volume_slice` | Volume 轴位切片 |
| 影像 | `delete_volume` | Volume 删除 |
| 影像 | `validate_gallery` | Gallery 元数据校验 |
| 影像 | `gallery_datasets` | Gallery 数据集列表 |
| 影像 | `gallery_cases` | Gallery 病例列表 |
| 影像 | `gallery_case` | Gallery 病例详情 |
| 影像 | `gallery_slice` | Gallery 切片渲染 |
| M3D | `m3d_health` | M3D 健康检查 |
| M3D | `m3d_infer` | M3D 推理 |

### 改进 13：测试覆盖翻倍

**原始状态**：原有 45 项测试。

**改进后**：扩展到 **58 项测试**（新增 13 项），全部为**无网络、无模型、无数据库**的纯单元测试。

| 测试文件 | 测试内容 | 测试数 |
|----------|----------|--------|
| `test_contracts.py` | 附件契约、RAG 契约、Embedding 安全、表格、战创伤 Prompt、影像、配置 | ~30 |
| `test_parsers.py` | 附件解析器（文本/JSON/XML/PDF/DICOM/WFDB/图像） | ~15 |
| `test_api.py` | FastAPI REST 端点 | ~8 |
| `test_artifacts_volume.py` | RAG 制品加载 + Volume 存储 | ~5 |
| `test_extended_features.py` | Gallery、Volume TTL、M3D adapter、RAG 根目录、Prompt 契约 | ~12 |

**测试设计原则**：
- 所有测试使用合成数据（synthetic data），不含真实 PHI
- M3D/Embedding 不可用时诚实返回 `unavailable`，不伪造结果
- 路径遍历、逃逸、非回环地址等安全场景均有覆盖
- FastAPI 使用 `TestClient` 进行 HTTP 层集成测试

### 改进 14：Docker 单机离线交付

**改进方案**：完整的 Docker Compose 编排

```yaml
# docker-compose.medical.yml
services:
  pilotdeck:        # TypeScript 核心服务（port 3001）
  medical-api:      # Python FastAPI sidecar（127.0.0.1:8765）
    network_mode: "service:pilotdeck"  # 共用网络命名空间
    healthcheck: ...
  medical-mcp:      # Python MCP sidecar（127.0.0.1:8766）
    network_mode: "service:pilotdeck"
    depends_on:
      medical-api:
        condition: service_healthy
```

**交付特点**：
- 三个容器共享网络命名空间，医疗端口不向外暴露
- 医疗数据和插件采用只读 bind mount
- PilotDeck 状态使用独立持久卷
- Sidecar 包含完整 formats 依赖（PyMuPDF、Pillow、pydicom、wfdb、numpy）

### 改进 15：客户差异化配置系统

**改进方案**：`customer-presets/` 目录实现无代码分支的客户差异管理

```yaml
# customer-presets/offline-military/manifest.yaml
customer:
  id: "offline-military"
  displayName: "离线战创伤交付版"

features:           # 功能开关矩阵
  dialogue: true
  medTrauma: true
  dicomPreview: true
  m3d: false        # 离线环境关闭 M3D
  feishu: false     # 离线环境关闭飞书

security:           # 安全策略
  crossSessionMemory: false
  publicWebSearch: false
  externalTelemetry: false
  requireHumanReview: true
  phiStorage: "temporary-ttl"
```

### 改进 16：Skills 与 Agent Profiles 体系

**七类医疗 Skill**：

| Skill | 用途 |
|-------|------|
| `war-trauma-assessment` | 六阶段战创伤研判 |
| `medical-general` | 通用医学对话 |
| `medical-report-interpretation` | 医学报告解读 |
| `medical-deep-search` | 医学深度检索 |
| `medicine-package-recognition` | 药品包装识别 |
| `treatment-plan` | 治疗方案制定 |
| `table-digitization` | 表格数字化 |

**四类 Agent Profile**：
- `medical-general`：通用医学助手
- `medical-report`：报告解读专家
- `medical-deep-search`：深度检索专家
- `war-trauma-assessment`：战创伤研判专家

## 2.3 代码规模统计

| 模块 | 文件数 | 代码行数（估算） | 说明 |
|------|--------|-----------------|------|
| 配置系统 | 1 | ~720 | config.py - 完整的分层配置+校验 |
| 附件解析 | 3 | ~1100 | parsers.py(900) + contracts.py + service.py |
| 临床工作流 | 1 | ~570 | workflows.py - 五类工作流 + JSON Schema |
| 战创伤 Prompt | 1 | ~270 | prompt_builder.py - 六阶段双风格 |
| MCP 工具层 | 1 | ~490 | tools.py - 25+ 工具实现 |
| REST API | 1 | ~520 | app.py - 30+ 端点 |
| RAG 系统 | 3 | ~500 | artifacts.py(350) + contracts.py + embedding.py |
| 影像系统 | 4 | ~700 | gallery.py(310) + volume.py + volume_store.py + m3d.py |
| 表格处理 | 2 | ~300 | ocr.py + contracts.py |
| MCP Server | 2 | ~250 | server.py + tools.py |
| 测试 | 6 | ~1500 | 58 项测试 |
| Skills | 7 | ~200 | 7 个 SKILL.md |
| Agent Profiles | 4 | ~100 | 4 个 Profile |
| 配置/预设/脚本 | 8 | ~300 | YAML + JSON + PowerShell |
| **合计** | **~45** | **~7500+** | 纯新增代码 |

## 2.4 改进总结：从原始代码到 Sidecar 的架构演进

```
原始架构问题                    改进后的 Sidecar 架构
─────────────────────────────────────────────────────
直接调用 LLM API          →   只构造 prompt/解析输出，标注 generation_owner
附件落盘存储              →   全内存处理，BytesIO 管道
SQLite 持久化             →   无状态 + TTL 内存存储（可选 filesystem）
绝对路径硬编码            →   data.root 锚点 + 相对路径 + 边界检查
缺少输入校验              →   递归 JSON Schema 校验 + 预算检查
缺少安全防护              →   loopback-only + PHI 过滤 + CSV 注入防护
错误静默吞没              →   显式 degraded 状态 + warnings 数组
测试依赖外部服务          →   58 项纯单元测试 + 合成数据
不可交付部署              →   Docker Compose 单机离线编排
配置分散脆弱              →   分层配置系统 + 40+ 环境变量 + 完整校验
```

---

# 第三部分：还存在哪些问题

## 3.1 PilotDeck 核心框架层面的局限

### 问题 1：医疗场景的 Memory 隔离粒度不足

**现状**：PilotDeck 的 Memory 系统按 WorkSpace 隔离，但医疗场景中同一个 WorkSpace 可能处理多个不同患者的数据。当前只能全局关闭 Memory（`memoryDefault: "disabled"`），无法实现"按患者/按病例"粒度的记忆隔离。

**影响**：如果开启 Memory，患者 A 的信息可能污染患者 B 的推理上下文。

### 问题 2：多模态模型声明依赖外部配置

**现状**：视觉模型必须在 PilotDeck 配置中**手动声明**多模态能力（`multimodal: {input: [text, image]}`），否则表格 OCR、DICOM 预览等工具会拒绝发送图片。这种声明容易被遗漏，且与实际模型能力之间没有自动校验。

**影响**：配置错误导致功能静默降级，排查困难。

### 问题 3：智能路由与医疗安全性的张力

**现状**：PilotDeck 的智能路由会在简单任务上自动降级到轻量模型以节省成本。但医疗场景中，"简单"和"安全"的边界天然模糊——一个看似简单的症状描述可能涉及危急重症。

**影响**：轻量模型可能在关键研判上准确性不足，而路由系统缺乏"医疗场景不降级"的语义理解。

### 问题 4：Always-on 模式下的医疗责任边界

**现状**：PilotDeck 支持 Always-on 后台执行，Agent 可以主动发现任务、执行操作并汇报。但医疗场景对时效性、准确性和责任追溯有严格要求。

**影响**：后台自动生成的医疗建议如果未被人类及时审核，存在合规风险。

## 3.2 Sidecar 自身的技术债务

### 问题 5：embedding 服务依赖未完全消除

**现状**：RAG 系统虽然提供了词法降级（lexical fallback），但这只是一个确定性兜底方案。BM25 级别的词法匹配与语义向量检索在效果上有显著差距。当前词法降级的评分策略较简单（token 匹配率 + 精确短语加分），对于医学同义词、概念层级等语义关系无法覆盖。

**影响**：离线/未配置 embedding 的环境下，RAG 检索质量显著下降。

### 问题 6：PDF 扫描版处理能力有限

**现状**：PDF 扫描版（无可提取文本层）被标记为 `degraded` 且 `included=False`，仅返回 1-3 页的低分辨率预览图像。OCR 能力依赖外部模型的视觉能力。

**影响**：大量历史医疗文档为扫描版 PDF，当前无法自动化提取其内容。

### 问题 7：DICOM 预览的安全策略过于保守

**现状**：只要 DICOM tag `BurnedInAnnotation` 不是明确的 "NO"，就完全阻止像素预览输出。实际临床数据中该 tag 可能缺失、不准确或标注为 "YES" 但实际不含 PHI。

**影响**：可能导致大量实际可安全预览的 DICOM 影像无法展示。

### 问题 8：M3D adapter 为预留接口

**现状**：M3D adapter 仅为 localhost 转发适配器，需要外部部署 M3D 服务。当前 `customer-presets/offline-military/manifest.yaml` 中 `m3d: false`。

**影响**：离线战创伤交付版无法使用 3D 医学影像分割等高级功能。

### 问题 9：WFDB 波形预览缺失

**现状**：WFDB 心电记录解析后只返回 metadata（导联数、采样率、样本数），不生成波形预览图像。

**影响**：用户无法在 UI 中直观查看心电波形形态。

### 问题 10：词法降级中文分词精度

**现状**：词法降级使用简单的 bigram 滑动窗口分词（如"战创伤" → ["战创", "创伤"]），未使用医学专业分词词典，也未处理同义词/缩写映射。

**影响**：中文医学查询的召回率和准确率可能不理想。

### 问题 11：测试覆盖仍有盲区

**现状**：58 项测试覆盖了契约、解析器、API 端点、RAG、Volume、Gallery、M3D 等模块，但以下场景缺少测试：
- Trauma Prompt 的 plain 模式全六阶段输出格式验证
- Gallery 多数据集边界条件（空目录、超大切片数等）
- Volume 跨 TTL 边界和并发上传
- MCP Server 的 HTTP 流式响应
- 大文件附件的内存压力测试

## 3.3 集成与交付层面的问题

### 问题 12：PilotDeck 版本耦合

**现状**：Medical Feature Pack 在 PilotDeck `0.1.0` 版本上开发，依赖其 Agent Profile 加载机制、MCP 注册机制、`PILOTDECK_MEDICAL_SIDECAR_URL` 环境变量等约定。

**影响**：PilotDeck 核心升级可能破坏医疗 Feature Pack 的兼容性。

### 问题 13：Windows 开发环境体验

**现状**：Sidecar 为 Python 3.11+ 应用，Windows 环境下需要单独管理 Python 虚拟环境和依赖。`start-dev.ps1` 脚本做了适配，但 Python 原生依赖（numpy、Pillow、pydicom）在 Windows 上的编译安装可能遇到问题。

**影响**：Windows 开发者上手成本较高。

### 问题 14：跨会话状态管理

**现状**：RAG 制品加载在进程内缓存（`_ensure_loaded` 使用 threading.Lock），Volume `temporary` 模式数据在进程重启后丢失。没有跨会话的持久化状态管理策略。

**影响**：服务重启后需要重新加载 RAG 制品（大型 embedding 矩阵加载可能耗时）。

### 问题 15：可观测性不足

**现状**：Sidecar 提供了 `/health` 和 `/capabilities` 端点，但缺少：
- 请求级别的结构化日志
- 工具调用耗时统计
- 降级事件计数
- 错误率监控

**影响**：生产环境排障依赖人工查看日志。

---

# 第四部分：下一步优化方向

## 4.1 短期优化（1-2 个月内可完成）

### 方向 1：增强词法检索的医学专业性

- 引入医学专业分词词典（如 THUOCL 医学词表、SNOMED CT 中文版）
- 建立常见医学同义词/缩写映射表
- 支持基于 MeSH 词表的查询扩展
- 评估词法降级与向量检索在不同查询类型上的效果差异

### 方向 2：完善测试覆盖

- 补充 Trauma Prompt plain 模式所有六阶段的输出格式验证
- 添加 Gallery 边界条件测试（空目录、超预算切片数、损坏图像）
- 添加 Volume TTL 边界测试（跨 TTL 访问、并发上传冲突）
- 添加大文件（接近 50MB 预算边界）附件的内存压力测试
- 目标：从 58 项扩展到 80+ 项

### 方向 3：改进 PDF 扫描版处理

- 集成 OCR 预处理流水线（在 Sidecar 中增加可选的 OCR 预处理步骤）
- 支持将扫描版 PDF 的图像层提取后交由多模态模型处理
- 增加 PDF 文本层完整性评估（区分"纯文本 PDF"、"混合 PDF"、"纯扫描 PDF"）

### 方向 4：优化 DICOM 预览策略

- 实现可配置的 BurnedInAnnotation 处理策略（strict / permissive / manual_review）
- 增加像素级的 PHI 检测提示（如检测图像四角的白色文字区域）
- 支持手动标记特定 Study/Series 为"已确认去标识"

### 方向 5：增加可观测性

- 引入结构化日志（JSON 格式，包含 request_id、tool_name、duration_ms）
- 添加 Prometheus metrics 端点：
  - `medical_tool_calls_total{tool,status}`
  - `medical_degraded_total{reason}`
  - `medical_rag_fallback_total`
  - `medical_attachment_bytes_total`
- 实现 `/v1/health` 的详细模式（`?verbose=true` 返回各子系统状态详情）

## 4.2 中期优化（3-6 个月内可完成）

### 方向 6：WFDB 心电波形可视化

- 使用 matplotlib 或 PIL 在后端生成心电波形预览图
- 支持多导联的堆叠/并列显示
- 标注关键间期（PR、QRS、QT）和异常标记
- 控制预览分辨率和大小在预算内

### 方向 7：智能路由的医疗场景适配

- 与 PilotDeck 团队协作，在 Router 中增加"医疗安全级别"标记
- 医疗场景的 MCP 工具调用后，Router 不降级模型
- 定义医疗任务的复杂度分级标准（基于涉及的人体系统数量、危急程度、药物交互风险等）

### 方向 8：患者级记忆隔离

- 设计"会话级记忆"机制：每个患者诊断会话拥有独立的短期记忆空间
- 会话结束后自动清理或归档（需人工审核后归档）
- 跨会话时明确提示"新患者，历史记忆已隔离"

### 方向 9：M3D 离线方案评估

- 调研可在离线环境中运行的 3D 医学影像分割开源模型（如 nnUNet、MONAI）
- 评估模型大小、推理速度和精度是否满足战创伤场景需求
- 如果可行，将 M3D adapter 扩展为支持本地模型推理的完整实现

### 方向 10：跨 PilotDeck 版本的兼容性保障

- 建立 medical-integration 的 CI 流水线，在 PilotDeck 新版本发布时自动运行测试
- 将 Medical Feature Pack 的接口契约文档化（OpenAPI 3.1 规范）
- 定义 Plugin API 的版本兼容性矩阵

## 4.3 长期优化（6 个月以上）

### 方向 11：医疗知识图谱集成

- 构建或接入医学知识图谱（如中文 UMLS、医学百科结构化数据）
- 在 RAG 检索中增加知识图谱增强（GraphRAG）
- 支持基于知识图谱的诊断推理链验证

### 方向 12：多模态端到端流水线

- 实现"上传 DICOM → 自动窗宽窗位调整 → 关键帧提取 → 多模态模型判读 → 结构化报告"的完整流水线
- 支持影像 + 文本 + 波形（ECG）的多模态联合推理
- 引入影像-报告对比学习以提升判读准确性

### 方向 13：PHI 自动检测与脱敏

- 集成命名实体识别（NER）模型用于自动检测文本中的 PHI
- 实现像素级的 DICOM 烧录文字检测（OCR on image corners）
- 提供"自动脱敏 → 人工审核 → 确认安全"的三阶段流水线

### 方向 14：联邦学习与隐私保护推理

- 探索在多个医疗节点间进行联邦微调的技术方案
- 实现差分隐私保护的模型推理
- 支持同态加密的医学数据检索

### 方向 15：标准化互操作性

- 实现 FHIR R4 标准的输入/输出适配器
- 支持 HL7 v2 消息解析
- 与主流 HIS/EMR 系统的集成方案设计

---

## 附录

### A. 项目文件导航

```
products/medical-integration/
├── README.md                              # 总体说明文档
├── docker-compose.medical.yml             # Docker 单机离线交付编排
├── config/
│   ├── medical.example.yaml               # 无秘密示例配置
│   ├── medical.yaml                       # 开发环境配置
│   └── pilotdeck.example.yaml             # PilotDeck 配置示例
├── plugins/medical-tools/
│   ├── plugin.json                        # 插件注册清单
│   ├── agents/                            # 4 个 Agent Profile
│   └── commands/                          # 4 个 Slash Command
├── skills/                                # 7 个医疗 Skill
├── profiles/                              # 4 个 Profile 模板
├── customer-presets/
│   ├── _template/manifest.yaml            # 客户差异模板
│   └── offline-military/manifest.yaml     # 离线战创伤交付版
├── scripts/start-dev.ps1                  # Windows 开发启动脚本
├── data/                                  # 经授权的本地数据制品
├── reference-ui/                          # 旧版 UI 基线
└── sidecar/
    ├── src/medical_sidecar/
    │   ├── config.py                      # ★ 720 行分层配置系统
    │   ├── capabilities.py                # 能力文档
    │   ├── npy.py                         # NPY 懒加载
    │   ├── api/app.py                     # ★ FastAPI 30+ 端点
    │   ├── mcp/
    │   │   ├── server.py                  # MCP HTTP Server
    │   │   └── tools.py                   # ★ 25+ MCP 工具实现
    │   ├── ingestion/
    │   │   ├── contracts.py               # 格式检测 + 安全路径
    │   │   ├── parsers.py                 # ★ 多格式附件解析器
    │   │   └── service.py                 # 批量附件处理
    │   ├── rag/
    │   │   ├── contracts.py               # 检索契约
    │   │   ├── artifacts.py               # ★ JSONL + NPY 制品加载
    │   │   └── embedding.py               # embedding 客户端
    │   ├── clinical/
    │   │   └── workflows.py               # ★ 五类临床工作流
    │   ├── trauma/
    │   │   └── prompt_builder.py           # ★ 六阶段战创伤 Prompt
    │   ├── table/
    │   │   ├── contracts.py               # 表格规范化 + CSV 安全
    │   │   └── ocr.py                     # 表格 OCR 契约
    │   └── imaging/
    │       ├── contracts.py               # 影像元数据契约
    │       ├── gallery.py                 # ★ Gallery 扫描器
    │       ├── volume.py                  # Volume 数据处理
    │       ├── volume_store.py            # Volume 存储引擎
    │       └── m3d.py                     # M3D adapter
    ├── tests/
    │   ├── test_contracts.py              # 契约测试（~30 项）
    │   ├── test_parsers.py                # 解析器测试（~15 项）
    │   ├── test_api.py                    # API 测试（~8 项）
    │   ├── test_artifacts_volume.py       # RAG + Volume 测试
    │   ├── test_extended_features.py      # Gallery + Volume + M3D 测试
    │   └── fixtures.py                    # 测试夹具
    └── sample_data/                       # 合成样例数据
```

### B. 关键技术决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| Sidecar 语言 | Python 3.11+ | 医学数据处理生态（pydicom、wfdb、numpy、Pillow）成熟 |
| Sidecar 框架 | FastAPI + MCP HTTP | 轻量、高性能、与 PilotDeck MCP 协议兼容 |
| 配置格式 | YAML + 环境变量 | 人类可读写 + 容器化部署友好 |
| 数据持久化 | TTL 内存优先 | PHI 保护最安全，降低合规风险 |
| RAG 降级 | 词法 bigram 匹配 | 零依赖、确定性、可预测行为 |
| 测试策略 | 纯单元测试（无网络/数据库/模型） | 可离线运行、快速反馈、CI 友好 |
| PHI 策略 | 默认不持久化 | 合规优先，仅在显式授权时持久化 |
| 网络安全 | loopback-only | 最小攻击面，适合单机/离线部署 |

### C. 术语对照

| 中文 | 英文 | 说明 |
|------|------|------|
| 工作舱 | WorkSpace | PilotDeck 的项目级隔离单元 |
| 边车 | Sidecar | 独立于核心框架的辅助服务 |
| 白盒记忆 | White-box Memory | 可见、可控、可追溯的记忆系统 |
| 智能路由 | Intelligent Router | 根据任务难度自动选择模型的调度器 |
| 常驻执行 | Always-on | 后台持续运行的 Agent 模式 |
| 生成所有者 | Generation Owner | 标识实际调用生成模型的组件 |
| 战创伤 | War Trauma | 战时创伤救治场景 |
| 去标识化 | De-identification | 移除患者身份信息的处理 |
| 词法降级 | Lexical Fallback | embedding 不可用时的确定性文本匹配 |
| 烧录文字 | Burned-in Annotation | DICOM 像素中嵌入的患者信息文字 |
