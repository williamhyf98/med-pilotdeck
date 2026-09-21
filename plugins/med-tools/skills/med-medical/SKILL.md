---
name: med-medical
description: 解析通用医学附件（非 CT DICOM、非完整三维 CT、部位未知的 CT、PDF、报告截图、CDA/XML、检验文本、JSON、心电图/WFDB）。DICOM 必须先路由；完整腹部/盆腔 CT 用 RADAR，其他已识别部位的完整 CT 先过 3DMedAgent。
---

# 医疗多源解析（med-tools）

当用户提供**医疗材料**——单文件、多文件或文件夹——且包含以下任一类型时：

- 影像：`.dcm` / `.dicom`
- 报告 / 截图：`.pdf`、`.png` / `.jpg` / `.jpeg` / `.bmp`
- 文书：`.xml` / `.cda`、`.txt` / `.md` / `.markdown`、`.json` / `.xml1`
- 心电图：`.hea` / `.dat`、`.ecg` / `.wfdb` / `.atr` / `.qrs` / `.edf` / `.scp`

按以下步骤处理：

1. 调用 **`mcp__med-tools__med_parse_medical`**（统一入口）。纯附件解读用 **`continuation_mode: "terminal"`**；还需结合病史综合分析、生成文件等复合任务用 **`continuation_mode: "material"`**。
2. `path` 尽量传绝对路径（文件**或**目录）。
3. **不要**用 `read_file` 或自行临时解析打开这些文件——该工具在本地解析（含结构化 CDA 检验/观察项），并优先使用本机 **G9-V-Med**（`:8030`）。若 G9 不可用，工具可能在插件内回退到**已配置的主 Agent 模型**（来自 `pilotdeck.yaml` 的 `agent.model`，除非被 `MED_VLM_FALLBACK_*` 覆盖）。
4. 工具返回 JSON 之后：
   - `terminal` 且 `report` 非空：运行时直接展示并保存完整报告，结束本轮；不要再次调用主模型转述、总结。调用前不输出报告前言。
   - `material` 且 `report` 非空：报告是内部材料，尚未展示。最终回答或文档中的影像判读保留 `report` 原文，主 Agent 只补充用户要求的综合分析或文件生成，不重复总结整份报告，不把疑似写成确诊。
   - 若 `report` 为空且 `agent_continue` 为 true：**不要停止**。使用 `summary`、`png_paths`、`warnings` 和 `vlm_error`，用**主 Agent 模型**继续医学解读，并遵循 med-tools 所要求的同一套中文结构化报告章节。须明确说明 G9 不可用，本次为主 Agent 回退解读。

对 DICOM 文件或目录，先单独调用轻量的 `mcp__med-tools__med_dicom_route`，等待其完成后再规划；不得把路由和解析并行执行。若结果是完整腹部/盆腔 CT，加载 `med-radar-ct` 并调用 RADAR；其他已识别部位的完整 CT 先加载 `med-deepchest-3dmedagent`。只有非 CT、单张/不完整 CT、混合目录、部位不确定，或 3DMedAgent 明确报告兼容性降级时，才继续使用本 Skill。

边界：战创伤**知识点问答** → `med-trauma-assist`（RAG）；**规定格式六阶段救治方案** → `med-trauma-stage-plan`（G9，原样展示 `care_plan`）；本 Skill 专注附件解析与结构化报告。若后续还要写正式 9 段病例报告 / HTML，应改走 `med-case-report`，并对 `med_parse_medical` 使用 `continuation_mode: "material"`。

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
- 一个文件 → 对该路径调用 `med_parse_medical`。DICOM 必须先完成上述路由。
- 同一轮中有多份医疗文件（文件夹或多选）→ 若路径明显同属 `inbox/` 下的同一父目录，优先对该父目录**调用一次** `med_parse_medical`；否则同批调用全部待解析文件，不分多轮 terminal 调用，以免首份报告提前结束本轮。仍有路由或其他后续任务未完成时使用 material。
- 项目 Files 面板：用 `@` 提及工作区目录，并对该目录调用一次。

可选参数：

- `max_items`（默认 **64**，最大 **64**），用于目录批次。
- `max_frames`（默认 8），用于向 VLM 采样 DICOM / 图像。
- 仅当用户只要元数据/预览、不要模型报告时，才设 `skip_vlm: true`。
- 用 `med_tools_health` 检查主 VLM / 回退 / 依赖状态。
