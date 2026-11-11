# DOCX CLI 规范

在为 `make --spec`、`edit` 或 `review` 编写 JSON 之前阅读本文件。仅使用
已文档化的字段，并将规范写在按轮次限定的
`PILOTDECK_WORK_DIR` 下，切勿写在用户文件旁边。

高级编辑/审阅先查询实时模式：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command edit
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

直接 `make --spec` 时使用内置策略即可，不需要先 `prepare`。高级
`create`/编辑工作流若带验收清单，`style_policy` 必须与 `prepare` 冻结的
策略匹配。

- 内置模式为
  `{"mode":"builtin","template":"neutral-document-v1"}`。当用户未提供视觉说明时，它是默认值。
  它锁的是**模板本身**：不允许 `style_overrides`，也不允许表格块上的 `style`
  （网格/边框样式属于模板）。但**块级配色可以改**——标注块的
  `fill`/`accent`、表格的 `header_fill`/`header_text_color`/`border_color`
  都允许：用内置调色板的角色名，或一个能过对比度门禁的自定义 hex（见 1.1）。
- 用户模式为
  `{"mode":"user","source":"explicit-requirements|reference-template|existing-document"}`。
  `explicit-requirements` 来源还要求非空的 `requirements`
  数组，其中包含用户的具体说明。
- 诸如 “formal report” 或 “professional document” 这样的笼统目标
  不构成明确的视觉要求。

### 1.1 语义角色色（builtin 模式的块级配色）

内置模式下改块级颜色，可以写**语义角色名**、该名字**在当前模板下**的等价 hex，
或一个自定义的六位 hex。名字大小写不敏感，`#` 可省略。

自定义 hex 是"强调色"通道，只作用于强调位（标注底色/色条、表头底色、表头字色、
表格边框），并且必须和它实际所在的底色拉开对比度：

| 用途 | 最低对比度 |
| --- | --- |
| 文字（标注文字与其底色、表头字色与表头底色） | 4.5:1 |
| 色条、实底等非文字图形 | 3:1 |
| 表格边框 | 1.5:1 |

不达标返回 `style-contrast-too-low`，`error` 里会给一个可用的近似色
（例如"可改用 #736B63"）。写法不是六位 hex 时返回 `builtin-style-override`。
`success`/`warning`/`danger`/`info` 的语义不能被自定义 hex 顶替——
自定义色只是颜色，不会变成"风险红"。

**名字按当前模板解析**：`neutral-document-v1` 用下表的中性值；
主题（`themed-v1`）用该主题自己的 `primary`/`accent`/`rule`/`soft`/`ink`/`muted`，
所以同一份 spec 换主题后整体仍然协调。`success`/`warning`/`danger`/`info`
四个语义色全模板统一，保证 Word / PPT / PDF / Excel 里的"风险红"是同一个红。

| 名字 | 中性模板 hex | 用途 |
| --- | --- | --- |
| `ink` | `000000` | 正文墨色 |
| `muted` | `595959` | 次要文字 |
| `rule` | `D9D9D9` | 分隔线、表格边框 |
| `soft` | `F2F2F2` | 浅底、标注填充、斑马纹 |
| `white` | `FFFFFF` | 反白文字、白色底 |
| `onPrimary` | `FFFFFF` | 主色底上的文字 |
| `primary` | `1F4E79` | 主色：表头底、标题 |
| `accent` | `8C6D1F` | 强调色 |
| `success` | `157F3D` | 通过、完成 |
| `warning` | `B45309` | 提醒、待办 |
| `danger` | `B42318` | 风险、错误 |
| `info` | `1F5FA9` | 提示、说明 |

主题下另有 `support`（辅助色）。典型搭配：
`{"accent":"warning","fill":"soft"}` 的提醒框；
`{"header_fill":"primary","header_text_color":"onPrimary","border_color":"rule"}` 的表格。
角色色**不**放开字体、字号、行距、页边距、表格 `style`、run 的 `color`，
这些仍然属于模板，内置模式下照旧报错。用户模式不受此限制，可写任意六位 hex。

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
包括中文目录和标注标签。内置模式固定写 `Microsoft YaHei`（`archive` 主题为 `SimSun`），
不搜索系统字体。页眉和页脚值可以是字符串，
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
{"type": "subtitle", "text": "Decision meeting · 13 July 2026", "alignment": "left"}
```

两者默认居中；需要左对齐（长标题、正文大标题）时加 `"alignment": "left"`，
可选 `left` / `center` / `right`。图注跟随图片对齐。

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
{"type": "bullet", "text": "Second-level detail", "level": 2}
```

每个列表项创建一个块。不要把多个项用换行放在一个段落中。
只有两级（`level` 取 1 或 2）；一级用默认列表样式，二级缩进一级。

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
  "accent": "muted"
}
```

`accent` 是左边线颜色，`fill` 是底色且可选；中性标注可省略 `fill`。
用户模式下两者是六位 RGB 十六进制值；内置模式下用调色板的名字或等价 hex
（例如 `{"accent":"warning","fill":"soft"}`），也可以给自定义强调色：
`fill` 要和墨色 ≥ 4.5:1（深底配浅字最容易踩坑），`accent` 要和纸面 ≥ 3:1。
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

勾选框用 Word 原生符号（`<w:sym w:font="Wingdings">`）绘制：`checked: true` 是打了勾的方框，
`false` 是空方框。不要改回 `☐`/`☒`（U+2610/U+2612）——微软雅黑、宋体和随包 Noto Sans SC
都没有这两个字形，Word 会退化成两个一模一样的空框。Pages / LibreOffice 不渲染 `w:sym`，
在这两个软件里勾选框会缺失（正文按缩进仍可读），交付前用 Word 打开核对。

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
  "alignment": "left",
  "caption": "Figure 1. Delivery timeline",
  "alt_text": "Milestones from discovery through launch"
}
```

默认居中；`alignment` 可选 `left` / `center` / `right`，图注与图片对齐。

相对路径从 JSON 文件所在目录解析。远程 URL 会被拒绝。
用户聊天上传的图片在 `inbox/<批次>/`，路径写在用户消息的
`[Files attached by user…]` 清单里；**优先使用该绝对路径**，后续轮次到历史消息里找，不要全盘搜索。
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
  "variant": "three-line",
  "zebra": false,
  "cell_valign": "center",
  "repeat_header": true,
  "caption": "Table 1. Launch readiness"
}
```

规则：

- 每一行必须包含与表头相同数量的单元格。
- `column_widths` 包含正的相对权重，每列一个。**默认不要传**：省略时创建器按每列
  最长内容自动分配（1.0–6.0 权重），比手写英寸/权重更不容易出错。
  只有两种情况才显式指定：列数 ≥6，或明显需要牺牲某一列（如"表名很长、其余都是短词"）。
  英文表名、代码式字段名（`S1_REPORT_PERFORM_RELATIONS`）属于长单词，列给窄了
  LibreOffice 会在单词中间硬断成 `…RELAT` / `IONS`；这种情况下让自动分配接管，
  或把该列权重调到其它列的 2–3 倍。
- `alignments` 包含 `left`、`center` 或 `right`，每列一个。
- 创建器以 DXA 写入显式的表格、网格和单元格宽度。
- 行会自动扩展；不要用空行模拟固定高度。
- 对跨页数据表将 `repeat_header` 设为 `true`。
- 内置模式的模板固定为中性表格样式：它拒绝表格块上的 `style`。但表头底色、
  表头字色和边框颜色属于"这份文档的配色"，允许改，前提是取自内置调色板：
  例如 `{"header_fill":"primary","header_text_color":"white","border_color":"rule"}`。
  也可以写自定义 hex（`{"header_fill":"#1F4E79","header_text_color":"#FFFFFF"}`），
  前提是字色与表头底色 ≥ 4.5:1，否则返回 `style-contrast-too-low`。
  省略这些字段则沿用模板默认（白色单元格、加粗黑色表头、中性边框）。
- 用户模式在这些字段实现所提供样式时可以使用它们。
  支持的表格样式为 `Table Grid`、`Light Grid`、`Light Shading`、
  `Light Shading Accent 1`、`Light Grid Accent 1` 和
  `Medium Shading 1 Accent 1`。任何其他值都是规范错误，而不是
  静默回退。
- 题注放在表格之前，并在分页时与表格保持在一起。

三个可选的局部样式（生成时写，不用二次 edit）：

| 字段 | 取值 | 效果 |
| --- | --- | --- |
| `variant` | `grid`（默认）/ `three-line` | 三线表：顶线、表头下线、底线，无竖线与内部横线；医学论文/病例报告的常规表格式 |
| `zebra` | `true` / `false`（默认） | 数据行隔行浅底（`soft`），只对数据行生效，表头不参与 |
| `cell_valign` | `center`（默认）/ `top` | 单元格垂直对齐；多行文本或长字段时用 `top` 更整齐 |

`variant: "three-line"` 与 `zebra: true` 互斥（会报 `invalid-spec`）；
三线表仍可配 `header_fill`，但通常不需要。

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

当 `python-docx` 往返可能丢失内容时，`edit` 会阻断对包敏感的文档。不要
调用 `fallback-patch` 或自行修补 OOXML；报告限制。仅在用户明确理解并接受
内容丢失风险后才使用 `--allow-lossy`。

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
