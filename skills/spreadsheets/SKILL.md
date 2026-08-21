---
name: spreadsheets
description: 创建、读取、审计和安全修改 .xlsx、.csv、.tsv 表格。只通过捆绑 spreadsheet.sh 工作，不要编写 JavaScript/Python 生成器，不要安装依赖，不要把 LibreOffice 当成离线部署前提。旧版 .xls 仅在已有转换后端时支持。
---

# 电子表格

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
SPREADSHEET_SKILL_ROOT="$(dirname "<path>")"
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
```

`spreadsheet.sh` 会定位隔离 Node 运行时、ExcelJS 和内置图表/审计工具。
运行时未就绪时会返回「交付包不完整」；此时停止，不要 `fix`、
`bootstrap-runtime`、npm、npx，也不要自己写构建脚本。

## 禁止

- 用 `write_file` / `edit_file` 写 `.mjs`、`.js`、`.ts`、`.py` 生成表格
- `npm install` / `npm ci` / `npx` / `pip` / `curl` / `wget` / `brew`
- `check || fix`，或调用 `scaffold` 后修改 starter
- 搜索系统字体，或安装 LibreOffice、Poppler、ImageMagick
- `openpyxl`、XlsxWriter、pandas ExcelWriter、Google Sheets API
- `.xlsm`、宏、实时 Excel 控制，或把 `.xls` 改名为 `.xlsx`
- 未经用户明确授权覆盖已有输出或绕过 risky round-trip

## 输出位置

用户给了路径就使用；否则输出到当前工作目录的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

中间 Markdown/JSON 放在 `exports/qa/` 或 `PILOTDECK_WORK_DIR`，不要交付。

## 新建表格

普通新建只调用 `make`。

短内容：

```bash
bash "$SHEET" make \
  --title "战创伤救治清单" \
  --body "现场评估

控制出血

快速后送" \
  --out "$PWD/exports/战创伤救治清单.xlsx"
```

Markdown 管道表：

```bash
bash "$SHEET" make \
  --title "救治清单" \
  --markdown "$PWD/exports/qa/table.md" \
  --out "$PWD/exports/救治清单.xlsx"
```

导入分隔文件：

```bash
bash "$SHEET" make \
  --csv "$INPUT_CSV" \
  --out "$PWD/exports/导入结果.xlsx"
```

多工作表、公式、数字格式、表格对象、数据验证、条件格式和原生图表使用
`--spec`：

```bash
bash "$SHEET" make \
  --spec "$PWD/exports/qa/workbook.json" \
  --out "$PWD/exports/统计工作簿.xlsx"
```

可用参数：

- `--title`
- `--body` / `--body-file`
- `--markdown`（只解析 GitHub 风格管道表）
- `--csv` / `--tsv`
- `--spec`
- `--sheet`
- `--encoding`
- `--infer-types`（CSV/TSV 默认不猜类型）
- `--out`
- `--force`（用户明确要求替换时）

这些内容源互斥。详细 spec 见
[creation.md](references/creation.md)。

## 公式与 LibreOffice

- 派生值必须保留为 Excel 公式，不要硬编码计算结果。
- 公式使用英文函数名，不带前导 `=`，避免整列引用。
- 有 LibreOffice 时，`make` 会重算缓存结果。
- 没有 LibreOffice 时，公式仍写入 XLSX，并设置
  `fullCalcOnLoad/forceFullCalc`，让 Excel 打开时重算；返回 warning，
  不要安装软件。
- 不要把占位 `result: 0` 当作核验结果。
- 页面 PNG 同样是可选项，不是交付硬门禁。

## 修改已有 XLSX

先检查，保留源文件：

```bash
bash "$SHEET" inspect \
  --input "$INPUT_XLSX" \
  --out "$PILOTDECK_WORK_DIR/spreadsheets/inspection.json"
```

审阅 `package.unsafeForRoundTrip`。有宏、图表、透视表、外链、签名或其它
风险对象时停止并报告；除非用户明确接受，不要
`--allow-risky-roundtrip`。

安全的现有工作簿用受控 spec 修改单元格/公式，输出新文件：

```bash
bash "$SHEET" make \
  --input "$INPUT_XLSX" \
  --spec "$PILOTDECK_WORK_DIR/spreadsheets/edits.json" \
  --out "$PWD/exports/修改后.xlsx"
```

已有工作表只能使用 `cells`、`formulas`、`numberFormats`、`validations`、
`conditionalFormatting` 和 `charts`；不要用 headers/rows 重建整张表。
新建工作表必须在该 sheet spec 写 `"create": true`。

## CSV / TSV

- 默认保留字符串语义，不自动把 `001`、电话号码、身份证号、账号转数字。
- 超过 15 位的数字标识符必须保留为文本。
- 支持 UTF-8、UTF-8 BOM、GBK、GB18030；新导出默认 UTF-8 BOM。
- CSV/TSV 不支持多表、公式、格式或原生图表；需要这些能力就输出 XLSX。
- 未受信任文本以 `= + - @` 开头时，注意公式注入风险。

## 读取与审计

```bash
bash "$SHEET" inspect --input "$INPUT" --sheet "汇总" --range "A1:H30" --styles
bash "$SHEET" audit --input "$INPUT" --out "$PILOTDECK_WORK_DIR/spreadsheets/audit.json"
```

只读请求不要生成新表格。

## 旧版 XLS

`convert-legacy` 需要 LibreOffice。后端不存在时返回 `unsupported` 并保留
源文件；不要现场安装转换器。

## 保留命令

- `inspect`：工作表、区域、样式、公式和兼容性
- `audit`：公式错误、结构、图表、覆盖率和警告
- `render`：仅环境已有渲染后端时可选使用
- `convert-legacy` / `recalculate`：仅已有 LibreOffice 时
- `deliver`：高级候选封印兼容路径

`scaffold` / `build` 仅为维护与旧 self-test 保留，不属于 Agent 契约。

## 交付

成功 JSON 的 `output` 是最终交付物。只返回最终 `.xlsx`、`.csv` 或 `.tsv`
和简短说明；不要交付 spec、builder、requirements、audit JSON、PNG、
montage、PDF、候选或运行时目录，除非用户明确要求。
