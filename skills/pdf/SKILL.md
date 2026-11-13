---
name: pdf
description: 读取、创建、编辑、合并、拆分、旋转、填写、渲染并校验工作区 PDF。输入或交付物是 .pdf 时使用本技能，包括把对话里刚生成的救治方案、病例报告导出为 PDF。已有 DOCX、XLSX 或 PPTX 转 PDF 时使用注册工具 office_to_pdf，不要用本技能重新排版 Office 文件。
---

# PDF

只用 `read_skill` 返回的 `<path>` 所在目录。那就是本技能根目录。不要用 `$PILOT_HOME/skills/pdf`，不要在用户 skills 目录里查找本技能。

```bash
PDF_SKILL_ROOT="$(dirname "<path>")"
```

`pdf.sh` 会自己定位隔离运行时和捆绑字体。Python 运行时缺失会返回「交付包不完整」，
此时停止并报告，不要改走其它实现。

Poppler（`pdfinfo` / `pdftoppm`）是**可选**的渲染组件：

- 缺 Poppler 时，`make`、`inspect`、`audit`、`deliver`、`merge`、`split`、
  `rotate`、`forms-*` 仍然可用，只是 `render` 不可用、无法做视觉验收。
- `check` 会返回 `"status":"degraded"`、`"usable":true`、`"render_available":false`。
  这时照常完成工作，并在交付说明里注明「未做视觉验收」；用户要求必须做过视觉验收时，
  用 `deliver --require-render` 让交付明确失败，而不是悄悄跳过。

## Office 转 PDF 的边界

已有 `.docx`、`.xlsx` 或 `.pptx` 要转换成 PDF 时，调用注册工具
`office_to_pdf`。不要用 `pdf.sh make` 把 Office 文件内容重建成 PDF，也不要
直接调用 `soffice` 或 LibreOffice。`pdf.sh` 只负责从文本/Markdown/spec 新建
PDF，以及读取、编辑、合并、拆分、旋转和渲染已有 PDF。

## Agent 可用表面

- 只调用本技能的 `pdf.sh`
- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

## 输出位置

用户给了路径就用用户的路径。否则写到当前工作目录下的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

例如用户要「病例报告.pdf」：`--out "$PWD/exports/病例报告.pdf"`。

## 新建 PDF

不要 scaffold，不要手写 ReportLab。把标题和正文交给 `make`：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make \
  --title "病例报告" \
  --body "【病例报告】" \
  --out "$PWD/exports/病例报告.pdf"
```

多段正文用换行；多节内容把声明式 JSON 写成 `--spec`：

```json
{
  "title": "病例报告",
  "body": "【病例报告】",
  "sections": [
    { "heading": "病史", "body": "……" }
  ]
}
```

### 主题、表格与目录

**主题**（默认 `clinical` 临床晨光；用户点名别套主题、或需要纯黑白打印时才关）：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --title "病例报告" --markdown body.md \
  --design-theme 临床晨光 --out "$PWD/exports/病例报告.pdf"
```

可用 ID、中文名或别名：`clinical` 临床晨光、`academic` 青黛循证、`trauma` 松风急救、
`archive` 宣纸病案（衬线）、`edu` 杏林宣教、`mono` 灰阶印刷。`spec` 里也可以写
`"designTheme": "academic"`。**不写主题参数时就是 `clinical`**；要回到改造前的纯黑白
报告用 `--design-theme none`（`neutral` / `off` / `无` 同义），此时 JSON 不返回 `theme`。
成功 JSON 会返回 `theme.id` / `theme.label`，交付说明中要写明「本次使用主题：<中文名>」。

**表格**：`--markdown` / `--body` / `--spec` 的段落里，标准管道表格会自动变成
原生 PDF 表格（表头着色、跨页重复表头、数值列右对齐）。表格块前后各留一个空行：

```markdown
| 指标 | 数值 | 参考区间 |
| --- | --- | --- |
| 肌钙蛋白 | 升高 | 0-0.04 |
```

第二行必须是 `| --- |` 分隔行；没有分隔行的 `收缩压 | 舒张压` 仍按普通段落输出。

**目录**：加 `--toc`（或 spec 里 `"toc": true`）。目录单独占一页（正文从第 2 页开始），
`##` 进一级条目、`###` 进二级条目（缩进），`####` 及更深不列入；条目超出一页会自动续页。
`make` 成功时会返回 `tocEntries: [{level, text, page}]`，可直接拿来做交付说明。
节数少于 3 时不要加，目录比正文还长没有意义。

### 局部样式（强调色 / 提示框 / 三线表）

用户说"这一节标红""加个提示框""表格用三线表"时，用 `--spec` 的角色名，
不要写死 hex：

```json
{
  "title": "术后观察记录",
  "body": "| 项目 | 数值 |\n| --- | --- |\n| 心率 | 88 |",
  "tableStyle": {"variant": "three-line"},
  "callout": {"role": "info", "title": "表格说明", "body": "默认使用三线表。"},
  "sections": [
    {
      "heading": "风险提示",
      "accent": "danger",
      "body": "患者出现一过性低血压。",
      "callout": {"role": "danger", "title": "立即处理", "body": "补液 500 mL，15 分钟后复测血压。"},
      "tableStyle": {"variant": "grid", "zebra": false, "headerRole": "accent"}
    }
  ]
}
```

- `accent`（顶层或小节）：这一节的小标题色条和标题文字换成该角色色。
- `callout`（顶层或小节）：浅色底 + 左侧色条的提示框，按 `title` / `body` 排。
- `tableStyle`（顶层或小节，小节覆盖顶层）：
  `variant: grid|three-line`（三线表无竖线、表头不上底色）、
  `zebra`（隔行浅底，三线表自动关掉）、`headerRole`（表头底色角色）。
- 角色：语义色 `success` / `warning` / `danger` / `info` 固定，不随主题变，
  和 Word/PPT/Excel 同一个红/黄/绿/蓝，**不选主题也能用**；
  `primary` / `accent` / `support` / `ink` / `muted` / `rule` 跟随当前主题，
  `soft` / `paper` 当底色用。没选主题却写主题角色会直接报错，不会静默变黑。
- 也可以直接给六位 hex 当强调色（`{"accent":"#1F5FA9"}`）：它同时会当文字色用，
  所以要和纸面 ≥ 4.5:1，不达标直接报错并给出可用的近似色。

### 正文插图（用户上传照片）

需要把 inbox 里的图片嵌进 PDF 正文时，用 `--spec` 的 `images`（顶层或小节内），**不要**去读 `pdf_cli.py` / `starter_pdf.py` 源码：

```json
{
  "title": "病例报告",
  "body": "伤情概述……",
  "images": [
    {
      "type": "image",
      "path": "/abs/.../inbox/<batch>/1-wound.jpg",
      "width_mm": 120,
      "caption": "图 1 创面"
    }
  ],
  "sections": [
    {
      "heading": "处置",
      "body": "……",
      "images": [
        { "path": "/abs/.../inbox/<batch>/2-xray.jpg", "caption": "图 2 影像" }
      ]
    }
  ]
}
```

- 路径用附件列表给出的 **绝对路径**（`$WS/inbox/...`）。禁止 http(s)。
- 详细字段见 [creation.md](references/creation.md)。

`make` 会用技能内字体生成 PDF，并完成结构审计和页面渲染。JSON 里的 `output` 是交付文件；`preview` 里的 PNG 只供你目视核对，不要当用户交付物。核对可用 `read_file` 打开第一张预览图。

## 把对话里已有的方案做成 PDF

`pdf.sh` **读不到聊天记录**。用户说「把以上/刚才的救治方案（或病例报告）生成 PDF」时，上一轮你已经写过的全文就在当前对话里：直接用原文，不要让用户再贴一遍，不要摘要代替原文，不要重写一版。

长文不要塞进 `--body "..."`（引号和长度容易把命令搞坏）。用 `write_file` 把完整原文写成 Markdown，再交给 `make`：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make \
  --title "救治方案" \
  --markdown "$PWD/scratch/qa/content.md" \
  --out "$PWD/exports/救治方案.pdf"
```

- 标题用用户的说法（「救治方案」「病例报告」等）。
- `content.md` 保持对话原文，包括 `###` / `####` 小标题和列表。`make` 会按标题分页排版。
- `write_file` 只用于 `.md` / `.json` 声明式输入。

复杂排版规范见 [creation.md](references/creation.md)。

## 检查或提取

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" inspect \
  --input "$INPUT_PDF" \
  --out "$PWD/scratch/qa/inspection.json"
```

需要全文或表格时再加 `--text-out` / `--tables-out`。扫描件可能没有可提取文本；本技能不含 OCR。

## 改现有 PDF

先 `inspect`，必要时 `render`。源文件保留，结果写到源文件的同一个目录下。

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" merge --inputs first.pdf second.pdf --out "$PWD/exports/merged.pdf"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" split --input source.pdf --out-dir "$PWD/exports/pages" --pages "1-3,7"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" rotate --input source.pdf --out "$PWD/exports/rotated.pdf" --degrees 90 --pages "2,4-5"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" forms-inspect --input form.pdf --out "$PWD/scratch/qa/fields.json"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" forms-fill --input form.pdf --data "$PWD/scratch/qa/values.json" --out "$PWD/exports/filled.pdf"
```

页面操作不会像字处理器那样重排正文。见 [structure-and-forms.md](references/structure-and-forms.md)。

## 校验

`make` 已包含审计和渲染。交付前对最终文件跑一次 `deliver`，它把结构审计、
要求覆盖（必含文本、页数）和视觉验收状态写进一份报告：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" deliver \
  --input "$FINAL_PDF" \
  --require-text "肌钙蛋白" \
  --min-pages 1 --max-pages 4 \
  --report "$PWD/scratch/qa/pdf/delivery.json"
```

参数：`--acceptance` 可直接传统一验收记录；`--require-text`、`--min-pages`、
`--max-pages` 用于直接声明要求；`--visual-review` 传入绑定产物哈希的逐页评审；
`--require-render` 表示没有渲染结果就不允许交付。

**返回里已经带全量明细**（`--report` 只是留档）：`status=failed` 时直接读
`hardFailures`（审计原文）、`gates.errors`（门禁原因）、`render.reason`（渲染失败原因），
不要去猜，也不用再单独打开报告文件。`audit` 同理，`hardFailures` 是字符串数组。

默认把报告和渲染图写到 `$PILOTDECK_WORK_DIR/pdf/qa/`；没有设置该变量时写到
`<PDF 所在目录>/.pdf-qa/<文件名>/`。按全尺寸查看每一张 `page-*.png`，硬失败必须消除。
清单见 [qa-checklist.md](references/qa-checklist.md)。

`inspect` 的 `fonts` 字段列出每个字体名和 `embedded` 标记：打印或投稿场景里
中文字体必须是 `embedded: true`；`--tables-out` 则用来核对表格是否真的成了表格。

单独排查时仍可分别调用：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" audit --input "$FINAL_PDF" --out "$PWD/scratch/qa/audit.json"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" render --input "$FINAL_PDF" --out-dir "$PWD/scratch/qa/render" --dpi 144
```

## 交付

只返回用户要的 PDF 和简短说明。不要交付预览图、JSON 或运行时文件，除非用户明确要。
