---
name: med-trauma-stage-plan
description: Formal six-stage war-trauma graded care plan via med_trauma_stage_plan (G9 inside plugin, main-agent-model fallback). Use when the user wants a structured care plan for one of 伤员发生地/野战分类场/收容处置组/重伤救治组/手术组/洗消组. Paste care_plan verbatim. Not for textbook Q&A (use med-trauma-assist) or attachment-only reading (use med-medical).
---

# 战创伤分阶段正式救治方案（med-tools）

适用：用户要求**生成规定格式的战创伤救治方案**，并处于（或可推断）六阶段之一。  
不适用：知识点问答 → **`med-trauma-assist`**；仅解读附件报告 → **`med-medical`**。

## 六阶段（一次仅一个）

`伤员发生地` · `野战分类场` · `收容处置组` · `重伤救治组` · `手术组` · `洗消组`

- 用户点名 → 用该阶段。  
- **未指定** → 主 Agent **自行判断**一个最贴切阶段（可一句说明理由），再调用工具。  
- **禁止**一次调用多个阶段；要换阶段就再开一轮。

## 强制流程

```text
判定 stage（仅一个）
  → 整理 injury_text（【可见伤情】）
       · 用户文字已是合格伤情述说 → 直接引用，不要无故缩短
       · 否则根据用户文本整理成规范伤情述说
       · 禁止：主 Agent 根据普通照片自行写影像所见
  → 若有 DICOM/PDF/报告类附件：先 med_parse_medical，把 report/summary 并入 injury_text
  → 普通伤情照片：把绝对路径放入 image_paths，交给工具内 G9 看图
  → 调用 mcp__med-tools__med_trauma_stage_plan(stage, injury_text, image_paths?)
  → 不强制 RAG
  → care_plan 非空 → 工具输出会直接成为最终回答；不要在调用前输出说明文字
```

## 图片必须传路径（常见失误）

用户附了伤情照片时，**必须**把路径放进 `image_paths`，否则 G9 看不到图，第一节只能写「无影像」。

- 附件路径来自对话开头的清单，形如：

```text
[Files attached by user and available for reading in the project:]
- name: /Users/xxx/.../.tmp/chat-attachments/xxxx.jpg
```

- 直接用该**绝对路径**；不要 `read_file` 图片，也不要自己写影像所见。
- 确实拿不到路径 → 先向用户要路径或让其重新上传，**不要**用 `image_paths: null` 硬跑并在伤情里写「未获得图片路径」。

## 耗时预期

G9 生成完整五段方案通常 **60–120 秒**，但正文会在 G9 生成时直接流式显示，不再等待完整结果交给主 Agent 二次回答。调用工具前不要输出前言，以免前言混入方案正文。若返回 `MCP error -32001 / Request timed out`，说明网关 MCP 超时过短（需 `PILOTDECK_MCP_TOOL_TIMEOUT_MS ≥ 300000` 并重启），向用户说明后再重试，不要改写成主模型自撰方案。

## 工具返回

| 字段 | 含义 |
|------|------|
| `care_plan` | 五段正式方案；成功时由运行时直接保存为最终回答 |
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
