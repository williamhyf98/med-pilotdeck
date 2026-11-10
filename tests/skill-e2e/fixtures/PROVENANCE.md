# 回归素材来源与许可登记（T5.1）

本文件登记 `tests/` 下**每一份会随仓库分发**的测试素材来源、许可与隐私状态。
新增或更换素材时必须同步更新本表；只留在本机 `tests/skill-e2e/local-fixtures/`
的材料不进本表（`scripts/check-test-assets.mjs` 会阻止它们被提交）。

## 随仓库分发的文件

| 文件 | 类型 | 来源 | 许可 / 授权 | 隐私状态 | 处理决定 |
| --- | --- | --- | --- | --- | --- |
| `medical-batch/ultrasound.dcm` | DICOM 影像 | 院方提供的真实检查 | 未登记，需补授权记录 | **含真实 PHI**：`PatientName`、`PatientID`、`PatientBirthDate`、`AccessionNumber` 与医院名均未脱敏 | 2026-11-10 用户决定：暂不删除、不脱敏，只在 `docs/skills-optimization-plan.zh.md` 登记为已知风险；后续从「改写历史 / 收紧权限 / 结构性脱敏」三选一 |
| `medical-batch/admission-note.xml` | 入院记录 XML | 与上一条同批次的院方样本 | 未登记 | 姓名已脱敏为 `***`，其余字段为检查所见文本 | 保留；补授权记录 |
| `wse_0820_00_injury.jpg` | 外伤照片 | 文件 EXIF 自述为特效化妆库存图 | 未登记（EXIF 未给出可核对的许可条款） | 自述非真实患者 | 待补来源与许可；补齐前不得用于对外发布物 |

## 测试内自撰的合成素材

以下素材**不作为文件**存在，而是在测试代码里现写（自撰病例，无第三方内容、无图片、无许可问题）：

| 格式 | 素材所在 | 覆盖内容 |
| --- | --- | --- |
| PPTX / DOCX / XLSX / PDF / HTML / 图示 | `tests/skills/theme-sample-matrix.test.mjs` | 六套主题 × 六种格式的最小样张 |
| DOCX / PDF / PPTX / HTML | `tests/skills/regression-missing-assets.test.mjs` | 引用缺失图片时各格式的行为 |
| 六格式 | `tests/skills/qa-regression.test.mjs`、`tests/skills/qa-adapters.test.mjs` | 正例 / 反例 / 降级 / 旧流程四类内容溯源 |
| PPTX / XLSX / 图示 | `tests/skills/pptx-content.test.mjs`、`format-capability.test.mjs`、`diagram-layout.test.mjs` | 版式、原生图表与几何 |

## 规则

1. 新增**公开**素材必须在本表登记来源与许可；来源不明的素材只能放
   `tests/skill-e2e/local-fixtures/`。
2. 含 PHI 的素材即使已脱敏，也要在本表注明脱敏了哪些字段。
3. `scripts/check-test-assets.mjs` 只校验「本地素材是否被隔离」，不判断许可；
   许可仍是人工登记项。
