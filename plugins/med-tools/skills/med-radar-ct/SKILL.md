---
name: med-radar-ct
description: 使用部署在 node12 的 DAMO RADAR 模型分析 node36 上的完整腹部/盆腔三维 CT（NIfTI、单个多帧 CT DICOM 或 DICOM 序列），输出器官感知的异常评分和可复核 CSV。DICOM 路由确认完整腹部/盆腔 CT 后自动使用，也用于用户明确要求 RADAR、146 项 finding 或器官异常评分的场景。
---

# RADAR 腹部 CT 分析

RADAR 主要在增强腹部 CT 上训练。通过 `mcp__med-tools__med_radar_analyze_ct` 将 node36 输入安全上传到 node12 常驻 GPU 服务；工具返回结构化分数，最终医学解释由主 Agent 完成。

在当前部署中，用户上传完整腹部/盆腔 CT 并要求分析即授权使用已配置的 node12 RADAR 服务；无需再次询问。用户明确要求不上传或只做本地处理时不得调用 RADAR。

## 强制流程

1. 确认输入是完整三维 CT：`.nii` / `.nii.gz` 文件、`NumberOfFrames >= 3` 的单个多帧 CT DICOM，或包含同一 CT 序列的 DICOM 目录。单张截图、照片或孤立 DICOM 帧不适用。多帧 DICOM 会在 node12 本地转换为临时 `.nii.gz`，再进入与原生 NIfTI 相同的 RADAR 预处理和几何校验。
2. 只从用户描述或本轮已知上下文确定检查部位和增强期；把简短结论传给 `study_context`，例如 `contrast-enhanced abdominal CT`。无法确认时传空字符串，不要猜。需要另行解读 DICOM 元数据时，先加载 `med-medical` 再调用 `med_parse_medical`。
3. 首次使用或工具报告不可用时，调用 `mcp__med-tools__med_radar_status(validate_runtime=true)` 检查 node12 服务、常驻模型和 CUDA 状态。
4. 调用 `mcp__med-tools__med_radar_analyze_ct`：
   - `path` 尽量传绝对路径。
   - `top_k` 默认 15，只有用户要求更长清单时才提高。
   - `threshold` 默认 0.5；这是展示阈值，不是诊断阈值。
   - 目录包含多个检查时用 `max_cases` 限制本轮数量，默认最多 4，绝不要超过 8。
5. 使用返回的 `cases[].findings_at_or_above_threshold`、`top_scores`、`missing_scores`、`domain_flags` 和 `warnings` 作答，并给出 `artifacts.scores_csv` 路径供复核。

## 回答用户问题

- RADAR 工具返回后必须继续由主智能体回答，不要把原始 JSON 当作最终回答，也不要只说“分析已完成”。
- 最终回答必须从简体中文医学结论直接开始。不要输出思考过程、作答计划、自我指令、工具完成播报或任何过渡语；尤其不要出现 `RADAR analysis completed`、`Let me summarize`、`Let me structure` 等元叙述。工具阶段进度由界面单独展示，不得混入最终回答。
- 先回答用户的原始问题，再补充与问题直接相关的 RADAR 高分信号、限制和复核建议。
- 用户只是泛化地要求“解读/分析”时，再使用下方默认四段结构。
- RADAR 不提供可靠的病灶位置、大小或形态。用户问题超出评分能力时，明确说明不能仅凭 RADAR 回答；不要依据 finding 名称编造影像细节。
- 若同一轮还需要通用影像解读，需加载 `med-medical` 并以 `continuation_mode="material"` 调用 `med_parse_medical`，随后将 G9 影像描述与 RADAR 分数分来源综合，不得把二者混写成同一种证据。

## 解释规则

- 把数值称为“RADAR 分数”或“模型信号”，不要称为概率、置信概率或确诊结果。
- 高分项只能写“模型提示/需重点复核”；必须建议结合原始影像、增强期、病史和放射科医师判断。
- 低分不能证明排除疾病；不得据此写“未见”或“阴性”。
- `missing_scores` 表示该项没有有效输出，常见原因是相应器官未被完整覆盖；不要擅自补零。
- `domain_flags` 非空时必须明确说明域偏移。胸部、头颈、四肢或非增强 CT 不能按腹部增强域精度解释。
- 不根据 finding 名称推断病灶位置、大小或影像征象；RADAR 当前输出是病例级评分，不是病灶定位证据。
- 结果仅用于辅助分析/科研验证，不替代临床诊断。发现可能危急的高分项时，建议尽快由放射科/临床团队复核，不自行给治疗结论。

## 默认输出结构

1. **适用性与质量提示**：检查部位、增强期、`domain_flags`、缺失项。
2. **重点复核项**：按分数降序列出 finding 与分数，避免重复扩写。
3. **原始产物**：给出 CSV/JSON 路径。
4. **结论边界**：说明分数未校准、需阅片和临床复核。

若工具失败，原样概括 `error` 与缺失检查项，不得编造 RADAR 输出。用户仍需要常规医学附件解读时，加载 `med-medical` 并改用 `med_parse_medical`；必须清楚标注那不是 RADAR 结果。
