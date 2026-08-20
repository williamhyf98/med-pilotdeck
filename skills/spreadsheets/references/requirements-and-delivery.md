# 需求覆盖与交付

为每一份非平凡工作簿创建任务专用的 `requirements.json`。需求把用户可见的承诺变成检查，这些检查不能由看起来相似的图像或不相关的工作表对象来满足。

## 模式

仅使用任务需要的字段：

```json
{
  "sourceBacked": true,
  "sourceFiles": [
    {
      "path": "/absolute/path/source.xlsx",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "sourceBackedSheets": ["指标总览", "KPI趋势"],
  "requiredSheets": ["指标总览", "KPI趋势"],
  "exactSheetCount": 5,
  "minFormulaCount": 10,
  "requiredFormulaRanges": [
    { "sheet": "指标总览", "range": "F4:F10" }
  ],
  "requiredNonEmptyRanges": [
    { "sheet": "原始数据", "range": "A1:H20", "minCount": 80 }
  ],
  "expectedCells": [
    { "sheet": "指标总览", "cell": "F4", "value": 0.92, "tolerance": 0.0001 }
  ],
  "expectedRanges": [
    {
      "sheet": "KPI趋势",
      "range": "A4:C6",
      "values": [
        ["1月", 100, 90],
        ["2月", 110, 95],
        ["3月", 120, 105]
      ]
    }
  ],
  "requiredCellTypes": [
    { "sheet": "指标总览", "range": "B4:F10", "type": "number" },
    { "sheet": "行动项", "range": "A4:A20", "type": "string" },
    { "sheet": "行动项", "range": "H4:H20", "type": "date", "allowBlank": true, "minCount": 1 }
  ],
  "requiredNativeCharts": [
    {
      "sheet": "KPI趋势",
      "type": "line",
      "minCount": 1,
      "minPoints": 3,
      "sourceRanges": ["A4:A11", "B4:B11", "C4:C11"]
    }
  ],
  "requiredTables": [
    { "sheet": "原始数据", "minCount": 1 }
  ],
  "requiredConditionalFormatting": [
    { "sheet": "行动项", "range": "G4:G20" }
  ],
  "requiredDataValidations": [
    { "sheet": "行动项", "cell": "F4" }
  ],
  "maxPagesPerSheet": [
    { "sheet": "指标总览", "max": 1 }
  ],
  "maxTotalPages": 8,
  "warningDispositions": [
    {
      "type": "large_used_ranges",
      "rationale": "原始明细包含 120,000 行，范围与已核对的源数据一致。"
    }
  ]
}
```

## 有源支撑的工作簿

只要有一个或多个文件为输出提供事实，就设置 `sourceBacked: true`。构建前记录绝对输入路径及其 SHA-256 值；`audit` 和 `deliver` 会拒绝缺失或已更改的源。在 `sourceBackedSheets` 中列出每一张实质复现源事实的输出工作表。

每一张有源支撑的工作表必须至少有一项 `expectedCells` 或 `expectedRanges` 断言。对完整的、对用户关键的表格使用 `expectedRanges`，而不是只检查一个方便的单元格。这对 KPI 历史、渠道/来源表、日程、行动登记、负责人、日期以及其他“看起来像样但仍可能被替换”的事实尤其重要。

根据实际的 `inspect` 输出或精确的文本/JSON 提取来构建预期矩阵。不要凭记忆输入。需求证明输出匹配冻结的事实矩阵；源哈希证明任务期间输入未被更改。

对于非平凡工作簿，仅有结构检查会被拒绝。由公式驱动的工作簿需要 `requiredFormulaRanges`。原生图表需要带有精确 `sourceRanges` 和 `minPoints` 的 `requiredNativeCharts`。覆盖仅表示已声明的检查通过；它不是未声明用户意图的百分比。

图表类型为 `line`、`column` 或 `bar`。源范围对照原生图表系列公式进行匹配。`minPoints` 是每个系列中完整类别/值观测的最小数量。空白类别、空白/非数值、长度不匹配以及单点折线图会被拒绝。插入的 SVG 或 PNG 永远不能满足 `requiredNativeCharts`。

`requiredCellTypes` 支持 `number`、`date`、`string` 和 `boolean`。除非 `allowBlank` 为 true，否则范围内每一个单元格都必须具有所要求的类型。这能捕获导致 ExcelJS 或 Excel 把普通 KPI 值重新解释为日期的意外样式共享。

`warningDispositions` 不是通配旁路。每一项必须匹配已报告警告的 `type`，并包含具体的、任务特定的理由。优先修复警告；仅当工作簿有意正确时才使用处置。

需求只声明检查。不要把 `status` 或 `coverage` 这类审计输出写入 `requirements.json`；运行时会计算这些字段。将 `warningDispositions` 保持为 `{ "type": "...", "rationale": "..." }` 对象数组。

## 候选工作流

构建到临时候选文件，而不是最终目的地：

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

检查并在必要时修订候选文件。然后封存它：

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --qa-dir "$WORKSPACE/qa/render" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

`deliver` 要求 `requirements.json`，执行结构/公式/类型覆盖检查，分别渲染每一张工作表，拒绝空白打印页和页数预算失败，拒绝未解决警告，核验复制文件的哈希，重新打开最终产物，并报告其 SHA-256。

警告会阻断交付，直到被修复或显式处置。公式错误、无效日期、缺失所需对象、空白打印页、覆盖失败和哈希不匹配是硬失败。失败的构建不会更新所要求的候选文件；切勿通过把原始或调试工作簿复制到最终路径来恢复。

## 声明

最终回复以 `delivery.json` 和最终包检查为依据。不要声称：

- 当 `package.features.charts` 为零时存在原生图表；
- 当所需公式范围未通过时存在公式驱动逻辑；
- 当工作表渲染有多页时为一页版式；
- 当报告的 SHA 指向不同文件时为干净的最终产物。
- 当需求仅包含结构检查或省略关键源事实时为完整任务覆盖。
