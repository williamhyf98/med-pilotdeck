---
name: med-trauma-assist
description: War-trauma knowledge Q&A via med-tools RAG. Use for textbook/concept questions (e.g. 四级救治是哪四级、现场大出血怎么止血). Rewrite the retrieval query with recent dialogue context when needed, call med_trauma_rag_query, then answer with the main model; brief disposition tips OK. NOT the formal five-section six-stage care plan — that is med-trauma-stage-plan.
---

# 战创伤 RAG 问答（med-tools）

适用：战创伤**知识/机制/要点**问答（教材检索 + 主模型作答）。  
不适用：规定格式的六阶段正式救治方案 → 用 **`med-trauma-stage-plan`**；普通非创伤问诊；医疗附件结构化解读 → **`med-medical`**。

## 流程

```text
用户提出战创伤知识点问题
  → 主模型结合近几轮对话，把当前用户话改写成自洽检索句（见下方「检索 query 改写」）
  → 主模型调用 mcp__med-tools__med_trauma_rag_query（query=改写后的检索句）
  → 主模型基于 chunks 作答；可附简短处置要点
  → 列出参考来源；标明仅供辅助、须复核
```

规则：

1. **问答优先**：回答「是什么 / 怎么做要点」，不是五段正式方案。
2. 工具**只返回证据**；作答由**主模型**完成（`generation_owner=pilotdeck`）。
3. **禁止编造**未出现在 `chunks` 中的条文；区分检索文献与模型补充。
4. 若 `mode` 为 `lexical-fallback`，简要说明检索降级。
5. 用户明确要「生成救治方案 / 按某阶段出方案」→ **改走 `med-trauma-stage-plan`**，不要用本 Skill 硬写五段卡。
6. **检索前必须改写 query**（见下节）；聊天气泡仍按用户原文理解与作答，不要把改写句当成用户原话展示。

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
3. **参考来源**（title / section / chunk_id）  
4. **免责声明**

边界：正式六阶段方案 → `med-trauma-stage-plan`；DICOM/PDF 解读 → `med-medical`。
