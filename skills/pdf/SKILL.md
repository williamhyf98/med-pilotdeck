---
name: pdf
description: 读取、创建、编辑、合并、拆分、旋转、填写、渲染并校验工作区 PDF。输入或交付物是 .pdf 时使用本技能，包括把对话里刚生成的救治方案、病例报告导出为 PDF。只通过捆绑的 pdf.sh 完成工作，不要手写 Python、不要安装依赖、不要搜索系统字体。
---

# PDF

只用 `read_skill` 返回的 `<path>` 所在目录。那就是本技能根目录。不要用 `$PILOT_HOME/skills/pdf`，不要在用户 skills 目录里查找本技能。

```bash
PDF_SKILL_ROOT="$(dirname "<path>")"
PDF_TOOL="$PDF_SKILL_ROOT/scripts/pdf.sh"
```

`pdf.sh` 会自己定位隔离 Python、捆绑字体和 Poppler。缺任何一项都会返回 JSON 错误「交付包不完整」；此时停止，不要 pip、不要 `fix`、不要改用系统 `python3`、不要自己写生成脚本。

## 禁止

- 用 `write_file` 或 `edit_file` 写 `*.py` / `*.js` 来生成 PDF
- `pip`、`curl`、`brew`、`npm`，或 `check || fix`
- 搜索 `$HOME`、`$PILOT_HOME/skills`、`/System/Library/Fonts`、`/usr/share/fonts` 或其他系统字体
- 把中间产物写到 `.pilotdeck/work/manual/`
- 把本技能复制到用户 skills 目录

## 输出位置

用户给了路径就用用户的路径。否则写到当前工作目录下的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

例如用户要「病例报告.pdf」：`--out "$PWD/exports/病例报告.pdf"`。

## 新建 PDF

不要 scaffold，不要手写 ReportLab。把标题和正文交给 `make`：

```bash
bash "$PDF_TOOL" make \
  --title "病例报告" \
  --body "【病例报告】" \
  --out "$PWD/exports/病例报告.pdf"
```

多段正文用换行；多节内容把 JSON 写成 `--spec`，仍然不要写 Python：

```json
{
  "title": "病例报告",
  "body": "【病例报告】",
  "sections": [
    { "heading": "病史", "body": "……" }
  ]
}
```

`make` 会用技能内字体生成 PDF，并完成结构审计和页面渲染。JSON 里的 `output` 是交付文件；`preview` 里的 PNG 只供你目视核对，不要当用户交付物。核对可用 `read_file` 打开第一张预览图。

## 把对话里已有的方案做成 PDF

`pdf.sh` **读不到聊天记录**。用户说「把以上/刚才的救治方案（或病例报告）生成 PDF」时，上一轮你已经写过的全文就在当前对话里：直接用原文，不要让用户再贴一遍，不要摘要代替原文，不要重写一版，不要因为内容长就去写 Python。

长文不要塞进 `--body "..."`（引号和长度容易把命令搞坏）。用 `write_file` 把完整原文写成 Markdown，再交给 `make`：

```bash
bash "$PDF_TOOL" make \
  --title "救治方案" \
  --markdown "$PWD/exports/qa/content.md" \
  --out "$PWD/exports/救治方案.pdf"
```

- 标题用用户的说法（「救治方案」「病例报告」等）。
- `content.md` 保持对话原文，包括 `###` / `####` 小标题和列表。`make` 会按标题分页排版。
- 允许 `write_file` 写 `.md` / `.json`；仍然禁止写 `*.py` 来生成 PDF。

复杂排版规范见 [creation.md](references/creation.md)。

## 检查或提取

```bash
bash "$PDF_TOOL" inspect \
  --input "$INPUT_PDF" \
  --out "$PWD/exports/qa/inspection.json"
```

需要全文或表格时再加 `--text-out` / `--tables-out`。扫描件可能没有可提取文本；本技能不含 OCR。

## 改现有 PDF

先 `inspect`，必要时 `render`。源文件保留，结果写到源文件的同一个目录下。

```bash
bash "$PDF_TOOL" merge --inputs first.pdf second.pdf --out "$PWD/exports/merged.pdf"
bash "$PDF_TOOL" split --input source.pdf --out-dir "$PWD/exports/pages" --pages "1-3,7"
bash "$PDF_TOOL" rotate --input source.pdf --out "$PWD/exports/rotated.pdf" --degrees 90 --pages "2,4-5"
bash "$PDF_TOOL" forms-inspect --input form.pdf --out "$PWD/exports/qa/fields.json"
bash "$PDF_TOOL" forms-fill --input form.pdf --data "$PWD/exports/qa/values.json" --out "$PWD/exports/filled.pdf"
```

页面操作不会像字处理器那样重排正文。见 [structure-and-forms.md](references/structure-and-forms.md)。

## 校验

`make` 已包含审计和渲染。对已有 PDF 或编辑结果：

```bash
bash "$PDF_TOOL" audit --input "$FINAL_PDF" --out "$PWD/exports/qa/audit.json"
bash "$PDF_TOOL" render --input "$FINAL_PDF" --out-dir "$PWD/exports/qa/render" --dpi 144
```

按全尺寸查看每一张 `page-*.png`。硬失败必须消除。清单见 [qa-checklist.md](references/qa-checklist.md)。

## 交付

只返回用户要的 PDF 和简短说明。不要交付预览图、JSON、构建脚本或运行时文件，除非用户明确要。
