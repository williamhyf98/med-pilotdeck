---
name: med-trauma-assist
description: War-trauma knowledge Q&A via med-tools RAG. Use for textbook/concept questions (e.g. 四级救治是哪四级、现场大出血怎么止血). Retrieve with med_trauma_rag_query, then answer with the main model; brief disposition tips OK. NOT the formal five-section six-stage care plan — that is med-trauma-stage-plan.
---

# 战创伤 RAG 问答（med-tools）

适用：战创伤**知识/机制/要点**问答（教材检索 + 主模型作答）。  
不适用：规定格式的六阶段正式救治方案 → 用 **`med-trauma-stage-plan`**；普通非创伤问诊；医疗附件结构化解读 → **`med-medical`**。

## 流程

```text
用户提出战创伤知识点问题
  → 主模型调用 mcp__med-tools__med_trauma_rag_query（query=问题或关键词）
  → 主模型基于 chunks 作答；可附简短处置要点
  → 列出参考来源；标明仅供辅助、须复核
```

规则：

1. **问答优先**：回答「是什么 / 怎么做要点」，不是五段正式方案。
2. 工具**只返回证据**；作答由**主模型**完成（`generation_owner=pilotdeck`）。
3. **禁止编造**未出现在 `chunks` 中的条文；区分检索文献与模型补充。
4. 若 `mode` 为 `lexical-fallback`，简要说明检索降级。
5. 用户明确要「生成救治方案 / 按某阶段出方案」→ **改走 `med-trauma-stage-plan`**，不要用本 Skill 硬写五段卡。

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
