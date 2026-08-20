# DOCX CLI 规范

在为 `create`、`edit` 或 `review` 编写 JSON 之前阅读本文件。仅使用
已文档化的字段，并将规范写在按轮次限定的
`PILOTDECK_WORK_DIR` 下，切勿写在用户文件旁边。

先查询实时模式：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

解析器是严格的。未知字段、块和操作会失败，而不是被忽略。
写文档的命令默认拒绝替换既有输出。仅当用户明确授权替换
不同的输出或内部候选时才传递
`--overwrite`；输入和输出路径仍必须
不同。最终源替换是单独的交付模式，并且要求
当前请求授权 `--replace-source`。

## 目录

1. 创建规范
2. 内容块
3. 富文本 run
4. 表格规范
5. 编辑补丁
6. 审阅规范

## 1. 创建规范

```json
{
  "style_policy": {
    "mode": "builtin",
    "template": "neutral-document-v1"
  },
  "document_structure": {
    "archetype": "simple"
  },
  "locale": "en-US",
  "page": "letter",
  "orientation": "portrait",
  "margins_inches": {
    "top": 0.8,
    "right": 0.8,
    "bottom": 0.8,
    "left": 0.8
  },
  "metadata": {
    "title": "Program Readiness Brief",
    "subject": "Launch decision",
    "author": "Operations Team",
    "keywords": "launch, readiness",
    "category": "Internal",
    "comments": "Prepared for review"
  },
  "content": []
}
```

`style_policy` 必须与 `prepare` 冻结的策略匹配。

- 内置模式为
  `{"mode":"builtin","template":"neutral-document-v1"}`。当用户未提供视觉说明时，它是默认值。
  它不允许
  `style_overrides` 或块级颜色/样式。
- 用户模式为
  `{"mode":"user","source":"explicit-requirements|reference-template|existing-document"}`。
  `explicit-requirements` 来源还要求非空的 `requirements`
  数组，其中包含用户的具体说明。
- 诸如 “formal report” 或 “professional document” 这样的笼统目标
  不构成明确的视觉要求。

支持的页面值：`a4` 和 `letter`。支持的方向：`portrait` 和 `landscape`。

`document_structure` 也必须与 `prepare` 匹配。普通文档使用简单结构：

```json
{"document_structure": {"archetype": "simple"}}
```

仅对封面 + 目录 + 正文文档使用正式报告结构：

```json
{"document_structure": {"archetype": "formal-report"}}
```

正式结构要求第一个内容块为 `title`，恰好
一个 `toc` 块，以及其后的正文内容。创建器会在目录前插入恰好一个
分页，并在其后再插入一个。不要在目录周围添加手动重复
分页。

用户模式可以包含集中的 `style_overrides` 对象，其中有
`body_font`、`east_asia_font`、`body_size`、`title_size`、`title_color`、
`heading_color`、三个 `heading_sizes`、`normal_alignment`、
`normal_first_line_indent_inches`、`normal_line_spacing_points`、
`table_style`、表格表头/边框颜色、标注填充/边框颜色，以及
`space_after`。不要把这些决策分散到内容块中。创建器会将缺失的 CJK 字体映射到已安装的平台回退。

使用实际内容区域设置，例如 `zh-CN` 或 `en-US`；与区域相关的默认值
包括中文目录和标注标签。页眉和页脚值可以是字符串，
也可以是带有 `text` 和 `alignment`（`left`、`center` 或 `right`）的对象。`{PAGE}`
和 `{NUMPAGES}` 会创建真正的域。

默认不要包含页眉、页脚、`{PAGE}` 或 `{NUMPAGES}`。仅当当前请求明确要求它们、且 `prepare`
冻结了相应许可时，它们才有效。带页码的页脚同时需要
`--allow-footer` 和 `--allow-page-numbers`。对于编辑，传递冻结的
验收清单；既有重复内容会被保留，而
`set_header` 和 `set_footer` 仍受许可门控。

`update_fields_on_open` 是可选的，默认为 `false`。不要启用它
来填充目录。它可能使 Word 在打开文件时显示警告。
仅当用户明确希望 Word 在打开时重新计算域
并接受该提示时才启用；最终交付需要单独的
`--allow-update-fields-on-open` 选择加入。

## 2. 内容块

### 标题与副标题

```json
{"type": "title", "text": "Program Readiness Brief"}
{"type": "subtitle", "text": "Decision meeting · 13 July 2026"}
```

### 标题

```json
{"type": "heading", "level": 1, "text": "Recommendation"}
```

标题级别必须为 1–3。

### 段落

```json
{"type": "paragraph", "text": "The program is ready to proceed."}
```

仅当整个段落需要加粗处理时才使用 `"bold": true`。对局部强调使用富文本 run。
内置模式不允许 `style` 字段。

### 项目符号与编号项

```json
{"type": "bullet", "text": "Confirm the release owner"}
{"type": "numbered", "text": "Approve the deployment window"}
```

每个列表项创建一个块。不要把多个项用换行放在一个段落中。

### 引文

```json
{"type": "quote", "text": "A short quotation or attributed statement."}
```

### 标注

```json
{
  "type": "callout",
  "label": "Decision",
  "text": "Proceed after the final readiness review.",
  "accent": "595959"
}
```

颜色是六位 RGB 十六进制值。`fill` 是可选的；中性标注可省略它。
保持标注简短。

### 检查清单

```json
{
  "type": "checklist",
  "items": ["Confirm owner", "Confirm date", "Archive evidence"],
  "checked": [true, false, false]
}
```

输出是可见的检查清单，而不是交互式 Word 内容控件。

### 定义列表

```json
{
  "type": "definition_list",
  "items": [
    {"term": "Owner", "definition": "Release Management"},
    {"term": "Status", "definition": "Ready with conditions"}
  ]
}
```

### 来源列表

```json
{
  "type": "source_list",
  "items": [
    "Readiness review, 10 July 2026",
    "Risk register, revision 4"
  ]
}
```

### 图像

```json
{
  "type": "image",
  "path": "figures/timeline.png",
  "width_inches": 5.5,
  "caption": "Figure 1. Delivery timeline",
  "alt_text": "Milestones from discovery through launch"
}
```

相对路径从 JSON 文件所在目录解析。远程 URL 会被拒绝。
栅格图像在插入前会被解码，透明度会展平到
白色背景上，完全空白或无效的图像会被拒绝。

### 目录与域

```json
{
  "type": "toc",
  "title": "Contents",
  "levels": [1, 2, 3],
  "page_break_after": true
}
```

```json
{
  "type": "field",
  "instruction": "DATE \\@ \"yyyy-MM-dd\"",
  "placeholder": "Update field",
  "alignment": "right"
}
```

支持的域前缀为 `TOC`、`PAGE`、`NUMPAGES`、`DATE` 和 `TIME`。在渲染输出中核验显示的域结果。对于 TOC 块，在标题稳定后运行 `refresh-toc`。仅创建会插入活动域和显式占位符；预检会拒绝所需目录，直到可见缓存条目和页码被填充。

### 分页与间隔

```json
{"type": "page_break"}
{"type": "spacer", "points": 8}
```

谨慎使用间隔。优先使用段落样式间距。

## 3. 富文本 run

当需要局部强调时，使用 `runs` 而不是 `text`：

```json
{
  "type": "paragraph",
  "runs": [
    {"text": "Status: ", "bold": true},
    {"text": "Ready", "bold": true, "color": "1F4E79"},
    {"text": " with two open actions.", "italic": false}
  ]
}
```

支持的 run 字段为 `text`、`bold`、`italic` 和 `underline`。用户样式
模式在这些值遵循用户具体要求时，还可以额外使用 `color` 和 `size_pt`。

将富 run 与 `title`、`subtitle`、`heading`、`paragraph`、`bullet`、`numbered`、`quote` 和 `callout` 块一起使用。避免对大多数正文使用直接格式；重复格式属于冻结的样式策略。

## 4. 表格规范

```json
{
  "type": "table",
  "headers": ["Workstream", "Owner", "Status"],
  "rows": [
    ["Security review", "Security", "Complete"],
    ["Release approval", "Operations", "Pending"]
  ],
  "column_widths": [4, 2, 1.5],
  "alignments": ["left", "left", "center"],
  "repeat_header": true,
  "caption": "Table 1. Launch readiness"
}
```

规则：

- 每一行必须包含与表头相同数量的单元格。
- `column_widths` 包含正的相对权重，每列一个。
- `alignments` 包含 `left`、`center` 或 `right`，每列一个。
- 创建器以 DXA 写入显式的表格、网格和单元格宽度。
- 行会自动扩展；不要用空行模拟固定高度。
- 对跨页数据表将 `repeat_header` 设为 `true`。
- 内置模式始终使用中性模板：白色单元格、加粗黑色
  表头和中性边框。它会拒绝表格块上的 `style`、`header_fill`、
  `header_text_color` 和 `border_color`。
- 用户模式在这些字段实现所提供样式时可以使用它们。
  支持的表格样式为 `Table Grid`、`Light Grid`、`Light Shading`、
  `Light Shading Accent 1`、`Light Grid Accent 1` 和
  `Medium Shading 1 Accent 1`。任何其他值都是规范错误，而不是
  静默回退。
- 题注放在表格之前，并在分页时与表格保持在一起。

## 5. 编辑补丁

```json
{
  "operations": [
    {
      "action": "replace_text",
      "match": "2025 plan",
      "replacement": "2026 plan",
      "occurrence": "all"
    },
    {
      "action": "insert_after",
      "match": "Recommendation",
      "text": "Proceed after final approval.",
      "style": "Normal",
      "occurrence": 1,
      "location": "body"
    },
    {
      "action": "insert_image",
      "match": "Recommendation",
      "path": "figures/timeline.png",
      "placement": "after",
      "width_inches": 5.5,
      "caption": "Figure 1. Delivery timeline",
      "alt_text": "Milestones from discovery through launch",
      "occurrence": 1,
      "location": "body"
    },
    {
      "action": "set_style",
      "match": "Risk summary",
      "style": "Heading 1"
    },
    {
      "action": "append_paragraph",
      "text": "Appendix note.",
      "style": "Normal"
    },
    {"action": "add_page_break"},
    {
      "action": "set_metadata",
      "title": "Updated Program Brief",
      "author": "Operations Team"
    },
    {"action": "set_header", "text": "CONFIDENTIAL", "alignment": "right"},
    {"action": "set_footer", "text": "Page {PAGE} of {NUMPAGES}", "alignment": "center"},
    {"action": "set_table_cell", "table": 1, "row": 2, "column": 3, "text": "Complete"},
    {"action": "append_table_row", "table": 1, "values": ["Legal review", "Legal", "Pending"]}
  ]
}
```

支持的操作：

- `replace_text`：跨相邻 run 匹配，同时保留第一个和最后一个 run 的格式。
- `insert_after`：在选定的匹配段落之后插入一个段落。
- `insert_image`：在选定的匹配段落之前或之后插入规范化的本地图像，
  可带可选题注和替代文本。
- `delete_paragraph`：删除包含 `match` 的选定段落。
- `set_style`：为选定的匹配段落设置 Word 样式。
- `append_paragraph`：追加一个段落。
- `add_page_break`：追加分页。
- `set_metadata`：更改受支持的核心属性。
- `set_header` 和 `set_footer`：用可选页面域更新重复故事文本。
- `set_table_cell`：更新从 1 开始的表格、行和列。
- `append_table_row`：追加与既有列数匹配的值。

使用 `occurrence: "all"`、`occurrence: "first"` 或从 1 开始的整数。对于
`replace_text`，occurrence 按文档顺序计算互不重叠的文本匹配，
包括同一段落内的重复匹配。对于
段落级操作，它计算匹配段落。当默认
目标含糊时，操作返回 `partial`；添加 `occurrence` 或来自
`inspect` 的位置前缀。缺失目标也会返回 `partial`，除非
显式设置 `allow_missing: true`。切勿将意外的零
`affected` 计数解释为成功。

当 `python-docx` 往返可能丢失内容时，`edit` 会阻断对包敏感的文档。优先使用 `fallback-patch`；仅在用户明确接受后才使用 `--allow-lossy`。

## 6. 审阅规范

```json
{
  "comments": [
    {
      "match": "The program is ready",
      "text": "Add the evidence source for this conclusion.",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ],
  "tracked_replacements": [
    {
      "match": "launch in May",
      "replacement": "launch in June",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ]
}
```

使用简短且唯一的匹配字符串。含糊匹配会返回 `partial`，直到提供从 1 开始的 `occurrence`。捆绑批注附加到主体中的包含段落。跟踪替换要求匹配文本存在于一个 run 中；跨 run 匹配会返回带有回退指导的 `unsupported`，而不是静默变成干净编辑。
