---
name: docx
description: 读取、创建、编辑、审阅、比较、净化、渲染并校验工作区 Microsoft Word .docx 文档。输入或交付物是 .docx 时使用本技能，包括把对话里刚生成的方案、病例报告导出为 Word。所有转换只通过捆绑的 docx.sh 完成。
---

# Word DOCX

只用 `read_skill` 返回的 `<path>` 所在目录。那就是本技能根目录。不要用
`$PILOT_HOME/skills/docx`，不要在用户 skills 目录里查找本技能。

```bash
DOCX_SKILL_ROOT="$(dirname "<path>")"
```

`docx.sh` 会自己定位完整的隔离运行时和捆绑字体。本地运行时未就绪时会返回
JSON 错误「交付包不完整」；此时停止并报告，不要改走其它实现。

## Agent 可用表面

- 只调用本技能的 `docx.sh`
- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

## 输出位置

用户给了路径就用用户的路径。否则写到当前工作目录下的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

例如用户要「病例报告.docx」：
`--out "$PWD/exports/病例报告.docx"`。

## 新建 Word

常见新建只调用 `make`：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" make \
  --title "病例报告" \
  --body "【病例报告】" \
  --out "$PWD/exports/病例报告.docx"
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

## 把对话里已有的方案做成 Word

`docx.sh` **读不到聊天记录**。用户说「把以上/刚才的救治方案（或病例报告）
生成 Word」时，上一轮完整内容就在当前对话里：直接使用原文，不要让用户
再贴一遍，不要摘要替代原文，不要重写一版。

长文不要塞进 `--body "..."`。用 `write_file` 把完整原文写成 Markdown，
再交给 `make`：

```bash
mkdir -p "$PWD/scratch/qa"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" make \
  --title "救治方案" \
  --markdown "$PWD/scratch/qa/content.md" \
  --out "$PWD/exports/救治方案.docx"
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

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" \
  --out "$PWD/scratch/qa/inspection.json"
```

按需使用 `--summary`、`--search`、`--location`。只读任务不要创建新的 DOCX。

## 改已有 Word

现有文档的修改、审阅和定稿能力保留。先读取
[workflows.md](references/workflows.md)；修改前先 `inspect`，保留源文件，
结果使用新的文件名。除非用户明确要求替换，不要覆盖输入。

### 定向编辑

对 `edit` 先运行 `prepare --existing-document`，再查询
`schema --command edit`，把 patch JSON 放在本轮 `PILOTDECK_WORK_DIR` 下。
调用 `resolve-latest` 取得最新版本，然后按工作流完成 edit、QA、preflight
和 deliver。

### 批注与修订

`review` 用于添加批注和修订替换；`finalize` 用于接受/拒绝修订和移除批注。
先阅读 [ooxml-and-safety.md](references/ooxml-and-safety.md)，并查询
`schema --command review`。

### 其他保留能力

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare --before old.docx --after new.docx --out "$PWD/scratch/qa/compare.json"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize --input source.docx --out "$INTERNAL_CANDIDATE"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" refresh-toc --input source.docx --out "$INTERNAL_CANDIDATE" --render-dir "$INTERNAL_RENDER_DIR"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate --input source.docx
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit --input source.docx --out "$PWD/scratch/qa/audit.json"
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render --input source.docx --out-dir "$PWD/scratch/qa/render"
```

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
