---
name: med-medical
description: 解析通用医学附件（包括非腹部/盆腔及非胸部的 DICOM、专用 CT 能力关闭时的完整 CT、PDF、报告截图、CDA/XML、检验文本、JSON、心电图/WFDB）。DICOM 必须先路由。
---

# 医疗多源解析（med-tools）

RADAR 和 DeepChest 由 `MED_SPECIALIZED_CT_ENABLED` 控制。关闭时不得调用
`med_radar_*` 或 `med_deepchest_*`；完整 CT 使用本 Skill 的通用医学解析。
能力开启时，其他部位的完整 CT DICOM 也直接使用本 Skill。
此时对 DICOM 可在本 Skill 下调用 `med_image_route` 和 `med_parse_medical`，
无需加载独立的路由 Skill；NIfTI 不支持通用解析，不得传给 `med_parse_medical`。

当用户提供**医疗材料**——单文件、多文件或文件夹——且包含以下任一类型时：

- 影像：`.dcm` / `.dicom` / `.ima`
- 报告 / 截图：`.pdf`、`.png` / `.jpg` / `.jpeg` / `.bmp`
- 文书：`.xml` / `.cda`、`.txt` / `.md` / `.markdown`、`.json` / `.xml1`
- 心电图：`.hea` / `.dat`、`.ecg` / `.wfdb` / `.atr` / `.qrs` / `.edf` / `.scp`

按以下步骤处理：

1. 若包含 DICOM/NIfTI，先调用 **`mcp__med-tools__med_image_route`** 并等待路由结果。只有推荐通用解析且附件格式受支持时，才调用 **`mcp__med-tools__med_parse_medical`**。纯附件解读用 **`continuation_mode: "terminal"`**；复合任务用 **`continuation_mode: "material"`**。
2. `path` 尽量传绝对路径（文件**或**目录）。
3. **不要**用 `read_file` 或自行临时解析打开这些文件——该工具在本地解析（含结构化 CDA 检验/观察项），并优先使用 `pilotdeck.yaml` 的 `medical.interpretationModel`。若医学模型不可用，工具可能在插件内回退到**已配置的主 Agent 模型**（来自 `agent.model`，除非被 `MED_VLM_FALLBACK_*` 覆盖）。
4. 工具返回 JSON 之后：
   - `terminal` 且 `report` 非空：运行时直接展示并保存完整报告，结束本轮；不要再次调用主模型转述、总结。调用前不输出报告前言。
   - `material` 且 `report` 非空：报告是内部材料，尚未展示。最终回答或文档中的影像判读保留 `report` 原文，主 Agent 只补充用户要求的综合分析或文件生成，不重复总结整份报告，不把疑似写成确诊。
   - 若 `report` 为空且 `agent_continue` 为 true：**不要停止**。使用 `summary`、`png_paths`、`warnings` 和 `vlm_error`，用**主 Agent 模型**继续医学解读，并遵循 med-tools 所要求的同一套中文结构化报告章节。须明确说明医学模型不可用，本次为主 Agent 回退解读。

对 DICOM 文件/目录或 NIfTI 文件，先单独调用 `mcp__med-tools__med_image_route`，
等待结果后再规划，不并行解析。NIfTI 的模态/部位/HU 只接受用户明确说明
或可信检查资料，不根据文件名猜测；路由要求补充信息时先询问。
仅当 DICOM 路由器推荐本 Skill 时使用 `med_parse_medical`；
NIfTI 永不使用该通用解析工具。工具返回 disabled 时不重试。

边界：战创伤**知识点问答** → `med-trauma-assist`（RAG）；**规定格式六阶段救治方案** → `med-trauma-stage-plan`（配置的医学模型，原样展示 `care_plan`）；本 Skill 专注附件解析与结构化报告。若后续还要写正式 9 段病例报告 / HTML，应改走 `med-case-report`，并对 `med_parse_medical` 使用 `continuation_mode: "material"`。

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
- 一个支持的通用文件 → 对该路径调用 `med_parse_medical`。DICOM/NIfTI 必须先完成上述路由。
- 同一轮中有多份受支持的通用医学文件（文件夹或多选）→ 若路径明显同属 `inbox/` 下的同一父目录且不含 NIfTI，优先对该父目录**调用一次** `med_parse_medical`；否则逐份选择受支持文件，不要把 NIfTI 混入批量解析。仍有路由或其他后续任务未完成时使用 material。
- 项目 Files 面板：用 `@` 提及工作区目录；含 DICOM/NIfTI 时先预检，再按推荐流程处理。

可选参数：

- `max_items`（默认 **64**，最大 **64**），用于目录批次。
- `max_frames`（默认 8），用于向 VLM 采样 DICOM / 图像。
- 仅当用户只要元数据/预览、不要模型报告时，才设 `skip_vlm: true`。
- 用 `med_tools_health` 检查主 VLM / 回退 / 依赖状态。
