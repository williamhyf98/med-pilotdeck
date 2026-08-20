---
name: pdf
description: 读取、创建、编辑、合并、拆分、旋转、填写、渲染并校验工作区 PDF 文件。只要请求的输入或交付物是 .pdf，就使用本技能，包括提取文本或表格、检查元数据与页面几何、生成新 PDF、重排页面、填写 AcroForm 字段，或检查视觉版式。不要用于 Google Drive 或仅限浏览器的 PDF 工作流。
---

# PDF

通过捆绑的 `pdf.sh` 工作流处理 PDF。把结构提取与视觉渲染当作互补：解析出的文本是内容证据，渲染出的页面才是版式证据。

## 硬性要求

- 保留每一份输入 PDF。除非用户明确要求替换，否则把编辑结果写到不同的输出文件。
- 文本、表格、图像及带坐标的检查使用 `pdfplumber`；页面结构、元数据、页面操作和 AcroForm 使用 `pypdf`；新建 PDF 使用 ReportLab。
- 改现有 PDF 之前先检查。当版式、页序、表单外观或视觉保真度重要时，先渲染。
- 用一份可执行的 Python 构建脚本创建新 PDF。修补并重跑同一构建脚本，不要堆积一次性脚本。
- 切勿仅凭文本提取成功就认定 PDF 看起来正确。
- 运行 `audit`，用 Poppler 渲染每一页终稿，并按全尺寸检查每一张页面 PNG。拼图只作总览。
- 交付前修复裁切或重叠内容、缺失字形、损坏表格、错误页序、不当图像裁剪、不一致页面尺寸以及错误页码。
- 不要依赖 Codex 私有运行时路径，也不要全局安装 Python 包。

## 阅读相关参考

- 创建或视觉上重新设计 PDF 之前，阅读 [creation.md](references/creation.md)。
- 合并、拆分、旋转、编辑元数据或处理表单之前，阅读 [structure-and-forms.md](references/structure-and-forms.md)。
- 交付前阅读 [qa-checklist.md](references/qa-checklist.md)。

## 准备运行时

将包含本文件的目录解析为 `PDF_SKILL_ROOT`，然后运行：

```bash
PDF_TOOL="$PDF_SKILL_ROOT/scripts/pdf.sh"
bash "$PDF_TOOL" check || bash "$PDF_TOOL" fix
```

`fix` 会在 `${PDF_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-pdf}` 下创建隔离的 Python 环境。Poppler 是系统依赖；若缺少 `pdfinfo` 或 `pdftoppm`，按 `fix` 打印的平台提示处理。

所有中间产物都使用本轮作用域的 PilotDeck 工作目录。宿主会设置 `PILOTDECK_WORK_DIR`；回退路径把手动运行限制在项目内部：

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/pdf"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

把构建脚本、提取内容、拆分页、转换文件、检查结果、渲染图和 QA 报告放在 `WORKSPACE`。只有用户请求的交付物才放到项目或用户选定的输出目录。切勿在用户文件旁边创建 QA 目录或其他中间产物。

## 路由请求

选择其中一条路线：

1. 只读问题：只检查或提取；不要导出修改后的 PDF。
2. 新建 PDF：搭一份构建脚本，构建、审计、渲染、检查并迭代。
3. 现有 PDF 的结构性编辑：先检查并渲染，做最小页面级改动，再审计并重新渲染。
4. AcroForm 任务：检查字段，填写到不同输出，渲染每个受影响页面，并核对外观。

扫描件/纯图像 PDF 可能没有机器可读文本。若渲染页面有效，不要称之为提取失败。本技能不捆绑 OCR；披露该限制，或在用户要求时使用另行可用的 OCR 工作流。

## 检查或提取

创建紧凑的结构与内容概览：

```bash
bash "$PDF_TOOL" inspect \
  --input "$INPUT_PDF" \
  --out "$WORKSPACE/tmp/inspection.json"
```

需要时提取整页文本和检测到的表格：

```bash
bash "$PDF_TOOL" inspect \
  --input "$INPUT_PDF" \
  --out "$WORKSPACE/tmp/inspection.json" \
  --text-out "$WORKSPACE/tmp/text.json" \
  --tables-out "$WORKSPACE/tmp/tables.json"
```

当页面级检查或定向搜索已足够时，不要整份加载大型提取结果。

## 创建 PDF

搭一份构建脚本并按任务编辑：

```bash
bash "$PDF_TOOL" scaffold --out "$WORKSPACE/tmp/build_pdf.py"
bash "$PDF_TOOL" build \
  --builder "$WORKSPACE/tmp/build_pdf.py" \
  --out "$FINAL_PDF"
```

构建脚本必须接受 `--out <path>`，可离线工作，显式嵌入或注册字体，并保持页码确定。遵循 [creation.md](references/creation.md)。

## 执行结构性操作

```bash
bash "$PDF_TOOL" merge --inputs first.pdf second.pdf --out merged.pdf
bash "$PDF_TOOL" split --input source.pdf --out-dir "$WORKSPACE/tmp/pages" --pages "1-3,7"
bash "$PDF_TOOL" rotate --input source.pdf --out rotated.pdf --degrees 90 --pages "2,4-5"
```

表单：

```bash
bash "$PDF_TOOL" forms-inspect --input form.pdf --out "$WORKSPACE/tmp/fields.json"
bash "$PDF_TOOL" forms-fill \
  --input form.pdf \
  --data "$WORKSPACE/tmp/values.json" \
  --out filled.pdf
```

这些操作保留源文件，且不会重排页面内容。见 [structure-and-forms.md](references/structure-and-forms.md)。

## 校验与渲染

运行最终结构审计：

```bash
bash "$PDF_TOOL" audit \
  --input "$FINAL_PDF" \
  --out "$WORKSPACE/qa/audit.json"
```

渲染每一页，并可选择创建总览拼图：

```bash
bash "$PDF_TOOL" render \
  --input "$FINAL_PDF" \
  --out-dir "$WORKSPACE/qa/render" \
  --dpi 144 \
  --montage "$WORKSPACE/qa/montage.png"
```

按全分辨率检查每一张 `page-*.png`。修订构建脚本或编辑，然后重跑审计与渲染，直到硬失败消失，且每条警告都已被理解。

更改本技能或其运行时之后，运行：

```bash
bash "$PDF_TOOL" self-test --out "$WORKSPACE/self-test"
```

## 交付

返回最终 PDF 和简明摘要。提及有意的限制，例如纯图像页、不支持的动态表单、签名，或保留的源文件缺陷。除非用户要求，否则不要交付构建脚本、提取文本、JSON 报告、渲染图、运行时文件或临时产物。
