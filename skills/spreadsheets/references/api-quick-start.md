# JavaScript 构建器 API

使用一个可执行的 `.mjs` 构建器。构建器导出默认异步函数，并返回 ExcelJS 工作簿或 `{ workbook, requirements }`。

## 构建器约定

```js
export default async function build({
  ExcelJS,
  inputPath,
  createWorkbook,
  loadWorkbook,
  loadXlsx,
  loadDelimited,
  helpers,
}) {
  const workbook = inputPath
    ? await loadWorkbook(inputPath)
    : createWorkbook();
  const requirements = { requiredSheets: ["Summary"] };

  // 在此修改工作簿。
  return { workbook, requirements };
}
```

新建 XLSX 时使用 `createWorkbook()`。它会初始化工作簿元数据并请求完整计算。对于 `.xlsx`、`.csv` 或 `.tsv` 输入，使用 `loadWorkbook(inputPath)`。

## 创建工作表

```js
const sheet = workbook.addWorksheet("Summary", {
  views: [{ state: "frozen", ySplit: 2, showGridLines: false }],
  pageSetup: {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  },
});
```

在赋值公式之前，创建公式所引用的全部工作表。

## 写入成块的值

优先使用数组和行块，而不是分散的单单元格写入：

```js
sheet.addRows([
  ["Month", "Revenue", "Cost"],
  ["Jan", 100000, 70000],
  ["Feb", 120000, 78000],
]);
```

使用真正的 JavaScript 数字、布尔值和 `Date` 对象。将 ZIP 码和 SKU 等标识符保持为字符串。

## 写入公式

ExcelJS 公式字符串不以 `=` 开头：

```js
sheet.getCell("D2").value = {
  formula: "IFERROR((B2-C2)/B2,0)",
  result: 0,
};

sheet.getCell("B8").value = {
  formula: "'Inputs'!B2*(1+'Inputs'!B3)",
  result: 0,
};
```

占位符 `result` 会在 LibreOffice 重新计算之前被移除。不要把它当作已核验的结果。

## 设置单元格格式

```js
sheet.getCell("A1").font = {
  name: "Arial",
  size: 18,
  bold: true,
  color: { argb: "FF0F172A" },
};

sheet.getColumn("B").numFmt = '"$"#,##0';
sheet.getColumn("C").numFmt = "0.0%";
sheet.getColumn("A").width = 24;
sheet.getRow(1).height = 28;
```

ARGB 颜色包含 alpha 加 RGB，通常是 `FF` 后跟六位十六进制数字。

切勿将同一个可复用对象赋给某个范围内的 `cell.style`。ExcelJS 样式对象是可变的，并且可能按引用共享；稍后更改一个单元格的数字格式，可能在无声中把无关数字变成日期。使用会按单元格克隆样式的辅助函数：

```js
helpers.applyStyle(sheet, "A3:E20", {
  alignment: { vertical: "middle" },
  border: { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } },
});
helpers.setNumberFormat(sheet, "B4:C20", '¥#,##0');
helpers.setNumberFormat(sheet, "D4:D20", "0.0%");
```

当没有更强样式时，应用捆绑的表头基线：

```js
helpers.styleHeader(sheet, "A3:D3");
helpers.autoFitColumns(sheet, { min: 10, max: 30 });
helpers.autoFitRows(sheet);
helpers.applyChineseTypography(sheet, {
  platform: "cross-platform",
  titleRanges: ["A1:H1"],
});
```

除非所要求的编辑需要，否则不要用 `autoFitColumns` 重新样式化既有工作簿。

## 表格与筛选

```js
sheet.addRows([
  ["Month", "Revenue", "Cost"],
  ["Jan", 100000, 70000],
  ["Feb", 120000, 78000],
]);
helpers.addTableFromRange(sheet, {
  name: "RevenueTable",
  range: "A1:C3",
});
```

使用唯一的表格名称。不要让表格重叠。

## 数据验证

```js
helpers.addListValidation(sheet, "F4:F100", ["On Track", "At Risk", "Blocked"], {
  allowBlank: false,
});
```

对于较长的验证列表，优先使用隐藏或清晰标注的源范围。

## 条件格式

```js
helpers.addConditionalFormatting(sheet, {
  range: "D4:D100",
  rules: [{
    type: "cellIs",
    operator: "lessThan",
    formulae: [0.25],
    style: { font: { color: { argb: "FFB91C1C" } } },
  }],
});
```

对必须响应后续编辑的状态使用条件格式。

对 `expression` 和 `cellIs` 规则使用 `formulae`（复数）。构建预检会在 ExcelJS 序列化之前拒绝 `formula`，并报告工作表、范围和规则索引。

## 原生图表

使用原生图表，而不是插入已渲染的 SVG 或 PNG：

```js
helpers.addNativeChart(workbook, {
  sheet: "Summary",
  type: "column",
  title: "Revenue by month",
  categories: "A4:A15",
  series: [{ name: "Revenue", values: "B4:B15" }],
  anchor: { from: "F3", to: "N20" },
  valueFormat: '"$"#,##0',
});
```

支持的类型为 `line`、`column` 和 `bar`。将图表加入 `requirements.json`；审计必须确认其原生 OOXML 部件和源范围。

## 批注与来源

ExcelJS 支持旧式单元格备注：

```js
sheet.getCell("B3").note = "Source: https://example.com/data";
```

对于按行研究的数据，包含可见的来源 URL 列，而不是把所有出处都藏在备注中。

## CSV 和 TSV

加载分隔输入时不要进行不需要的类型转换。编码默认为自动 UTF-8/GB18030 检测：

```js
const workbook = await loadDelimited(inputPath, {
  sheetName: "Data",
  inferTypes: false,
  encoding: "auto",
});
```

返回工作簿，并将 `build --out` 扩展名选为 `.csv` 或 `.tsv`。除非指定 `--sheet`，否则导出第一个工作表。公式导出其计算结果，因为分隔文件无法存储公式。

## 常用命令

将每个构建器、候选文件、转换、渲染和报告都放在本轮工作目录下。只有 `FINAL_XLSX` 面向用户。

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/scratch/work/manual/<task-slug>}/spreadsheets"
FINAL_XLSX="$PWD/<requested-output>.xlsx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs" --requirements-out "$WORKSPACE/tmp/requirements.json"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --input "$INPUT_XLSX" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" convert-legacy --input "$INPUT_XLS" --out "$WORKSPACE/tmp/converted.xlsx"
bash "$SHEET" inspect --input "$INPUT_XLSX" --sheet Summary --range A1:H20 --styles --out "$WORKSPACE/tmp/inspection.json"
bash "$SHEET" audit --input "$WORKSPACE/tmp/candidate.xlsx" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/qa/audit.json"
bash "$SHEET" render --input "$WORKSPACE/tmp/candidate.xlsx" --out-dir "$WORKSPACE/qa/render" --per-sheet
bash "$SHEET" deliver --input "$WORKSPACE/tmp/candidate.xlsx" --out "$FINAL_XLSX" --qa-dir "$WORKSPACE/qa/final" --requirements "$WORKSPACE/tmp/requirements.json"
```
