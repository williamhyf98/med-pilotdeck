---
name: pdf
description: 读取、创建、编辑、合并、拆分、旋转、填写、渲染并校验工作区 PDF。输入或交付物是 .pdf 时使用本技能，包括把对话里刚生成的救治方案、病例报告导出为 PDF。所有转换只通过捆绑的 pdf.sh 完成。
---

# PDF

只用 `read_skill` 返回的 `<path>` 所在目录。那就是本技能根目录。不要用 `$PILOT_HOME/skills/pdf`，不要在用户 skills 目录里查找本技能。

```bash
PDF_SKILL_ROOT="$(dirname "<path>")"
```

`pdf.sh` 会自己定位完整的隔离运行时、捆绑字体和渲染组件。缺任何一项都会
返回 JSON 错误「交付包不完整」；此时停止并报告，不要改走其它实现。

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

`make` 已包含审计和渲染。对已有 PDF 或编辑结果：

```bash
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" audit --input "$FINAL_PDF" --out "$PWD/scratch/qa/audit.json"
bash "$PDF_SKILL_ROOT/scripts/pdf.sh" render --input "$FINAL_PDF" --out-dir "$PWD/scratch/qa/render" --dpi 144
```

按全尺寸查看每一张 `page-*.png`。硬失败必须消除。清单见 [qa-checklist.md](references/qa-checklist.md)。

## 交付

只返回用户要的 PDF 和简短说明。不要交付预览图、JSON 或运行时文件，除非用户明确要。
