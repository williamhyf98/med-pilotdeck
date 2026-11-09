---
name: spreadsheets
description: 创建、读取、审计和安全修改 .xlsx、.csv、.tsv 表格。新建表格使用结构化工具 spreadsheets_make；已有 XLSX 转 PDF 时使用注册工具 office_to_pdf；其余转换只通过捆绑 spreadsheet.sh 完成。旧版 .xls 仅在已有转换后端时支持。
---

# 电子表格

新建表格时调用结构化工具 `spreadsheets_make`，不要拼接 Bash 或自行查找脚本。已有表格的检查、审计、修改和高级 QA 才使用系统登记的表格 Skill 业务入口。

`spreadsheet.sh` 会定位完整的隔离运行时和内置图表/审计工具。运行时未就绪
时会返回「交付包不完整」；此时停止并报告，不要改走其它实现。

## XLSX 转 PDF

已有 XLSX 要转换为 PDF 时，调用注册工具 `office_to_pdf`，不要用
`spreadsheet.sh` 重新生成 PDF，也不要直接调用 LibreOffice。该工具统一通过
node12 Office Renderer 执行。

## Agent 可用表面

- 创建新表格：只调用 `spreadsheets_make`
- `spreadsheets_make` 的输入使用 `title`、`body`、`body_file_path`、`markdown_path`、
  `csv_path`、`tsv_path`、`spec_path`、`input_path`、`sheet`、`encoding`、
  `infer_types`、`output_path`、`force` 和 `timeout_ms`
- 需要创建声明式内容时，用 `write_file` 写入 `scratch/` 下的 `.md` / `.json` / `.csv` / `.tsv`，
  再把相对任务路径传给 `spreadsheets_make`

- 需要查看能力时可调用 `spreadsheet.sh capabilities`
- 只用 `.md` / `.json` / `.csv` / `.tsv` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告
- 输入材料尚未被现有工具转换为结构化数据时，明确说明缺少抽取能力并停止；
  不要自行补充新的解析实现

`capabilities` 只用于查看已登记的业务入口和路径契约；不要调用
`spreadsheet.sh --help`、`scaffold`、`build` 或自行编写 `.mjs` 构建器。

## 输出位置

交付文件写入本任务 `exports/`；中间文件写入 `scratch/`。需要目录时使用文件工具或由技能创建，不调用 `mkdir`。

中间 Markdown/JSON/CSV/TSV 放在 `$PILOTDECK_WORK_DIR/spreadsheets/`，不要交付。

## 新建表格

普通新建只调用 `make`。

短内容：

```json
{
  "title": "战创伤救治清单",
  "body": "现场评估\n\n控制出血\n\n快速后送",
  "output_path": "exports/战创伤救治清单.xlsx"
}
```

Markdown 管道表：

```json
{
  "title": "救治清单",
  "markdown_path": "scratch/spreadsheets/table.md",
  "output_path": "exports/救治清单.xlsx"
}
```

导入分隔文件：

```json
{
  "csv_path": "inbox/data.csv",
  "output_path": "exports/导入结果.xlsx"
}
```

多工作表、公式、数字格式、表格对象、数据验证、条件格式和原生图表使用
`--spec`：

```json
{
  "spec_path": "scratch/spreadsheets/workbook.json",
  "output_path": "exports/统计工作簿.xlsx"
}
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

### 浮动插图（用户上传照片）

像 Excel「插入 → 图片」：在 `--spec` 的 sheet 上写 `images[]`，路径用附件列表的 **`$WS/inbox/...` 绝对路径**。禁止 http(s)。仅新建工作簿；不要为插图去读 `spreadsheet_cli.mjs` 源码。

```json
{
  "sheets": [{
    "name": "汇总",
    "headers": ["阶段", "人数"],
    "rows": [["一级", 10]],
    "images": [
      { "path": "/当前任务/inbox/<batch>/1-wound.jpg", "anchor": "G2", "width": 400, "height": 300 }
    ]
  }]
}
```

## 公式与远程 Office Renderer

- 派生值必须保留为 Excel 公式，不要硬编码计算结果。
- 公式使用英文函数名，不带前导 `=`，避免整列引用。
- Office Renderer 可用时，`make` 会远程重算缓存结果。
- Office Renderer 不可用时，公式仍写入 XLSX，并设置
  `fullCalcOnLoad/forceFullCalc`，让 Excel 打开时重算；返回 warning，
  不要安装软件。
- 不要把占位 `result: 0` 当作核验结果。
- 页面 PNG 同样是可选项，不是交付硬门禁。

## 修改已有 XLSX

先检查，保留源文件：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" inspect \
  --input "inbox/source.xlsx" \
  --out "$PILOTDECK_WORK_DIR/spreadsheets/inspection.json"
```

审阅 `package.unsafeForRoundTrip`。有宏、图表、透视表、外链、签名或其它
风险对象时停止并报告；除非用户明确接受，不要
`--allow-risky-roundtrip`。

安全的现有工作簿用受控 spec 修改单元格/公式，输出新文件：

```json
{
  "input_path": "inbox/source.xlsx",
  "spec_path": "scratch/spreadsheets/edits.json",
  "output_path": "exports/修改后.xlsx"
}
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
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" inspect --input "inbox/source.xlsx" --sheet "汇总" --range "A1:H30" --styles
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" audit --input "inbox/source.xlsx" --out "$PILOTDECK_WORK_DIR/spreadsheets/audit.json"
```

只读请求不要生成新表格。

## 旧版 XLS

`convert-legacy` 需要内网 Office Renderer。后端不存在时返回 `unsupported` 并保留
源文件；不要现场安装转换器。

## 保留命令

- `inspect`：工作表、区域、样式、公式和兼容性
- `audit`：公式错误、结构、图表、覆盖率和警告
- `render`：通过内网 Office Renderer 获取页图
- `convert-legacy` / `recalculate`：通过内网 Office Renderer
- `deliver`：高级候选封印兼容路径

`scaffold` / `build` 仅为维护与旧 self-test 保留，不属于 Agent 契约。

## 交付

成功 JSON 的 `output` 是最终交付物。只返回最终 `.xlsx`、`.csv` 或 `.tsv`
和简短说明；不要交付 spec、builder、requirements、audit JSON、PNG、
montage、PDF、候选或运行时目录，除非用户明确要求。
