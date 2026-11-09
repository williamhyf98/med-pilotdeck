---
name: pdf
description: 读取、创建、编辑、合并、拆分、旋转、填写、渲染并校验工作区 PDF。输入或交付物是 .pdf 时使用本技能，包括把对话里刚生成的救治方案、病例报告导出为 PDF。已有 DOCX、XLSX 或 PPTX 转 PDF 时使用注册工具 office_to_pdf，不要用本技能重新排版 Office 文件。
---

# PDF

新建 PDF 时调用结构化工具 `pdf_make`，不要拼接 Bash 或自行查找脚本。该工具会在后端
使用系统注册的 PDF Skill 入口，并自动完成参数白名单、任务路径、用户隔离和产物登记。
已有 PDF 的检查、编辑、合并、拆分和渲染仍使用系统注册的 PDF Skill 业务入口；
在这些结构化工具补齐前，不要自行调用解释器或安装依赖。

PDF Skill 会自己定位完整的隔离运行时、捆绑字体和渲染组件。缺任何一项都会
返回 JSON 错误「交付包不完整」；此时停止并报告，不要改走其它实现。

## Office 转 PDF 的边界

已有 `.docx`、`.xlsx` 或 `.pptx` 要转换成 PDF 时，调用注册工具
`office_to_pdf`。不要用 `pdf.sh make` 把 Office 文件内容重建成 PDF，也不要
直接调用 `soffice` 或 LibreOffice。`pdf.sh` 只负责从文本/Markdown/spec 新建
PDF，以及读取、编辑、合并、拆分、旋转和渲染已有 PDF。

## Agent 可用表面

- 创建新 PDF：只调用 `pdf_make`
- `pdf_make` 的输入只使用 `title`、`body`、`body_file_path`、`markdown_path`、
  `author`、`spec_path`、`output_path`、`force` 和 `timeout_ms`
- 需要创建声明式内容时，用 `write_file` 写入 `scratch/` 下的 `.md` / `.json`，
  再把相对任务路径传给 `pdf_make`
- 需要查看尚未迁移为结构化工具的保留能力时，使用系统提供的受控能力查询入口
- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

`capabilities` 只用于查看已登记的业务入口和路径契约；不要调用
`--help`、`self-test`、`scaffold`、`build` 或运行时安装入口。

## 输出位置

交付文件写入本任务 `exports/`；中间文件写入 `scratch/`。需要目录时使用文件工具或由技能创建，不调用 `mkdir`。

例如用户要「病例报告.pdf」：`output_path: "exports/病例报告.pdf"`。

## 新建 PDF

不要 scaffold，不要手写 ReportLab。把标题和正文交给 `pdf_make`：

```json
{
  "title": "病例报告",
  "body": "【病例报告】",
  "output_path": "exports/病例报告.pdf"
}
```

多段正文用换行；多节内容把声明式 JSON 写入任务目录后，把路径传给 `spec_path`：

```json
{
  "title": "病例报告",
  "body": "【病例报告】",
  "sections": [
    { "heading": "病史", "body": "……" }
  ]
}
```

### 正文插图（用户上传照片）

需要把 inbox 里的图片嵌进 PDF 正文时，用 `--spec` 的 `images`（顶层或小节内），**不要**去读 `pdf_cli.py` / `starter_pdf.py` 源码：

```json
{
  "title": "病例报告",
  "body": "伤情概述……",
  "images": [
    {
      "type": "image",
      "path": "/当前任务/inbox/<batch>/1-wound.jpg",
      "width_mm": 120,
      "caption": "图 1 创面"
    }
  ],
  "sections": [
    {
      "heading": "处置",
      "body": "……",
      "images": [
        { "path": "/当前任务/inbox/<batch>/2-xray.jpg", "caption": "图 2 影像" }
      ]
    }
  ]
}
```

- 路径用附件列表给出的 **绝对路径**（`$WS/inbox/...`）。禁止 http(s)。
- 详细字段见 [creation.md](references/creation.md)。

`pdf_make` 会用技能内字体生成 PDF，并完成结构审计和页面渲染。返回结果里的
`output` 是交付文件；`preview` 里的 PNG 只供你目视核对，不要当用户交付物。
核对可用 `read_file` 打开第一张预览图。

## 把对话里已有的方案做成 PDF

PDF Skill **读不到聊天记录**。用户说「把以上/刚才的救治方案（或病例报告）生成 PDF」时，
上一轮你已经写过的全文就在当前对话里：直接用原文，不要让用户再贴一遍，不要摘要代替原文，
不要重写一版。

长文不要塞进 `body`（长度容易超出模型工具参数）。用 `write_file` 把完整原文写成
Markdown，再交给 `pdf_make`：

```bash
pdf_make({
  "title": "救治方案",
  "markdown_path": "scratch/pdf/content.md",
  "output_path": "exports/救治方案.pdf"
})
```

- 标题用用户的说法（「救治方案」「病例报告」等）。
- `content.md` 保持对话原文，包括 `###` / `####` 小标题和列表。`pdf_make` 会按标题分页排版。
- `write_file` 只用于 `.md` / `.json` 声明式输入。

复杂排版规范见 [creation.md](references/creation.md)。

## 检查或提取

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" inspect \
  --input "inbox/source.pdf" \
  --out "$PILOTDECK_WORK_DIR/pdf/qa/inspection.json"
```

需要全文或表格时再加 `--text-out` / `--tables-out`。扫描件可能没有可提取文本；本技能不含 OCR。

## 改现有 PDF

先 `inspect`，必要时 `render`。源文件保留，结果写到源文件的同一个目录下。

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" merge --inputs first.pdf second.pdf --out "$PWD/exports/merged.pdf"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" split --input source.pdf --out-dir "$PWD/exports/pages" --pages "1-3,7"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" rotate --input source.pdf --out "$PWD/exports/rotated.pdf" --degrees 90 --pages "2,4-5"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" forms-inspect --input form.pdf --out "$PILOTDECK_WORK_DIR/pdf/qa/fields.json"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" forms-fill --input form.pdf --data "$PILOTDECK_WORK_DIR/pdf/qa/values.json" --out "$PWD/exports/filled.pdf"
```

页面操作不会像字处理器那样重排正文。见 [structure-and-forms.md](references/structure-and-forms.md)。

## 校验

`make` 已包含审计和渲染。对已有 PDF 或编辑结果：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" audit --input "exports/病例报告.pdf" --out "$PILOTDECK_WORK_DIR/pdf/qa/audit.json"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" render --input "exports/病例报告.pdf" --out-dir "$PILOTDECK_WORK_DIR/pdf/qa/render" --dpi 144
```

按全尺寸查看每一张 `page-*.png`。硬失败必须消除。清单见 [qa-checklist.md](references/qa-checklist.md)。

## 交付

只返回用户要的 PDF 和简短说明。不要交付预览图、JSON 或运行时文件，除非用户明确要。
