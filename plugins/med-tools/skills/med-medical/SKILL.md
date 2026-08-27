---
name: med-medical
description: 通过 med-tools MCP 解析医疗附件（DICOM、PDF 报告、报告截图、CDA/XML、检验文本、JSON、心电图/WFDB）。优先使用本地 G9-V-Med 报告；若不可用，则以已配置的主 Agent 模型作为回退报告，或继续由主 Agent 解读。只要用户上传或指向医学影像、报告、文书、检验或心电图文件——包括混合格式的整个文件夹——就使用本技能。
---

# 医疗多源解析（med-tools）

当用户提供**医疗材料**——单文件、多文件或文件夹——且包含以下任一类型时：

- 影像：`.dcm` / `.dicom`
- 报告 / 截图：`.pdf`、`.png` / `.jpg` / `.jpeg` / `.bmp`
- 文书：`.xml` / `.cda`、`.txt` / `.md` / `.markdown`、`.json` / `.xml1`
- 心电图：`.hea` / `.dat`、`.ecg` / `.wfdb` / `.atr` / `.qrs` / `.edf` / `.scp`

按以下步骤处理：

1. 调用 **`mcp__med-tools__med_parse_medical`**（统一入口）。
2. `path` 尽量传绝对路径（文件**或**目录）。
3. **不要**用 `read_file` 或自行临时解析打开这些文件——该工具在本地解析，并优先使用本机 **G9-V-Med**（`:8030`）。若 G9 不可用，工具可能在插件内回退到**已配置的主 Agent 模型**（来自 `pilotdeck.yaml` 的 `agent.model`，除非被 `MED_VLM_FALLBACK_*` 覆盖）。
4. 工具返回 JSON 之后：
   - 若 `report` 非空：报告已由运行时**实时流式写入对话并保存为最终回答**。**不要**再粘贴或改写一遍。调用工具前不要写任何前言——前导文字会混入流式报告。（兼容行为：若流式不可用，仍应原样展示。）
   - 若 `report` 为空且 `agent_continue` 为 true：**不要停止**。使用 `summary`、`png_paths`、`warnings` 和 `vlm_error`，用**主 Agent 模型**继续医学解读，并遵循 med-tools 所要求的同一套中文结构化报告章节。须明确说明 G9 不可用，本次为主 Agent 回退解读。

边界：战创伤**知识点问答** → `med-trauma-assist`（RAG）；**规定格式六阶段救治方案** → `med-trauma-stage-plan`（G9，原样展示 `care_plan`）；本 Skill 专注附件解析与结构化报告。

## 对话附件

文件夹上传与回形针多文件上传走**同一条**附件路径：

```text
[Files attached by user and available for reading in the project:]
- name: /absolute/path/to/file
...
[Attachment diagnostics]
- File extension .xml / .dcm / ... is not in the inline text whitelist; skipped.
```

- 医疗二进制 / XML / CDA **不会**内联进对话。调用 MCP；不要对它们使用 `read_file`。
- 一个文件 → 对该路径调用 `med_parse_medical`。
- 同一轮中有多份医疗文件（文件夹或多选）→ 若路径明显同属 `inbox/` 下的同一父目录，优先对该父目录**调用一次** `med_parse_medical`；否则按文件分别调用。
- 项目 Files 面板：用 `@` 提及工作区目录，并对该目录调用一次。

可选参数：

- `max_items`（默认 **64**，最大 **64**），用于目录批次。
- `max_frames`（默认 8），用于向 VLM 采样 DICOM / 图像。
- 仅当用户只要元数据/预览、不要模型报告时，才设 `skip_vlm: true`。
- 用 `med_tools_health` 检查主 VLM / 回退 / 依赖状态。
