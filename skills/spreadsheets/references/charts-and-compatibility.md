# 图表与兼容性

## 兼容性预检

XLSX 是包含多种对象类型的包。捆绑检查器会在 ExcelJS 往返之前检测高级功能。

默认将这些视为不安全：

- VBA 宏。
- 原生图表和图表绘图。
- 数据透视表和透视缓存。
- 切片器。
- 外部链接、连接和查询表。
- 嵌入对象或 ActiveX 对象。
- 包签名。
- 可能包含不支持形状的绘图。

运行：

```bash
bash "$SHEET" inspect --input "$INPUT_XLSX" --out "$WORKSPACE/tmp/inspection.json"
```

审阅 `package.unsafeForRoundTrip` 和 `package.roundTripRisks`。如果存在风险：

1. 不要自动运行 `build --input`。
2. 说明哪些对象可能丢失或被重写。
3. 优先只读分析、新建配套工作簿，或范围收窄的未来 OOXML 操作。
4. 仅在用户明确批准之后、且丢失或重写所列对象可接受时，才使用 `--allow-risky-roundtrip`。

## 原生图表支持

全新工作簿支持可编辑的原生 `line`、`column` 和 `bar` 图表。运行时先重新计算公式，然后再注入图表 OOXML，因此 LibreOffice 无法在重新计算期间擦除新创建的图表。

通过构建器辅助函数创建图表：

```js
helpers.addNativeChart(workbook, {
  sheet: "KPI趋势",
  type: "line",
  title: "Q1 指标趋势",
  minPoints: 3,
  categories: "A4:A11",
  series: [
    { name: "实际值", values: "B4:B11", color: "4472C4" },
    { name: "目标值", values: "C4:C11", color: "ED7D31" }
  ],
  anchor: { from: "F3", to: "N19" },
  valueFormat: "0.0%",
  legend: "b"
});
```

- 类别范围和系列范围必须长度相等。
- 类别必须非空，系列值必须非空且在重新计算后为数值，折线图必须包含至少两个完整点。
- 当需要重塑时，保持图表源可见并由公式支撑。
- 不要用图像来满足所要求的图表。
- 将每一个所要求的图表加入 `requirements.json`；审计工作表、类型、源范围、原生图表数量和 `minPoints`。对于所要求的三个月趋势，使用 `minPoints: 3`。
- 渲染并检查图表标题、类别标签、图例标签、单位、放置以及空数据行为。
- 默认不要通过 ExcelJS 往返既有图表工作簿。全新创建图表并不意味着可以安全编辑任意既有图表包。

原生图表辅助函数负责 DrawingML 锚点和关系 XML。不要在构建器中手工编辑它。`audit` 会拒绝畸形锚点、嵌套或错位的 `clientData`、未解析的工作表到绘图链接、未解析的图表关系，以及缺失的图表部件。仅当 `package.compatibility.status` 为 `ok` 且满足图表需求时，图表在结构上才可交付。

其他图表类型仍不受支持。如果所要求的类型不可用，仅在保留预期分析要点时选择最接近的受支持原生类型，并说明替换。

## 图像与绘图

ExcelJS 可以创建图像，但既有绘图包可能包含不支持的形状或图表关系。对于既有工作簿，将任何绘图风险视为停止的理由。对于全新工作簿，仅在图像能改善理解时使用，并在已渲染页面中核验其位置。

## 旧版与启用宏的格式

- 用 `convert-legacy` 将 `.xls` 转换为临时 `.xlsx`，检查转换后的工作簿，并继续走 XLSX 工作流。保留 `.xls` 源并交付 `.xlsx`。
- 不要编辑 `.xlsm`；宏保留和签名完整性超出当前约定。
- 不要把不受支持的文件重命名为 `.xlsx`。

## LibreOffice 往返限制

LibreOffice 提供确定性的无头重新计算和渲染，但它不是 Microsoft Excel。重新计算可能在带筛选的工作表上引入空的绘图部件。运行时仅移除锚点数为零、绘图关系为零、且恰好有一个可解析工作表所有者的绘图部件；对含糊或已填充的绘图结构予以保留并拒绝，而不是猜测。复杂的仅限 Excel 公式、外部连接和高级对象可能表现不同。当环境提供 Excel 时，将最终 Microsoft Excel 冒烟测试作为可选的更高保障步骤。
