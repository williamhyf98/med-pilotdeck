---
name: med-trauma-stage-plan
description: 通过 med_trauma_stage_plan 生成正式六阶段战创伤分级救治方案（插件内 G9，主 Agent 模型回退）。当用户需要针对伤员发生地/野战分类场/收容处置组/重伤救治组/手术组/洗消组之一给出结构化救治方案时使用。用户未点名阶段时必须先 ask_user_question，禁止自行猜测。原样粘贴 care_plan。不用于教材问答（用 med-trauma-assist），也不用于仅解读附件（用 med-medical）。
---

# 战创伤分阶段正式救治方案（med-tools）

适用：用户要求**生成规定格式的战创伤救治方案**，且阶段已由用户点名或经 `ask_user_question` 选定。  
不适用：知识点问答 → **`med-trauma-assist`**；仅解读附件报告 → **`med-medical`**。

## 六阶段（一次仅一个）

`伤员发生地` · `野战分类场` · `收容处置组` · `重伤救治组` · `手术组` · `洗消组`

- 用户在本轮或近几轮已明确点名其中一个 → 用该阶段，**不要再问**。  
- **未指定或无法唯一对应** → **禁止自行猜测**。必须先调用 `ask_user_question`，拿到唯一阶段后再调 `med_trauma_stage_plan`。  
- **禁止**一次调用多个阶段；要换阶段就再开一轮。  
- 不要用普通聊天句子代替 `ask_user_question`（用户应看到选项卡片）。

### 未指定阶段时怎么问

一次 `ask_user_question` 列出全部六个阶段（每题最多 8 个选项，不必拆成两问）。`header` 用短标签（≤12 字），例如 `救治阶段`。`multiSelect` 必须为 false。选项 `label` 用阶段全名，与工具参数 `stage` 一致：

1. 伤员发生地  
2. 野战分类场  
3. 收容处置组  
4. 重伤救治组  
5. 手术组  
6. 洗消组  

在用户回答之前，**不要**调用 `med_trauma_stage_plan`，也不要先写方案正文。

`questions` **必须是 JSON 数组**，不要把数组再包成字符串。正确示例：

```json
{
  "questions": [
    {
      "header": "救治阶段",
      "question": "您希望按战创伤分级救治的哪个阶段生成正式救治方案？",
      "multiSelect": false,
      "options": [
        { "label": "伤员发生地", "description": "现场急救阶段" },
        { "label": "野战分类场", "description": "前沿检伤分类与紧急处置" },
        { "label": "收容处置组", "description": "紧急救治阶段" },
        { "label": "重伤救治组", "description": "早期治疗阶段" },
        { "label": "手术组", "description": "专科手术治疗" },
        { "label": "洗消组", "description": "洗消与防护处置" }
      ]
    }
  ]
}
```

错误示例（不要这样）：`"questions": "[{...}]"`。

## 强制流程

```text
判定 stage（仅一个：用户点名，或 ask_user_question 的答案）
  → 整理 injury_text（【可见伤情】）
       · 用户文字已是合格伤情述说 → 直接引用，不要无故缩短
       · 否则根据用户文本整理成规范伤情述说
       · 禁止：主 Agent 根据普通照片自行写影像所见
  → 若有 DICOM/PDF/报告类附件：先 med_parse_medical，把 report/summary 并入 injury_text
  → 普通伤情照片：把绝对路径放入 image_paths，交给工具内 G9 看图
  → 调用 mcp__med-tools__med_trauma_stage_plan(stage, injury_text, image_paths?)
  → 不强制 RAG
  → care_plan 非空 → 方案会在界面流式展示，**本轮不结束**。不要复述或改写全文。
       · 用户还要求 Word/PDF 等导出 → 立刻 `read_skill` 对应文档技能并生成文件
       · 仅要求方案 → 不再调用其它工具，用一两句说明方案已生成即可
```

## 图片必须传路径（常见失误）

用户附了伤情照片时，**必须**把路径放进 `image_paths`，否则 G9 看不到图，第一节只能写「无影像」。

- 附件路径来自**当前或更早轮次**用户消息里的清单（后续轮次可能不再重复打印，路径仍然有效），形如：

```text
[Files attached by user and available for reading in the project:]
- name: /Users/xxx/.../.tmp/chat-attachments/xxxx.jpg
```

- 直接用该**绝对路径**；不要 `read_file` 图片，也不要自己写影像所见。
- 确实拿不到路径 → 先向用户要路径或让其重新上传，**不要**用 `image_paths: null` 硬跑并在伤情里写「未获得图片路径」。

## 耗时预期

G9 生成完整五段方案通常 **60–120 秒**，正文会在 G9 生成时直接流式显示。调用工具前不要输出前言，以免前言混入方案正文。方案出来后若用户还要求 Word/PDF，继续走文档技能，不要把本轮当成已经结束。若返回 `MCP error -32001 / Request timed out`，说明网关 MCP 超时过短（需 `PILOTDECK_MCP_TOOL_TIMEOUT_MS ≥ 300000` 并重启），向用户说明后再重试，不要改写成主模型自撰方案。

## 工具返回

| 字段 | 含义 |
|------|------|
| `care_plan` | 五段正式方案；界面流式展示。本轮仍可继续导出 Word/PDF |
| `fallback_used` | 是否走了插件内主 Agent 模型回退 |
| `agent_continue` | 双失败时为 true，主 Agent 按五段格式补写并说明失败 |

五段输出（由工具内 prompt 约束，勿改写）：

1. 图像/影像判读  
2. 本阶段处置措施  
3. 伤情特异处置  
4. 分类、伤标、后送/分流和交接记录  
5. 安全禁忌和不得遗漏事项  

## 与其它 Skill

| 意图 | Skill |
|------|------|
| 「四级是哪四级」「怎么止血」 | `med-trauma-assist` + RAG |
| 「按伤员发生地出救治方案」 | **本 Skill** |
| 「这张 CT/这份 PDF 是什么」 | `med-medical`；若还要正式方案，parse 后再走本 Skill |
