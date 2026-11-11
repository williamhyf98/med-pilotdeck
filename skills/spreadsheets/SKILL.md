---
name: spreadsheets
description: 创建、读取、审计和安全修改 .xlsx、.csv、.tsv 表格。已有 XLSX 转 PDF 时使用注册工具 office_to_pdf；其余转换只通过捆绑 spreadsheet.sh 完成。旧版 .xls 仅在已有转换后端时支持。
---

# 电子表格

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
SPREADSHEET_SKILL_ROOT="$(dirname "<path>")"
```

`spreadsheet.sh` 会定位完整的隔离运行时和内置图表/审计工具。运行时未就绪
时会返回「交付包不完整」；此时停止并报告，不要改走其它实现。

## XLSX 转 PDF

已有 XLSX 要转换为 PDF 时，调用注册工具 `office_to_pdf`，不要用
`spreadsheet.sh` 重新生成 PDF，也不要直接调用 LibreOffice。该工具统一通过
node12 Office Renderer 执行。

## Agent 可用表面

- 只调用本技能的 `spreadsheet.sh`
- 只用 `.md` / `.json` / `.csv` / `.tsv` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告
- 输入材料尚未被现有工具转换为结构化数据时，明确说明缺少抽取能力并停止；
  不要自行补充新的解析实现

## 输出位置

用户给了路径就使用；否则输出到当前工作目录的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

中间 Markdown/JSON 放在 `scratch/qa/` 或 `PILOTDECK_WORK_DIR`，不要交付。

## 新建表格

普通新建只调用 `make`。

短内容：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make \
  --title "战创伤救治清单" \
  --body "现场评估

控制出血

快速后送" \
  --out "$PWD/exports/战创伤救治清单.xlsx"
```

Markdown 管道表：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make \
  --title "救治清单" \
  --markdown "$PWD/scratch/qa/table.md" \
  --out "$PWD/exports/救治清单.xlsx"
```

导入分隔文件：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make \
  --csv "$INPUT_CSV" \
  --out "$PWD/exports/导入结果.xlsx"
```

多工作表、公式、数字格式、表格对象、数据验证、条件格式和原生图表使用
`--spec`：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make \
  --spec "$PWD/scratch/qa/workbook.json" \
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
- `--design-theme`（六套共享主题，见下节；`--theme` 会报错，不要用）
- `--out`
- `--force`（用户明确要求替换时）

这些内容源互斥。详细 spec 见
[creation.md](references/creation.md)。

### 主题配色（可选）

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make   --spec "$PWD/scratch/qa/workbook.json"   --design-theme 宣纸病案   --out "$PWD/exports/统计工作簿.xlsx"
```

- 可用 ID / 中文名 / 别名：`clinical` 临床晨光、`academic` 青黛循证、`trauma` 松风急救、
  `archive` 宣纸病案、`edu` 杏林宣教、`mono` 灰阶印刷；也可以在 spec 里写
  `"designTheme": "academic"`。不写主题时保持原来的默认观感。
- 主题只改**颜色与字体角色**：标题与表头用主色、正文用墨色、工作表页签用强调色、
  图表序列与网格用主题图表色板；`archive` 会把正文字体换成衬线体。
- 不改：版式、列宽、数字格式、条件格式规则本身（但规则里的 `role` 颜色会按当前主题解析）、公式。
  原生 Excel 表格样式本身仍保留，表头颜色由单元格直接格式覆盖，所以在 Excel 里看到的就是主题色。
- 成功 JSON 会返回 `theme.id` / `theme.label`，交付说明里写明「本次使用主题：<中文名>」。
- 图表是浮动对象，导出 PDF/预览时按页边**裁切**、不缩放：`anchor` 默认的 `G2:N18`
  在 A4 纵向里会有一半落到页外，看上去像"图表只有一半"。请把锚点收进页内
  （如 `{"from":"A7","to":"H24"}`），或把该页设为横向。

### 重点标注（角色色）

需要"标红/标黄/整行高亮"时，不要写死 hex，用角色名：

```json
{
  "sheets": [{
    "name": "汇总",
    "headers": ["项目", "完成率", "状态"],
    "rows": [["A", 0.92, "正常"], ["B", 0.61, "关注"], ["C", 0.35, "风险"]],
    "conditionalFormatting": [
      {"range": "B2:B4", "rules": [
        {"type": "cellIs", "operator": "lessThan", "formulae": [0.6], "role": "danger", "bold": true}
      ]}
    ],
    "highlights": [
      {"range": "A4:C4", "role": "danger", "bold": true}
    ]
  }]
}
```

- `conditionalFormatting[].rules[].role`：条件格式命中时套用角色色（字色 + 约 12% 的浅底）。
  `bold: true` 加粗，`fill: false` 只要字色不要底色；原有 `style` 仍可保留。
- `highlights[]`：不按条件、直接给一段区域上角色色，适合"重点行/结论行"。
- 角色：语义色 `success` / `warning` / `danger` / `info` 固定不随主题变，
  和 Word/PPT/PDF 是同一个红/黄/绿/蓝；`primary` / `accent` / `support` /
  `ink` / `muted` / `rule` 跟随当前主题，按"字色 + 12% 浅底"上色；
  `soft` / `white` 是"底色"角色，自动配墨色字，适合分组行 / 隔断行。
- 语义色没选主题时也能用；主题专属角色（`primary` 等）必须先选
  `--design-theme` 或在 spec 写 `"designTheme"`，否则直接报错，不会静默变黑。

### 浮动插图（用户上传照片）

像 Excel「插入 → 图片」：在 `--spec` 的 sheet 上写 `images[]`，路径用附件列表的 **`$WS/inbox/...` 绝对路径**。禁止 http(s)。仅新建工作簿；不要为插图去读 `spreadsheet_cli.mjs` 源码。

```json
{
  "sheets": [{
    "name": "汇总",
    "headers": ["阶段", "人数"],
    "rows": [["一级", 10]],
    "images": [
      { "path": "/abs/.../inbox/<batch>/1-wound.jpg", "anchor": "G2", "width": 400, "height": 300 }
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
  --input "$INPUT_XLSX" \
  --out "$PILOTDECK_WORK_DIR/spreadsheets/inspection.json"
```

审阅 `package.unsafeForRoundTrip`。有宏、图表、透视表、外链、签名或其它
风险对象时停止并报告；除非用户明确接受，不要
`--allow-risky-roundtrip`。

安全的现有工作簿用受控 spec 修改单元格/公式，输出新文件：

```bash
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" make \
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
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" inspect --input "$INPUT" --sheet "汇总" --range "A1:H30" --styles
bash "$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh" audit --input "$INPUT" --out "$PILOTDECK_WORK_DIR/spreadsheets/audit.json"
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
