---
name: med-dicom-router
description: 医学影像本地预检：DICOM 读取元数据，NIfTI (.nii/.nii.gz) 校验三维文件头并依据明确检查信息推荐 RADAR 或 DeepChest。
---

# 医学影像路由（med-tools）

RADAR 和 DeepChest 由 `MED_SPECIALIZED_CT_ENABLED` 控制。路由器只做本地
元数据预检，不读取整个三维体数据；关闭时 DICOM 可使用 `med-medical`，
但 NIfTI 不受通用解析器支持，不可回退到 `med_parse_medical`。

当用户上传 DICOM 文件/目录或 NIfTI 文件，需要选择医学工具时，先调用：

```text
mcp__med-tools__med_image_route(path=<绝对路径>, max_files=512,
  modality=<用户明确确认的模态>, body_region=<用户明确确认的部位>,
  intensity_units=<用户明确确认的单位>,
  requested_model=<用户明确指定的模型>)
```

所有上下文参数可省略；只传已由用户或可信检查资料确认的值，不从文件名猜测
模态、部位、HU 或增强期。NIfTI 文件头不能证明模态或 HU。
`requested_model` 仅在用户明确点名 RADAR/DeepChest 时传入。
这是本地只读预检：DICOM 只读文件头，NIfTI 检查三维形状与基本几何，
不能据此断言整套 CT 检查完整；
不调用 VLM，不上传远程服务。读取 `required_context`、`warnings`、
`domain_flags`、`recommended_skill` 和 `recommended_tool` 后执行下一步。
当 `recommended_tool` 为 null 时，先获取缺失信息或说明不支持，不调用通用解析器碰运气。

必须等待路由结果后再调用后续医学工具；不要把路由与解析或推理并行执行。

## 固定路由

- 先读取并返回 DICOM 元数据、模态、部位、序列完整性和警告。
- DICOM 保留模态、部位、序列完整性判断；能力开启时仅完整腹部/盆腔 CT
  推荐 RADAR，完整胸部 CT 推荐 DeepChest；其他 DICOM（包括完整头颈、
  脊柱、四肢 CT）直接加载 `med-medical` 并调用 `med_parse_medical`。
  能力关闭时所有 DICOM 都使用通用解析。
- NIfTI 三维文件须先确认是 CT；腹部/盆腔 CT 自动推荐 RADAR。
  胸部 CT 还须确认体素单位是 HU，之后才能推荐 DeepChest。
  用户明确指定 RADAR 时，在确认 CT 后可以调用；部位或增强期未知时必须
  说明域偏移，不得称为腹部增强域内结果。明确指定 DeepChest 也不能绕过胸部/HU 条件。
- DICOM 即使用户明确指定 RADAR，也仅完整腹部/盆腔 CT 推荐 RADAR；
  胸部完整 CT 仍推荐 DeepChest，其他部位、混合部位、非 CT 和不完整
  序列仍走通用解析，并提示用户指定的模型不适用。
  明确点名 DeepChest 但 DICOM 不符合完整胸部 CT 条件时，仍推荐通用解析，
  同时提示专用模型不适用。
- NIfTI 无效、信息不足、多个影像混用或能力关闭时，不推荐
  `med_parse_medical`；按照 `required_context` 询问或明确说明无法处理。
- 能力开启且路由器推荐专用流程时，按相应 Skill 执行；工具返回 disabled
  时不得重试。只有 DICOM 或其他通用解析器支持的格式才可回退到 `med-medical`。

## 与专用 Skill 的关系

路由器只选择候选，不代替专用 Skill，也不自动同时运行两个模型。仅在能力开启且用户明确要求联合分析时，分别加载 `med-deepchest-3dmedagent` 和 `med-radar-ct`，分别执行并分别报告来源、产物、分数和限制；不要把 RADAR 分数写入 DeepChest `facts_memory`。

能力开启时，用户提交完整腹部/盆腔 CT 并要求分析，即表示允许将该检查发送到已配置的 RADAR 服务；无需再次询问。完整胸部 CT 可进入 DeepChest 流程；`--include-t1s` 发送切片图像仍需单独授权。其他部位 DICOM 使用通用解析。若用户明确要求不上传或只做本地处理，则遵守该限制。

## 普通 DICOM

对 DICOM 按原有规则分流；对 NIfTI 不要从文件名推断部位或调用 DICOM-only
兼容别名 `med_dicom_route`。专用流程完成后，由主智能体结合模型结果、
域偏移提示和用户原始问题作答；路由建议不是诊断结论。
