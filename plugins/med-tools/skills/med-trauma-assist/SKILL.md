---
name: med-trauma-assist
description: Military-medicine textbook knowledge Q&A via med-tools RAG, including war-trauma and nuclear/chemical/biological emergency medicine concepts (e.g. 四级救治是哪四级、现场大出血怎么止血、核子平均结合能曲线、放射性污染洗消). Rewrite the retrieval query with recent dialogue context when needed, call med_trauma_rag_query, then answer with the main model; brief disposition tips OK. Do not use web_search/web_fetch for textbook figures or textbook evidence. NOT the formal five-section six-stage care plan — that is med-trauma-stage-plan.
---

# 军事医学教材 RAG 问答（med-tools）

适用：军事医学教材中的**知识/机制/要点**问答（教材检索 + 主模型作答），包括战创伤、核化生应急医学救援、放射性污染洗消、教材图示说明等。
不适用：规定格式的六阶段正式救治方案 → 用 **`med-trauma-stage-plan`**；普通非创伤问诊；医疗附件结构化解读 → **`med-medical`**。

## 流程

```text
用户提出军事医学教材知识点问题
  → 主模型结合近几轮对话，把当前用户话改写成自洽检索句（见下方「检索 query 改写」）
  → 主模型调用 mcp__med-tools__med_trauma_rag_query（query=改写后的检索句）
  → 主模型基于 chunks 作答；若有相关图片，优先按 interleave_context/display_assets 在对应文字后附图
  → 列出参考来源；标明仅供辅助、须复核
```

规则：

1. **问答优先**：回答「是什么 / 怎么做要点」，不是五段正式方案。
2. 工具**只返回证据**；作答由**主模型**完成（`generation_owner=pilotdeck`）。
3. **直接输出最终答案**：禁止展示推理过程、检索过程、query 改写过程、二次检索过程、页码确认过程，禁止输出 `<think>`、`</think>`、"Let me..."、"我再检索"、"grep"、"chunk" 等过程性内容。
4. **禁止编造**未出现在 `chunks` 中的条文；区分检索文献与模型补充。`chunk_id`、`context_chunks`、`dominant_source_corpus_id`、`source_routing`、`mode` 等字段只用于内部判断，不要展示给用户。
5. 默认短答：除非用户要求详细展开，答案控制为「1 句结论 + 3~5 条依据/要点 + 参考来源」。不要把所有命中材料逐条铺开。
6. `chunks[].image_refs`/`chunks[].assets` 是文字证据关联的全部图片附件；`chunks[].display_assets` 是本次 query 推荐展示的图片；`interleave_context` 是可交给前端渲染的文字与图片有序片段。只有用户明确要求图片/图示/图注时，才展示或说明图片；优先展示 `interleave_context` 中 `available=true` 且 `url` 非空的 image 段；若直接使用 chunk 字段，优先用 `display_assets`，不要把同页全部 `assets` 无差别堆出来。
7. 若用户要求图片且 `image_match.exact_figure_match=false`，必须说明未命中标题完全对应的原图，只能展示相关教材图；不要把相关图冒充用户点名的流程图/示意图。
8. **禁止生成替代图片或自行解析资产路径**：如果 RAG 返回了 image 段或 `display_assets`，不要用画图、写 SVG/PNG、截图、附件生成等方式重新制作图片；不要引用本地工作目录中的 `*.png/*.svg`；不要自行拼接 `/api/plugins/...` URL、不要查询本地磁盘或 manifest。只能展示 RAG 返回的 `url`，例如 `![图1-1-1 核子平均结合能曲线](/api/plugins/med-tools/rag-assets/assets/...)`。如果没有真实 `url`，只能写普通文字说明，禁止输出 `![①](①)`、`![图名]()`、`![图名](本地路径)` 这类占位图片语法。
9. **禁止联网找教材图**：教材证据、教材图示、页码来源只能来自 `med_trauma_rag_query` 返回结果；不要调用 `web_search` / `web_fetch` / Bing / Google。
10. 若 `mode` 为 `lexical-fallback`，最多一句说明检索降级；若 warnings 提示 image topic filter 移除了泛图像结果，且用户要求图片，则说明本次未找到强主题匹配图片，不要展示其他主题流程图。
11. 用户明确要「生成救治方案 / 按某阶段出方案」→ **改走 `med-trauma-stage-plan`**，不要用本 Skill 硬写五段卡。
12. **检索前必须改写 query**（见下节）；聊天气泡仍按用户原文理解与作答，不要把改写句当成用户原话展示。

### 流程/先后顺序题

用户问「先处理什么、后处理什么、流程、步骤、顺序」时，回答必须先给一句话结论，再展开依据。不要先堆材料。

若用户只问“先后关系/优先顺序”，标准输出应控制在：

```text
结论：……

依据：
1. ……
2. ……
3. ……

参考来源：……
```

不要输出“检索到哪些 chunk”“我又查了哪几次”“页码如何确认”等内部过程。

化学暴露 + 伤员转运类问题尤其要区分四个阶段：

1. 污染区/现场：施救者先自我防护；立即威胁生命的问题可由穿戴防护者先做急救稳定。
2. 洗消区：尽早洗消，皮肤优先，眼和伤口按需处理；不要把「洗消优先」写成「任何急救都必须等洗消后」。
3. 清洁区/MTF：进入清洁治疗区或使用清洁运具前，应完成必要洗消和污染验证。
4. 转运例外：稳定且不需进入清洁治疗区者，可穿戴防护服/防护面具转送，但转送前应局部清除防护装备上的明显污染。

这类问题的合格答案应明确：

- 不简单说「先治疗后洗消」；
- 不简单说「先洗消后治疗」；
- 必须说明污染区急救稳定、洗消验证、清洁区治疗/后送之间的边界；
- 来源引用要保持书名、章节、页码一致，无法确认页码时不要硬写页码；不要在最终回答里写 `chunk_id` 或「上下文」。

## 检索 query 改写（强制）

`med_trauma_rag_query` **不会**自动带历史。调用前，主模型必须自行生成一条**可独立检索**的短 query。

### 用哪些历史

只取当前会话中：

1. **最近最多 5 条用户话**（含当前这一条；更早的不要）
2. **必要的助手结论**：仅当消歧需要时，从最近助手回复中抽取与当前追问直接相关的**主题/伤情/处置要点**（一两句关键词级别即可）

不要把整段助手长文、工具返回原文、附件路径、报告全文塞进改写上下文。

### 何时必须改写

出现以下任一情况时，**禁止**把用户原句直接当 `query`：

- 指代或省略：这 / 那 / 它 / 刚才 / 上面 / 同上 / 还有呢 / 再详细点 / 禁忌呢 / 怎么用
- 当前句单独看主题不完整，但结合近 5 轮用户话能补全
- 追问上轮知识点的子问题（机制、步骤、禁忌、注意事项、时间窗等）

若当前用户话本身已是完整、可独立检索的知识点问题，可只做轻微规范化（补「战创伤」等必要领域词），不必大幅改写。

### 改写要求

- 输出**一条**中文检索句（或短关键词串），建议不超过约 **120 字**
- 以当前用户意图为主；历史只用于补全主题、部位、机制、处置名称
- 优先保留：损伤机制 / 部位 / 处置动作 / 知识点对象（如止血带、气道、四级救治）
- **禁止**写入：患者姓名、住院号、精确标识、附件绝对路径、本病例完整病历复述、报告格式偏好
- **禁止**写成对话腔（如「请帮我查一下…」）；写成教材检索用语
- 改写失败或主题仍不清时：用「当前用户原文 + 近轮能确定的主题词」做保守拼接；仍无法形成知识点 query 则先向用户确认，不要空搜

### 示例

| 近轮要点（示意） | 当前用户话 | 应传给工具的 query |
|------------------|------------|-------------------|
| 用户刚问现场大出血止血 | 「那止血带怎么用？」 | 战创伤现场大出血止血带使用方法与注意事项 |
| 上文在谈止血带 | 「禁忌呢？」 | 战创伤止血带使用禁忌 |
| 用户已写清完整问题 | 「战伤四级救治是哪四级？」 | 战伤四级救治是哪四级（可原样或轻微规范化） |

### 调用约定

```text
mcp__med-tools__med_trauma_rag_query(query=<改写后的检索句>)
```

不要把近 5 轮原文整段拼接后直接 embedding；只把**改写结果**作为 `query`。

## 工具

| 工具 | 用途 |
|------|------|
| `mcp__med-tools__med_trauma_rag_query` | 检索：`query` / 可选 `top_k`(≤8) / `min_score` |
| `mcp__med-tools__med_trauma_rag_status` | 语料是否就绪 |
| `mcp__med-tools__med_tools_health` | 插件概况 |

## 建议输出结构

1. **直接回答**  
2. **简要处置要点**（可选，非正式方案）  
3. **参考来源**（书名 / 章节 / 页码；不要展示 chunk_id 或「上下文」）
4. **免责声明**

普通知识问答不需要写“本次检索未返回图片”。只有用户明确要图时，才说明图片命中情况。

边界：正式六阶段方案 → `med-trauma-stage-plan`；DICOM/PDF 解读 → `med-medical`。
