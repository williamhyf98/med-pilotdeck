---
name: med-trauma-assist
description: Brief war-trauma care assistance via med-tools RAG. Use when the user asks about battlefield/trauma injury assessment or treatment using text and/or images. Main model describes first (especially for images), then calls med_trauma_rag_query for evidence, then writes an assistive care plan citing retrieved sources. Not the six-stage workflow.
---

# 战创伤综合辅助（简版 · med-tools）

适用：用户提供**战创伤相关文字和/或图片**，需要检索教材证据并给出**辅助性**救治建议。  
不适用：普通非创伤问诊；完整六阶段分环节流程（本轮不做）。

## 强制流程（方案 A）

```text
用户上传战创伤图片和/或文字
  → 主模型用多模态能力生成 1–3 句客观中文伤情描述（不诊断、不在工具内写描述）
  → 主模型调用 mcp__med-tools__med_trauma_rag_query（query=描述或用户文本）
  → 主模型基于返回的 chunks 写综合救治辅助方案，并列出参考来源
```

规则：

1. **有图无关键词**：必须先自行描述所见，再检索；**禁止**要求工具根据图片写描述。
2. **已有明确文字 query**：可直接 `med_trauma_rag_query`。
3. 工具**只返回证据**；救治方案由**主模型**撰写（`generation_owner=pilotdeck`）。
4. 区分「所见 / 用户陈述」与「检索文献」；**禁止编造**未出现在 `chunks` 中的条文。
5. 若 `mode` 为 `lexical-fallback`，在回答中简要说明检索降级。
6. 输出仅供辅助，须提示**医务人员复核**；不确定处明确写出。

## 工具

| 工具 | 用途 |
|------|------|
| `mcp__med-tools__med_trauma_rag_query` | 主检索：`query` / 可选 `top_k`(≤8) / `min_score` |
| `mcp__med-tools__med_trauma_rag_status` | 语料是否就绪、条数、维度 |
| `mcp__med-tools__med_tools_health` | 插件与 VLM / RAG 概况 |

可选：`prefer_lexical: true` 强制词法检索（调试用）。

## 建议输出结构（简版）

1. **伤情理解**（所见/陈述摘要）  
2. **处置要点**（基于检索，分条）  
3. **注意与禁忌**  
4. **参考来源**（title / section / chunk_id，可附 score）  
5. **免责声明**（辅助建议，需复核）

与 `med-medical` / `med_parse_medical` 的边界：解析 DICOM/PDF/报告出结构化报告用 `med-medical`；战创伤**救治方案辅助**走本 Skill + RAG。
