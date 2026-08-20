---
name: spreadsheets
description: 创建、编辑、检查、分析、重算、渲染并校验独立电子表格文件，格式包括 .xlsx、.xls、.csv 和 .tsv。只要请求的输入或交付物是工作区电子表格，就使用本技能，包括公式驱动工作簿、原生图表、格式化表格、数据清理、工作簿问答、旧版 XLS 转换、中文或双语工作簿，以及电子表格视觉 QA。不要用于 Google Sheets、启用宏的 .xlsm 文件，或对 Microsoft Excel 的实时操控。
---

# 电子表格

通过可复现的 JavaScript `.mjs` 构建脚本和捆绑的 `spreadsheet.sh` 工作流处理独立电子表格文件。保留源文件，保持计算可审计，重算公式，并在交付前同时核验工作簿结构与渲染页面。

## 硬性要求

- 使用 JavaScript ES 模块和捆绑脚本。不要使用 `openpyxl`、`xlsxwriter`、`pandas.ExcelWriter`、Google Sheets API 或 Codex 私有运行时路径。
- 保留每一份输入文件。除非用户明确要求替换，否则把编辑写到不同输出。
- 重要计算保留在工作表公式中。不要用写死的结果替换可检查的公式。
- 修改现有工作簿之前先检查并渲染。除非用户要求重新设计，否则匹配其格式与约定。
- 编辑现有 XLSX 之前运行兼容性预检。未经用户明确批准，不要绕过有风险的往返。
- 通过 LibreOffice 重算公式驱动的 XLSX，并扫描保存结果中的公式错误。
- 请求的图表使用原生 Excel 图表对象。栅格图像或 SVG 不满足图表要求。
- 对每一份非平凡工作簿创建 `requirements.json`，并要求 `coverage.status=passed`。
- 对有源文件支撑的工作簿，在构建前冻结源文件哈希和紧凑事实矩阵。不要依赖记忆中的数值，也不要从上下文重构缺失事实。
- 当用户未指定语言时，把中文作为一等内容。应用跨平台排版策略，并在重算后核验字形。
- 渲染每一张终稿工作表页，并按全尺寸检查各 PNG。拼图只作总览。
- 交付前修复公式错误、裁切内容、损坏表格、不可读格式、意外空白表以及糟糕的页面布局。
- 构建到临时候选，并用 `deliver` 封印最终 XLSX。不要把未经审计的候选手动复制到最终路径。
- `build`、`audit` 或 `deliver` 失败意味着工作簿不可交付。不要复制原始/调试工作簿、删除请求的功能、追加 `|| true`，或在门禁失败后声称成功。
- 条件格式和原生图表使用捆绑辅助函数。不要用不受支持的 ExcelJS 图表 API 或未校验的底层条件格式对象替换它们。
- 解决每一条审计警告，或在 `warningDispositions` 中加入带具体理由的任务特定条目。未处置的警告会阻断 `deliver`。

## 阅读相关参考

- 编写或修改构建脚本之前，阅读 [api-quick-start.md](references/api-quick-start.md)。
- 每一份公式驱动工作簿或数据转换，阅读 [formulas-and-data.md](references/formulas-and-data.md)。
- 创建或视觉编辑工作簿之前，阅读 [formatting.md](references/formatting.md)。
- 中文、双语或未指定语言的全新工作簿，阅读 [chinese-and-cross-platform.md](references/chinese-and-cross-platform.md)。
- 编辑现有 XLSX 或处理图表与高级 Excel 对象之前，阅读 [charts-and-compatibility.md](references/charts-and-compatibility.md)。
- 每一份非平凡工作簿，阅读 [requirements-and-delivery.md](references/requirements-and-delivery.md)。
- 交付前阅读 [qa-checklist.md](references/qa-checklist.md)。

## 准备运行时

将包含本文件的目录解析为 `SPREADSHEET_SKILL_ROOT`，然后运行：

```bash
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
bash "$SHEET" check || bash "$SHEET" fix
```

所有中间产物都使用本轮作用域的 PilotDeck 工作目录。宿主会设置 `PILOTDECK_WORK_DIR`；回退路径把手动运行限制在项目内部：

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

把构建脚本、转换后的输入、源备注、检查结果、候选、渲染图、重算文件和 QA 报告放在 `WORKSPACE`。只有请求的交付物才放到项目或用户选定的输出目录。切勿在用户文件旁边创建 `.pilotdeck_build.mjs`、QA 目录或其他中间产物。

只要设置了 `PILOTDECK_WORK_DIR`，CLI 就会强制该边界：
`scaffold`、`build`、`convert-legacy`、`recalculate`、JSON 报告和渲染
输出必须留在工作目录下。只有 `deliver --out` 可以创建
项目可见的最终工作簿。边界失败必须通过移动
中间路径来纠正；不要绕过命令或手动复制文件。

## 路由请求

选择一条路线：

1. 只读问题或分析：检查相关工作簿区域和公式；不要导出或修改文件。
2. 全新 XLSX：搭一份构建脚本，创建工作簿，重算、审计、渲染并检查。
3. 现有 XLSX 编辑：先检查并渲染，审阅兼容性风险，然后做最小范围的编辑。
4. 旧版 XLS：转换为临时 XLSX，检查并渲染转换结果，然后走 XLSX 工作流并交付 `.xlsx`。
5. CSV 或 TSV 任务：保留分隔符、编码、标识符和文本语义。仅当请求公式、格式、表格、图像或其他工作簿功能时，才转换为 XLSX。

不要通过本技能接受 `.xlsm`、Google Sheets 或实时 Excel 会话。切勿把 `.xls` 重命名为 `.xlsx`。

在不修改源文件的情况下转换旧版工作簿：

```bash
bash "$SHEET" convert-legacy \
  --input "$INPUT_XLS" \
  --out "$WORKSPACE/tmp/converted.xlsx"
```

## 行动前先检查

获取紧凑的工作簿概览：

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --out "$WORKSPACE/tmp/inspection.json"
```

需要时检查精确区域和样式：

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --sheet "Summary" \
  --range "A1:H30" \
  --styles \
  --out "$WORKSPACE/tmp/summary.json"
```

对于现有 XLSX，审阅 `package.unsafeForRoundTrip` 和 `package.roundTripRisks`。若任一项报告有风险对象，编辑前停止并遵循 [charts-and-compatibility.md](references/charts-and-compatibility.md)。

在改变现有 XLSX 的视觉布局之前先渲染：

```bash
bash "$SHEET" render \
  --input "$INPUT" \
  --out-dir "$WORKSPACE/tmp/source-render"
```

## 创建或编辑工作簿

创建需求和一份可执行构建脚本：

```bash
bash "$SHEET" scaffold \
  --out "$WORKSPACE/tmp/workbook.mjs" \
  --requirements-out "$WORKSPACE/tmp/requirements.json"
```

根据用户请求的工作表、公式、原生图表、校验、条件格式、期望单元格/区域和打印页约束，编写 `$WORKSPACE/tmp/requirements.json`。仅有工作表列表加公式数量不足以构成覆盖率。

对于基于输入文件的任务：

1. 先检查确切的源区域或文本段落。
2. 设置 `sourceBacked: true`，在 `sourceFiles` 中记录每个输入及其构建前 SHA-256，并在 `sourceBackedSheets` 中列出输出数据表。
3. 为完整的用户关键表（如 KPI 历史、源行、行动项、负责人和截止日期）添加 `expectedRanges`。对重要合计和派生检查点使用 `expectedCells`。
4. 写完事实矩阵之前不要创建构建脚本。若源缺少状态、负责人、日期或数值，保持空白或标注为未确认，而不是编造。

修补并重跑该构建脚本，而不是创建重复脚本。构建全新工作簿：

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

编辑现有的安全工作簿：

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --input "$INPUT_XLSX" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

`build` 会保留输入，校验构建器结构和需求，阻断不安全往返，重算公式驱动的 XLSX，并执行紧凑公式审计。它会暂存输出，仅在审计通过后更新请求的候选，因此失败的构建必须修复并重跑。修复所报告的 `stage`、工作表、区域和字段，而不是关闭请求的功能或换第二份构建脚本。除非用户已明确接受所列兼容性风险，否则切勿添加 `--allow-risky-roundtrip`。

## 公式与数据规则

- 把假设/原始数据与派生输出分开。
- 把派生值写成公式，复杂逻辑使用可见的辅助区域。
- 大规模计算使用有界区域，而不是整列引用。
- 使用类型化的数字、布尔值和日期，而不是按显示格式写的字符串。
- 为货币、百分比、计数和日期应用显式数字格式。
- 跨表引用加引号，例如 `'Revenue Model'!B6`。
- 在 ExcelJS 公式对象中省略前导 `=`。见 [formulas-and-data.md](references/formulas-and-data.md)。
- 对于 CSV 和 TSV，把带前导零的标识符保留为文本；除非任务要求，否则不要推断日期或数字。
- 把超过 15 位的标识符保留为文本。检测 UTF-8/UTF-8 BOM/GBK/GB18030，新的分隔导出默认使用 UTF-8 BOM。
- 在翻译标签或重组表格时精确保留源事实。切勿用看似合理的 KPI、渠道、行动项、负责人、日期或状态替换。

## 校验与渲染

运行最终结构审计：

```bash
bash "$SHEET" audit \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/qa/audit.json"
```

渲染最终工作簿：

```bash
bash "$SHEET" render \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out-dir "$WORKSPACE/qa/render" \
  --montage "$WORKSPACE/qa/montage.png" \
  --per-sheet
```

按全分辨率检查每一张 `page-N.png`。修订构建脚本、重建，并重跑审计/渲染，直到硬失败消失，且每条警告都已修复或在 `requirements.json` 中明确处置。工作簿正确、可读且可用后即停止；不要把额外循环花在装饰抛光上。

修改本技能或其运行时之后，运行：

```bash
bash "$SHEET" self-test --out "$WORKSPACE/self-test"
```

## 交付

仅在检查候选页面之后封印 XLSX：

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --qa-dir "$WORKSPACE/qa/final-render" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

返回最终 `.xlsx`、`.csv` 或 `.tsv`，以及基于交付报告的简明摘要。提及有意的兼容性限制。当包检查报告图表数为零时，不要声称有原生图表。覆盖率只按实际声明的检查来描述；切勿把浅层结构通过说成「100% 任务覆盖」。除非用户要求，否则不要交付构建脚本、需求 JSON、PDF、渲染图、运行时文件或 QA 报告。
