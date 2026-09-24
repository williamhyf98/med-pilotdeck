---
name: med-dicom-router
description: 根据 DICOM 元数据本地判断模态、检查部位和三维序列完整性；专用 CT 能力关闭时路由到 med-medical。
---

# DICOM 路由（med-tools）

RADAR 和 DeepChest 由 `MED_SPECIALIZED_CT_ENABLED` 控制。路由器只做本地
元数据预检；关闭时所有检查回退到 `med-medical`。

当用户上传或指向一个 DICOM 文件/目录，并希望自动判断检查类型、部位或选择医学工具时，先调用：

```text
mcp__med-tools__med_dicom_route(path=<绝对路径>, max_files=512)
```

这是本地只读预检：只读 DICOM 文件头，不解码像素、不调用 VLM、不上传 node12。读取结果中的 `warnings`、`domain_flags`、`modality`、`body_region`、`is_complete_3d_series`、`series`、`recommended_skill` 和 `recommended_tool`，不要根据文件名自行猜测部位。`domain_flags` 是后续解释限制，不等同于路由失败。

必须等待路由结果后再调用后续医学工具；不要把 `med_dicom_route` 与 `med_parse_medical` 或 `med_radar_analyze_ct` 放在同一个并行调用批次。

## 固定路由

- 先读取并返回 DICOM 元数据、模态、部位、序列完整性和警告。
- 能力关闭时，无论是否为完整 CT、腹部 CT 或胸部 CT，都使用 `med-medical`
  的 `mcp__med-tools__med_parse_medical` 做通用解析，不调用专用工具。
- 能力开启且路由器推荐专用流程时，按相应 Skill 执行；工具返回 disabled
  时不得重试，应回退到 `med-medical`。

## 与专用 Skill 的关系

路由器只选择候选，不代替专用 Skill，也不自动同时运行两个模型。仅在能力开启且用户明确要求联合分析时，分别加载 `med-deepchest-3dmedagent` 和 `med-radar-ct`，分别执行并分别报告来源、产物、分数和限制；不要把 RADAR 分数写入 DeepChest `facts_memory`。

能力开启时，用户提交完整腹部/盆腔 CT 并要求分析，即表示允许将该检查发送到已配置的 RADAR 服务；无需再次询问。用户提交其他完整 CT 并要求分析，也表示允许执行 3DMedAgent 默认的预处理和文本化 memory 流程；`--include-t1s` 发送切片图像仍需单独授权。若用户明确要求不上传或只做本地处理，则遵守该限制。

## 普通 DICOM

如果用户只是要求“解读这个 DICOM”，也必须执行上述固定路由：能力关闭时全部走 `med-medical`；开启时完整腹部/盆腔 CT 走 RADAR，其他已识别部位的完整 CT 先过 3DMedAgent，非 CT、不完整 CT 或部位不确定走 `med-medical`。专用流程完成后，由主智能体结合模型结果、域偏移提示和用户原始问题生成最终回答；不要把路由器推荐本身当作诊断结论。最终回答使用简体中文，并说明医学辅助用途和需合格医务人员复核的边界。
