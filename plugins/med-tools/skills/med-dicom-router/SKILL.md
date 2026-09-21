---
name: med-dicom-router
description: 根据 DICOM 元数据本地判断模态、检查部位和三维序列完整性；完整腹部/盆腔 CT 路由到 RADAR，其他已识别部位的完整 CT 路由到 3DMedAgent，非 CT 或不完整 CT 路由到 med-medical。
---

# DICOM 路由（med-tools）

当用户上传或指向一个 DICOM 文件/目录，并希望自动判断检查类型、部位或选择医学工具时，先调用：

```text
mcp__med-tools__med_dicom_route(path=<绝对路径>, max_files=512)
```

这是本地只读预检：只读 DICOM 文件头，不解码像素、不调用 VLM、不上传 node12。读取结果中的 `warnings`、`domain_flags`、`modality`、`body_region`、`is_complete_3d_series`、`series`、`recommended_skill` 和 `recommended_tool`，不要根据文件名自行猜测部位。`domain_flags` 是后续解释限制，不等同于路由失败。

必须等待路由结果后再调用后续医学工具；不要把 `med_dicom_route` 与 `med_parse_medical` 或 `med_radar_analyze_ct` 放在同一个并行调用批次。

## 固定路由

- `modality` 不是单一 `CT`（例如 MR、PET、US、DX、未知或 MIXED）→ 使用 `med-medical` 的 `mcp__med-tools__med_parse_medical` 做通用解析；不得调用 RADAR 或 DeepChest。
- 单一 CT、`is_complete_3d_series=true`，且部位不是 `abdomen`、`pelvis`、`abdomen_pelvis`、`unknown` 或 `mixed` → 必须先进入 `med-deepchest-3dmedagent`。胸部 CT 执行完整 DeepChest/CT-CLIP/3DMedAgent 流程；头颈、脊柱、四肢等部位先执行兼容性检查，若缺少受支持器官、mask 或 CT-CLIP 证据则在该 Skill 内明确降级，不得伪造 3D 结果。
- 单一 CT、部位为 `abdomen`、`pelvis` 或 `abdomen_pelvis`、且 `is_complete_3d_series=true` → 必须加载 `med-radar-ct` 并调用 `mcp__med-tools__med_radar_analyze_ct`。不要用 `med_parse_medical` 替代 RADAR。完整三维输入既可以是同一序列的 DICOM 目录，也可以是 `NumberOfFrames >= 3` 的单个多帧 CT DICOM；后者由 RADAR 服务转换为临时 NIfTI 后推理。RADAR 主要面向增强腹部 CT；`contrast_hint=unknown/noncontrast` 只影响结果解释，不阻止调用，必须在回答中标注域外或阶段未知。
- `is_complete_3d_series=false`、部位为 `unknown/mixed`、多个检查混在目录中，或路由有警告 → 回退 `med-medical`，并说明需要用户确认；不要为了“自动化”硬猜专科模型。

## 与专用 Skill 的关系

路由器只选择候选，不代替专用 Skill，也不自动同时运行两个模型。用户明确要求联合分析时，分别加载 `med-deepchest-3dmedagent` 和 `med-radar-ct`，分别执行并分别报告来源、产物、分数和限制；不要把 RADAR 分数写入 DeepChest `facts_memory`。

在当前部署中，用户提交完整腹部/盆腔 CT 并要求分析，即表示允许将该检查发送到已配置的 node12 RADAR 服务；无需再次询问。用户提交其他完整 CT 并要求分析，也表示允许执行 3DMedAgent 默认的本地预处理和文本化 memory 流程；`--include-t1s` 发送切片图像仍需单独授权。若用户明确要求不上传或只做本地处理，则遵守该限制。

## 普通 DICOM

如果用户只是要求“解读这个 DICOM”，也必须执行上述固定路由：完整腹部/盆腔 CT 走 RADAR，其他已识别部位的完整 CT 先过 3DMedAgent，非 CT、不完整 CT 或部位不确定才走 `med-medical`。专用流程完成后，由主智能体结合模型结果、域偏移提示和用户原始问题生成最终回答；不要把路由器推荐本身当作诊断结论。最终回答使用简体中文，并说明医学辅助用途和需合格医务人员复核的边界。
