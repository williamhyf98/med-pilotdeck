---
name: docx
description: 读取、创建、编辑、审阅、比较、净化、渲染、转换并校验工作区 Microsoft Word .docx 文档。输入或交付物是 .docx 时使用本技能，包括把对话里刚生成的方案、病例报告导出为 Word。新建 DOCX 使用结构化工具 docx_make；已有 DOCX 转 PDF 优先使用注册工具 office_to_pdf；其余 Word 操作使用捆绑的 docx.sh。
---

# Word DOCX

新建 DOCX 时调用结构化工具 `docx_make`，不要拼接 Bash 或自行查找脚本。已有文档的检查、编辑、审阅和高级 QA 才使用系统登记的 DOCX Skill 业务入口。

`docx.sh` 会自己定位完整的隔离运行时和捆绑字体。本地运行时未就绪时会返回
JSON 错误「交付包不完整」；此时停止并报告，不要改走其它实现。

## Office 转 PDF

已有 DOCX 要转换成 PDF 时，优先调用注册工具 `office_to_pdf`：

```text
office_to_pdf(
  input_file="source.docx",
  output_file="exports/result.pdf"
)
```

该工具通过统一的 Office Renderer 执行，Mac 和 node12 都不直接调用
LibreOffice。不要使用 `pdf.sh make` 重新排版 DOCX，不要直接调用 `soffice`。
下面的 `docx.sh convert-pdf` 仅保留给兼容脚本和维护测试；如果
`office_to_pdf` 不可用，应报告 Renderer 未配置或不可用，不要绕过它改走本机
LibreOffice。

## Agent 可用表面

- 创建新 DOCX：只调用 `docx_make`
- `docx_make` 的输入使用 `title`、`body`、`body_file_path`、`markdown_path`、
  `spec_path`、`output_path`、`force` 和 `timeout_ms`
- 需要创建声明式内容时，用 `write_file` 写入 `scratch/` 下的 `.md` / `.json`，
  再把相对任务路径传给 `docx_make`

- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

需要确认能力或复杂规范时，调用已登记的查询入口：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command edit
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command review
```

不要调用 `docx.sh --help`，也不要通过 `find`、`grep` 或读取脚本源码猜测参数。

## 输出位置

交付文件写入本任务 `exports/`；中间文件写入 `scratch/`。需要目录时使用文件工具或由技能创建，不调用 `mkdir`。

例如用户要「病例报告.docx」：`output_path: "exports/病例报告.docx"`。

## 新建 Word

常见新建只调用 `make`：

```json
{
  "title": "病例报告",
  "body": "【病例报告】",
  "output_path": "exports/病例报告.docx"
}
```

可用参数：

- `--title`
- `--body` 或 `--body-file`
- `--markdown`
- `--spec`
- `--out`
- `--force`（仅在明确需要替换已有输出时）

`make` 会使用内置 A4 模板和捆绑 Noto Sans SC，创建并校验 DOCX。成功 JSON
中的 `output` 是用户交付文件。页面 PNG 不是离线现场的必需能力；没有预览也
不要安装渲染后端。`preview`、`audit` 和内部候选只用于检查，不要交付。

如果需要目视核对页面，必须把**同一次 `make` 返回 JSON 中 `preview` 数组的完整路径原样**
传给 `read_file`，不要根据 `output`、工作目录或哈希片段自行拼接路径。一次生成多个 DOCX
时，按每个 `make` 结果逐个读取对应的 `page-1.png`；不要把不同结果中的路径片段混合。

## 把对话里已有的方案做成 Word

`docx.sh` **读不到聊天记录**。用户说「把以上/刚才的救治方案（或病例报告）
生成 Word」时，上一轮完整内容就在当前对话里：直接使用原文，不要让用户
再贴一遍，不要摘要替代原文，不要重写一版。

长文不要塞进 `--body "..."`。用 `write_file` 把完整原文写成 Markdown，
再交给 `make`：

```json
{
  "title": "救治方案",
  "markdown_path": "scratch/docx/content.md",
  "output_path": "exports/救治方案.docx"
}
```

Markdown 中：

- `#` / `##` / `###` 转为 Word 标题层级；
- `-` / `*` 转为项目符号；
- `1.` / `1)` 转为编号项；
- 普通段落保持正文顺序。

`write_file` 只用于 `.md` / `.json` 声明式输入。

## 插入用户上传的图片

Word 插图只能用磁盘路径，不能用聊天气泡里的图。创面照等**优先**用本会话
（含更早轮次）用户上传的附件：

```text
[Files attached by user and available for reading in the project:]
- name.jpg: /…/inbox/<批次id>/1-name.jpg
```

文件就在工作区 `inbox/<批次id>/`（附件清单里的绝对路径，常见为 `$WS/inbox/...`）。直接把
**绝对路径**写进 spec 的 image block（见 [specifications.md](references/specifications.md)）。
不要 `find /`，不要下载，不要为此编写 Python，不要翻 `docx_cli` / `docxlib` 源码猜字段。后续轮次清单可能不再出现，到历史用户消息或 `image_paths_used` 里找同一路径。

复杂表格、图片、封面或精确样式可使用 `--spec`。只使用
[specifications.md](references/specifications.md) 已声明的字段；不要为新建
文档改走未声明的替代路径。新建细则见
[creation.md](references/creation.md)。

## 检查或读取

以下是高级维护能力的兼容入口；新建文档不要通过这些命令完成。

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "inbox/source.docx" \
  --out "$PILOTDECK_WORK_DIR/docx/qa/inspection.json"
```

按需使用 `--summary`、`--search`、`--location`。只读任务不要创建新的 DOCX。

## 改已有 Word

现有文档的修改、审阅和定稿能力保留。先读取
[workflows.md](references/workflows.md)；修改前先 `inspect`，保留源文件，
结果使用新的文件名。除非用户明确要求替换，不要覆盖输入。

### 定向编辑

对 `edit` 使用已登记的参数，把 patch JSON 放在本轮 `scratch/` 下。
调用 `resolve-latest` 取得最新版本，然后按工作流完成 edit、QA、preflight
和 deliver。

### 批注与修订

`review` 用于添加批注和修订替换；`finalize` 用于接受/拒绝修订和移除批注。
先阅读 [ooxml-and-safety.md](references/ooxml-and-safety.md)，并查询
技能参考文档中的声明式字段。

### 其他保留能力

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare --before old.docx --after new.docx --out "$PILOTDECK_WORK_DIR/docx/qa/compare.json"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize --input source.docx --out "$PILOTDECK_WORK_DIR/docx/qa/candidate.docx"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" refresh-toc --input source.docx --out "$PILOTDECK_WORK_DIR/docx/qa/candidate.docx" --render-dir "$PILOTDECK_WORK_DIR/docx/qa/render"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate --input source.docx
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit --input source.docx --out "$PILOTDECK_WORK_DIR/docx/qa/audit.json"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render --input source.docx --out-dir "$PILOTDECK_WORK_DIR/docx/qa/render"
```

兼容脚本：把已有 Word 转成 PDF：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" convert-pdf \
  --input source.docx \
  --out "$PWD/exports/result.pdf"
```

`convert-pdf` 优先把 DOCX 内容上传到配置的 Office Renderer（默认是
node12 的 19400 端口），由受控的 LibreOffice Worker 完成转换；没有配置远程
Renderer 时直接报告不可用，不回退本机 LibreOffice。输入和输出必须是不同文件，已有 PDF
只有显式传 `--force` 才会替换。

若命令返回 `unsupported` 或 `blocked`，说明限制并停止。

## 校验

`make` 已包含 DOCX 包完整性检查和结构审计。对已有文档或编辑结果仍需：

1. `validate` 检查 ZIP / OOXML；
2. `audit` 检查结构、样式、表格和无障碍问题。

不要把 `render` / 页面 PNG 当成交付前提。若 `render` 返回
`unsupported` 或 `render-backend-unavailable`，报告结构校验结果并停止，
不要安装任何软件。

详细门禁见 [design-and-layout.md](references/design-and-layout.md) 和
[workflows.md](references/workflows.md)。

## 交付

只返回用户要的最终 `.docx` 和简短说明。不要交付 Markdown、spec JSON、
预览图、QA 报告、候选文件或运行时文件，除非用户明确要求。
