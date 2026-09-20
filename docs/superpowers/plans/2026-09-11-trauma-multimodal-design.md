# 战创伤 Agent 多模态支持方案（v2）

> 状态：设计草稿（待确认后进入实现计划）
> 日期：2026-09-11
> 变更：v1 的「串行工位 M + 直接输出 med_parse_medical 报告」已作废。v2 改为并行工位 I + 创伤专属影像判读。

---

## 1. 现状与约束

### 1.1 战创伤路径绕过附件机制

`InProcessGateway.pump()` 中 `isTraumaProject()` 为真时走独立分支，在 `line 808` 的 `return` 处退出，从不到达 `collectRegisteredAttachmentReadFiles` / `buildAgentInputWithAttachments`（`line 836–847`）。前端上传的 `ChannelAttachment[]` 传到 `GatewaySubmitTurnInput.attachments` 后被静默丢弃。

### 1.2 modelClient 仅支持文本

`src/trauma/modelClient.ts` 的 `buildRequest()` 把 user content 固定为 `[{type:"text", text: input.user}]`。**本方案需要打开这个限制**——DICOM 预览 PNG 必须作为 image content block 送进判读模型。

该改动的可行性已实测验证，见 §9。

### 1.4 trauma 路径无多模态降级保护

`downgradeUnsupportedContent()`（把模型不支持的媒体块替换为文字占位）**只在 [RouterRuntime.ts:1138](src/router/RouterRuntime.ts#L1138) 调用**。trauma 的 modelClient 直接调 `runtime.model.complete/stream`，完全绕过该保护。工位 I 需自行做能力检查（见 §4.6）。

### 1.3 UI 没有上传入口

`TraumaComposer.tsx` 只有文本域 + `LevelRadios` + 精确录入展开区，零附件逻辑。

---

## 2. 为什么不能直接复用通用医学路径

通用医学链路是「模型自行决定调 `med_parse_medical` → G9-V-Med 生成完整报告 → 报告直接流式进气泡」。战创伤不能照搬，原因有三：

1. **报告过长**：`med_parse_medical` 的 `report` 是面向通用医学的完整结构化报告（约 800–2500 字），直接输出给用户会淹没推演主文。
2. **无 AgentLoop**：战创伤 runner 是固定 11 步流水线，没有模型自主调工具的机制，必须程序化调用。
3. **语义不对口**：通用报告不聚焦创伤救治决策，对分级救治场景信息密度低。

**可复用的部分**：`med_parse_medical` 的**本地预处理能力**——DICOM 窗宽窗位渲染、PDF 三路径文本提取、CDA 结构化解析。用 `skip_vlm=true` 只取这层产物，跳过 G9-V-Med。

---

## 3. 总体架构

新增**工位 I（interpret_attachments，影像判读）**，与 `assess_placement` / `confirm_placement` **并行**执行，产出一段紧凑的创伤导向影像判读，供 `baseline_retrieval` 和 `reasoner` 消费。

```
Step 2: validate_and_merge_form
   │
   ├─────────────── 主线 ───────────────┐
   │  Step 3: assess_placement          │
   │  Step 4: confirm_placement         │  ← 等待用户确认，天然延迟窗口
   │                                    │
   └─────────────── 支线 ───────────────┤  工位 I（并行）
      I-1: med_parse_medical            │     skip_vlm=true
           → summary + png_paths        │     continuation_mode=material
      I-2: 创伤影像判读 LLM 调用         │     local/G9-V-Med
           → interpretation 文本        │     文本 + image blocks
                                        │
   ┌────────── Promise.all 汇合 ────────┘
   │
   Step 5: baseline_retrieval   ← query 构建纳入 interpretation
   Step 6: merge_retrieval
   Step 7: reason               ← user message JSON 增加 interpretation 字段
   Step 8–11: 不变
```

**并行的临床依据**：工位 P 的定级依据是表单生命体征与叙述，不需要影像；`confirm_placement` 等待用户点击确认，这个窗口通常足以覆盖工位 I 的耗时，实际感知延迟接近零。

---

## 4. 各层详细设计

### 4.1 UI 层：TraumaComposer 上传区

**位置**：文本域下方、`LevelRadios` 上方，独立一行。未展开时只显示「+ 添加医学附件」按钮；有附件时显示文件名 chip 列表。

**上传时机**：用户点击提交时，先调 `POST /api/projects/:name/upload-attachments`（复用通用医学端点，无需改动），文件落到 `<projectRoot>/inbox/<batchId>/`，拿到绝对路径后连同表单一起提交。不在 runner 运行期间等待上传。

**校验**：复用 `medicalFolderUpload.ts` 的 `MEDICAL_ATTACHMENT_EXTENSIONS` 白名单与 `validateAttachmentBatch`（64 文件 / 64MB 单文件 / 256MB 批次）。

**状态**：附件只在当前轮有效，不进草稿 state，提交后清空。

**签名扩展**：`onSubmit(form, rawInput, extract, attachments?)`，`attachments: Array<{path: string; name: string}>`。

---

### 4.2 协议层

```
GatewaySubmitTurnInput  增加 traumaAttachments?: Array<{path: string; name: string}>
TraumaTurnInput         增加 attachments?: Array<{path: string; name: string}>
```

命名与现有 `traumaForm` / `traumaRawInput` 对齐，独立于通用路径的 `attachments: ChannelAttachment[]`，不触碰现有类型。

---

### 4.3 网关层：InProcessGateway trauma 分支

- 读取 `input.traumaAttachments`（`input.attachments` 继续丢弃）
- 传给 `runner.runTurn({ ..., attachments: input.traumaAttachments })`
- `pilotdeck-bridge.js` 增加路径校验：必须是绝对路径且位于 `projectRoot/inbox/` 下，`name` 非空

---

### 4.4 modelClient：开放 image content block

这是本方案改动风险最高的一处。

**现状**：`buildRequest()` 的 user content 写死为单个 text block。

**改动**：`StructuredModelClient` 的输入类型增加可选 `images?: Array<{path: string; mediaType: string}>` 或 `contentBlocks?: CanonicalContentBlock[]`，`buildRequest()` 在存在时构造 `[...imageBlocks, {type:"text", text}]` 的多块 content。

**兼容性**：现有调用方（extractor / placer / reasoner）不传该字段，行为完全不变。只有工位 I 使用。

**已验证**：`outputSchema` 与 image block 在 provider 适配层是互不干扰的独立代码路径（[openai/request.ts:129](src/model/providers/openai/request.ts#L129) 的 `response_format` vs [:349](src/model/providers/openai/request.ts#L349) 的 `image_url`），实测两模型均支持组合调用。详见 §9。

---

### 4.5 Gateway 工厂：parseClient

参照 RAG 客户端构建方式（[createLocalGateway.ts:668–692](src/cli/createLocalGateway.ts#L668-L692)）：

1. 从 `runtime.tools` 取 `mcp__med-tools__med_parse_medical`
2. `tool.execute(input, context)`，`permissionMode: "bypassPermissions"`
3. 固定传 `skip_vlm: true`、`continuation_mode: "material"`
4. **不注册 progress 回调**——不需要流式，也不希望 G9 报告泄漏到气泡

**skill gate 不触发**：直接调 `tool.execute` 绕过 `ToolRuntime`，与 RAG 一致。

---

### 4.6 工位 I：影像判读

**I-1 预处理**

对每个附件路径调 `parseClient`，收集：
- `summary`：本地解析的文本摘要（PDF 正文、CDA 检验项、DICOM 元数据）
- `png_paths`：DICOM / PDF 渲染出的预览 PNG 路径

**I-2 判读生成**

**模型选择：`local/G9-V-Med`**，而非其余工位统一使用的 `runtime.snapshot.config.agent.model`（当前为 `qwen/Qwen3.8-27B`）。

理由：G9-V-Med 是 [pilotdeck.yaml:45](.pilotdeck-home/pilotdeck.yaml#L45) 中已配置的医学微调 VLM（基座 qwen3.6-27B，8030 端口），影像判读正是其专长。这样既用上了 med_parse_medical 背后同一个模型的能力，又由我们自己控制 prompt 与输出长度，避开那份冗长的通用报告。

实现上 `createTraumaRunner` 需构建第二个 `StructuredModelClient` 实例（`provider: "local"`, `model: "G9-V-Med"`），与主 `model` 并存。该 provider/model 若在配置中不存在，工位 I 回退到主 agent 模型。

**调用输入**：

- 所有附件的 `summary` 文本（按文件名分节）
- 所有 `png_paths` 对应的图像 block（受 `maxImagesPerRequest: 8` 约束，超出时按附件顺序截断并在判读中注明）
- 当前 `candidate` 状态的伤情摘要（提供创伤语境，让判读聚焦相关发现）

**输出**：一段结构化的中文影像判读，按附件分条，每条包含关键发现 + 创伤相关性判断。目标长度数百字量级，通过 prompt 显式约束。

**能力检查**：调用前查 `runtime.model.getMultimodal(provider, model).input.includes("image")`。不支持时跳过图像块，降级为纯文本判读（仅基于 `summary`）。这是 §1.4 所述无自动降级保护的补偿措施。

**降级规则**

- ECG 类格式（`.ecg/.edf/.atr/.qrs/.scp`）本地解析多为 placeholder，`skip_vlm=true` 时基本返回空。这类文件在判读中注明「心电数据未做波形识别」，不阻断
- 单个附件解析失败：跳过该文件，其余继续
- 整个工位 I 失败（模型超时、全部附件损坏）：`interpretation` 置空，**主线继续**，在最终响应中标注「附件解析失败」

---

### 4.7 下游消费

**baseline_retrieval**：`interpretation` 参与 query 构建。`queryPlan.ts` 的输入增加该字段，让检索 query 能覆盖影像发现的解剖部位与损伤类型。

**reasoner**：user message JSON 增加 `attachmentInterpretation` 键，与 `promptChunks` 并列。系统 prompt 增加说明段落，明确区分「用户填报的伤情叙述」与「系统生成的影像判读」，并要求后者的结论需在答案中标注来源。

---

### 4.8 跨轮累积

`CaseState` 新增 `attachmentInterpretations?: InterpretationEntry[]`：

```
InterpretationEntry = {
  id: string
  round: number
  createdAt: string
  fileNames: string[]
  text: string
}
```

工位 I 产出后 append 进该数组，随快照持久化。

**`reasoner` 默认取全部条目**，不做条数截断。理由：判读天然稀疏（并非每轮都有附件），单条数百字量级，正常会话的累计量远低于上下文压力线；而既往影像是纵向对比的基准（「与上轮 CT 相比积液增多」），按条数截断可能恰好丢掉最早的基线影像——那往往是最有价值的一条。

**字符预算兜底**：仅当累计字符数超过 `MAX_INTERPRETATION_CHARS = 60000` 时才裁剪，策略为**保留最早一条 + 从最新往前尽可能多条**，丢弃中间段，并在拼接文本中注明「已省略第 X–Y 轮影像判读」。

预算取值依据：模型上下文 131072 tokens，`maxOutputTokens` 16384，可用输入约 114k tokens；system prompt + `compactCaseStateForDownstream()` 输出 + RAG `promptChunks` 合计按 30k tokens 估算；中文近似 1 char/token。60000 字符在此之下仍留有充裕余量，同时意味着需累计约 100–200 轮带附件的判读才会触发裁剪——正常会话不可能到达，该分支实际是防溢出的硬故障保险，而非常规路径。

之所以用字符预算而非条数上限：条数截断会在正常使用中误伤基线影像，而字符预算在正常量级下完全不生效，只在极端长会话时兜底，且降级时优先保住「基线 + 近况」两端。溢出若真发生，报错形态是 reasoner 这一步的模型调用 400，排查不直观，值得提前防住。

`compactCaseStateForDownstream()` 需要相应处理该字段的裁剪。

---

### 4.9 输出呈现

判读文本先于推演主文流式推送到**同一条 assistant 消息**，中间隔着 `baseline_retrieval` / `merge_retrieval` 的进度条。两段都走现有 `onAssistantTextDelta` 通道，**前端零改动**。

---

## 5. 步骤编号与进度上报

并行结构让当前「线性 step N / 总 11 步」的进度模型不再准确。**采用方案 A**：

工位 I 不占主线编号，通过 `onProgress` 发独立事件 `{kind: "attachment_interpretation", status}`，前端在进度区单独显示一行。主线步骤总数保持 11，`RUNNER_STEP_LABELS` 不动。

前端需增加一个事件类型的处理（改动很小）。

（已否决的方案 B：把工位 I 计入总数变 12——并行执行会导致进度条跳跃或回退，体验更差。）

---

## 6. 对现有功能的影响边界

- **无附件轮次**：`attachments` 为空时工位 I 不启动，11 步行为完全不变
- **partial 分支**（级别待确认）：主线在 step 4 后进入 partial 分支时，工位 I 可能仍在运行——需要 abort 该支线，不产出判读，不写入 `CaseState`
- **RAG 客户端**：`createMcpTraumaRagClient` 不受影响，`parseClient` 为新增独立客户端
- **modelClient 现有调用方**：不传新字段即行为不变
- **abortSignal**：工位 I 必须响应 `input.abortSignal`，用户中止时两条支线同时取消

---

## 7. 实现风险

**中**：并行分支的 abort 与错误传播 —— 主线 partial 分支提前返回时，支线必须正确取消，避免向已结束的轮次写入状态。这是本方案剩余的主要风险点。

**低**：`modelClient` 的 image block 支持（已实测验证，见 §9）、进度事件的前端处理、UI 上传区、协议字段透传、第二个 `StructuredModelClient` 实例的构建。

---

## 8. 待确认

无。设计决策已全部确认，可进入实现计划。

---

## 9. Provider 能力验证结果

针对 §4.4 的 image + structured output 组合，已对配置中的两个模型做实测（2026-09-11，测试图为 64×64 红底白竖矩形 PNG）：

| 模型 | text+schema | image only | **image+schema** |
|---|---|---|---|
| `qwen/Qwen3.8-27B`（主 agent 模型） | ✅ | ✅ | ✅ 返回合法 JSON，正确识别图像内容 |
| `local/G9-V-Med`（工位 I 使用） | ✅ | ✅ | ✅ 返回合法中文 JSON，正确识别图像内容 |

**结论**：`modelClient` 开放 image block 安全可行，工位 I 无需为规避 schema 冲突而单开非结构化 purpose。

**支撑证据**：

- `CanonicalImageBlock` 已在 [canonical.ts:34](src/model/protocol/canonical.ts#L34) 定义
- [openai/request.ts:129](src/model/providers/openai/request.ts#L129) 的 `outputSchema` → `response_format` 与 [:349](src/model/providers/openai/request.ts#L349) 的 image → `image_url` 为互不干扰的独立代码路径
- 配置中两模型均声明 `multimodal.input: [text, image]`、`maxImagesPerRequest: 8`、支持 PNG

**附带观察**：G9-V-Med 在非 schema 模式下会泄漏 `</think>` 标记；schema 模式下输出干净。工位 I 使用 schema 模式，不受影响。
