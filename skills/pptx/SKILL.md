---
name: pptx
description: 创建、读取、审计和安全修改 Microsoft PowerPoint .pptx 演示文稿。输入或交付物是 .pptx 时使用本技能。已有 PPTX 转 PDF 时使用注册工具 office_to_pdf；其余转换只通过捆绑的 pptx.sh 完成。
---

# PowerPoint PPTX

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
PPTX_SKILL_ROOT="$(dirname "<path>")"
```

`pptx.sh` 会定位完整的隔离运行时和内置布局库。运行时未就绪时会返回
「交付包不完整」；此时停止并报告，不要改走其它实现。

## PPTX 转 PDF

已有 PPTX 要转换为 PDF 时，调用注册工具 `office_to_pdf`，不要把幻灯片内容
重新写成 PDF，也不要直接调用 LibreOffice。该工具统一通过 node12 Office
Renderer 执行。

## Agent 可用表面

- 只调用本技能的 `pptx.sh`
- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

## 输出位置

用户给了路径就使用该路径；否则写到当前工作目录的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

中间 Markdown/JSON 放在 `scratch/qa/` 或 `PILOTDECK_WORK_DIR`，不要交付。

## 新建 PPTX

普通新建只调用 `make`。

短演示可以直接传正文：

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" make \
  --title "战创伤四级救治" \
  --body "现场处置。

紧急救治。

专科救治。" \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

长演示先把完整内容写成 Markdown，再传路径：

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" make \
  --title "战创伤四级救治" \
  --markdown "$PWD/scratch/qa/slides.md" \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

可用参数：

- `--title`
- `--body` / `--body-file`
- `--markdown`
- `--spec`
- `--locale`（默认 `zh-CN`）
- `--footer`
- `--theme`（默认 `clinical`，见下节）
- `--out`
- `--force`（只有用户明确要求替换已有输出时）

### `--markdown` 的映射规则

| Markdown | 生成的页 |
| --- | --- |
| 第一个 `# 标题`（还没有 `--title` 时） | 封面标题 |
| 后续 `# 标题`，下面**没有正文** | 分节页（只有标题） |
| 后续 `# 标题`，下面**有正文或列表** | 内容页（标题 + 正文），不会丢内容 |
| `## 标题` 及更深 | 内容页 |
| `- 列表项` | 当前页的条目 |
| 普通段落 | 当前页的正文；同一段的多行会合并 |
| 管道表格（表头 + `| --- |` 分隔行） | 表格页；表格正上方的 `##` 标题直接成为该页标题 |
| 表格后面的正文 | 另起一页，不会和表格挤在一起 |

需要图表页、时间线、对比页、指标页、病例页、证据页或影像页时，用 `--spec` 的
`slides[].type`；这些版式没有 Markdown 简写。

`make` 使用内置 16:9 布局库、PptxGenJS 和 `Microsoft YaHei` 字体声明，运行
OOXML 检查和结构审计。成功 JSON 的 `output` 是用户交付文件。

页面 PNG 不是离线现场硬依赖。Office Renderer 不可用时 `preview` 为空并带
warning，但 PPTX 仍可交付；不要为此安装任何软件。

## spec 版式速查

`slides[].type` 决定版式，共 16 种：

| type | 用途 | 关键字段 |
| --- | --- | --- |
| `title` / `section` / `closing` | 封面 / 分节 / 结尾 | `title`、`subtitle`、`meta` |
| `content` / `statement` / `split` / `two-column` | 正文、单句主张、图文左右、双栏 | `items`、`body`、`left`/`right` |
| `metric`（别名 `metrics`） | 2–4 个大数字 | `metrics[]`：`{value, label, detail}` |
| `comparison` | 左右对照 | `left`/`right`：`{heading, items}`、`takeaway` |
| `timeline` | 3–5 步时间线 | `steps[]`：`{label, detail}` |
| `chart` | 原生图表 | `chartType`、`series[]`：`{name, labels, values}`、`takeaway` |
| `table` | 原生表格 | `rows`（含表头行） |
| `quote` | 引文 | `quote`、`attribution` |
| `case` | 病例页 | `profile[]`：`{label, value}`；`left`/`right`：`{heading, items}` |
| `evidence` | 证据与推荐页 | `verdict`、`items[]`：`{level, label, detail}` |
| `imaging` | 影像页 | `image`：`{path, caption}`、`findings[]`、`impression` |

**图表种类写 `chartType`，不要写 `type`**（`type` 是版式名）。取值
`bar`、`column`（`bar` + 竖直方向的别名）、`horizontal-bar`、`line`、`area`、`pie`、
`doughnut`、`radar`、`scatter`、`bubble`。写错会直接报错，不会生成空图表；
`series` 为空同样报错。

`imaging` 的图片必须是工作区里的本地文件（禁止 http），缺失时画虚线占位并标注
「影像未提供」，其余文字照常输出。

## 配色主题

六套共享主题已接入 `make` 与构建器，ID、中文名和别名都可用；指定主题会
同时应用配色、深底语义色、字体角色和少量字号/行距乘数，版式结构暂不变。
**未指定 `--theme` 时就是 `clinical`（临床晨光）**，与显式写 `--theme clinical`
逐页输出一致；要复现改造前的旧观感用隐藏主题 `--theme clinical-legacy`。
`make` 的默认字体为 `Microsoft YaHei`；`archive`（衬线主题）用 `SimSun`。
两者都是"Windows 自带、Office for Mac 也自带"的名字，因此医生本机打开无需装字体。
字体变化可能影响换行，交付前应检查渲染图。可选值先用 `themes` 查：

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" themes
```

| 主题（ID） | 中文名 / 别名 | 适用 |
|------|------|------|
| `clinical` | 临床晨光（临床、晨光） | **默认主题**；门诊、出院、影像报告 |
| `academic` | 青黛循证（循证、学术） | 学术汇报、文献与 meta 分析 |
| `trauma` | 松风急救（急救、战创伤） | 战创伤救治方案、分诊与流程 |
| `archive` | 宣纸病案（宣纸、病案） | 长病例、病史整理、回顾性材料；衬线字体 |
| `edu` | 杏林宣教（宣教、健康教育） | 患者教育与公众材料 |
| `mono` | 灰阶印刷（灰阶、黑白） | 黑白打印或低色准投影 |

旧参数兼容：`--theme vital` 现解析为 `clinical`（新版配色）并在返回 JSON
给出 `themeWarning`；要复现旧影像检验配色用隐藏主题 `vital-legacy`，复现
旧默认配色用 `clinical-legacy`。两个旧色板的输出与改造前逐页一致。

### 单页强调色（`slides[].accent`）

整篇主题之外，可以给**某一页**换强调色，用来标记"这页是风险 / 这页是结论"。
只影响该页强调元素（大数字、色条、图表首序列），版式、字体、背景都不变：

```json
{"type": "metric", "title": "危急值", "accent": "danger",
 "metrics": [{"value": "13", "label": "危急值", "detail": "需 30 分钟内处置"}]}
```

| 取值 | 含义 |
| --- | --- |
| `accent` | 主题强调色（默认） |
| `support` | 主题辅助色 |
| `primary` | 主题主色 |
| `success` | 成功绿（与 Word/PDF/Excel 同色） |
| `danger` | 风险红（同上） |

也可以直接写六位 hex（`"accent": "#1F5FA9"`）当这一页的自定义强调色：
浅底页要求与纸面 ≥ 3:1，深底页会自动提亮到看得清。

只在确实要"这一页不同"时用；整篇每页都换色等于没有强调。写错取值会直接报错，
不会静默回退。

### 单页深底（`slides[].tone`）

给某一页换深底，用来做"这一页是结论/警示"的视觉重音。取值只有两个：

```json
{"type": "statement", "title": "核心结论", "tone": "dark",
 "statement": "先稳定，再转运", "support": "战创伤处置的第一原则"}
```

- `light`（默认）/ `dark`。**只改配色，不改版式**：背景换成主题主色，文字换成
  该主题的深底文字色，强调色自动提亮到在深底上可读（保色相，不会把"风险红"冲成粉色）。
- 前面已测过的版式都能用：`content` / `statement` / `metric` / `table` / `quote` /
  `chart` / `comparison` / `two-column` / `timeline` / `case` / `evidence` / `imaging`。
- `title` / `section` / `closing` 本来就是深底，传 `tone: "dark"` 会直接报错，
  不要画蛇添足。
- 深底页的对比度由构建器保证（正文 ≥ 4.5:1、强调色 ≥ 3.5:1）；如果某个主题的
  主色太浅、达不到，构建会报错而不是给你一页看不清的字。
- **整篇 1–2 页深底足够**；每页都深等于没有重音，而且打印/投影都不友好。

### 页面纹理（默认开启）

每页背景在纯色之上叠一层极淡的纸纹（`assets/textures/grain.png`，随包分发，
浅底出现细微斑驳与纤维感，深底出现轻微提亮）。它只影响背景，不动版式、文字和
对比度，`audit` 仍按原阈值判定。

- 默认：`grain`，无需任何参数。
- 关闭：`--texture none`（或 spec 里写 `"texture": "none"`），输出回到纯色平涂。
- 换纹理：`--texture <name>` 读取 `assets/textures/<name>.png`；文件不存在直接
  报错，不回退。

PDF 渲染与 PowerPoint 导出的 PDF 已逐页目视核对（2026-11-09）。纹理是位图，
每页各嵌一份，12 页约增加 300 KB；需要控制体积时用 `--texture none`。

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" make \
  --title "战创伤四级救治" \
  --markdown "$PWD/scratch/qa/slides.md" \
  --theme trauma \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

`--spec` 里也可以写 `"theme": "trauma"`；命令行 `--theme` 优先。用户没提
配色时不要自作主张换主题，保持默认 `clinical`。返回 JSON 的 `theme` 字段
是本次实际生效的主题。

受布局库约束，`white` / `paper` 必须保持浅色、`navy` 必须保持深色，
否则封面标题会看不见。返回 JSON 额外给出 `themeLabel`（中文名）；由用途
推荐主题时要注明“（按用途推荐）”。图表系列色与签名版式仍属 T4 范围。

## Markdown 约定

- 第一个 `#` 可作为演示标题；
- 后续 `#` 是章节页；
- `##` / `###` 开始普通内容页；
- 标题下的段落、`-` / `*` 列表和 `1.` 编号变为该页要点；
- 每页尽量只讲一个结论，最多约 6–8 个要点；
- 不要把分析过程、实现说明或 QA 备注写进幻灯片。

短内容不必先写 Markdown；Markdown 只是为长文、分页和避免 shell 转义。

复杂图表、表格、对比、时间线、引用或收尾页使用 `--spec`。只用
[creation.md](references/creation.md) 记录的类型和字段。禁止改写内置
layout-library。

## 把对话已有内容做成 PPT

`pptx.sh` 读不到聊天记录。用户说「把以上内容做成 PPT」时，完整内容已在
当前对话里：直接使用原文和事实，不要让用户重贴，不要把全文缩成无依据的
新版本。先整理为按页 Markdown 或 spec，再调用一次 `make`。

## 插入用户上传的图片（优先这样做）

聊天里的图**不能**从气泡/base64 直接嵌进 PPT。必须用磁盘上的绝对路径。
创面照、X 光、报告截图等，**绝大多数**就是本会话（或更早轮次）用户上传的附件。

路径在用户消息里的附件清单中（后续轮次不再重复打印，但路径仍有效，到历史消息里找）：

```text
[Files attached by user and available for reading in the project:]
- wse_0820_00_injury.jpg (1-wse_0820_00_injury.jpg): /…/inbox/<批次id>/1-wse_0820_00_injury.jpg
```

落盘位置：

- `{当前项目根}/inbox/<批次id>/`
- 或 `inbox/<批次id>/`（本仓库本地启动常见）

规则：

1. **直接使用清单里的绝对路径**（常见 `$WS/inbox/...`）。不要 `find /`，不要下载 URL，不要手写 Python/JS 去读图，不要翻 `pptx` 脚本源码猜字段。
2. `inbox/` 算作允许的本地路径；不必先 `cp` 到 `exports/`（复制可选，不是必需）。
3. 本轮消息没有清单时：在**同一会话更早的用户消息**里找同一标记；G9/`med_trauma_stage_plan` 返回的 `image_paths_used` 也可复用。
4. 禁止 HTTP/HTTPS。禁止打开或修改 `assets/layout-library/`。
5. 插图用 `--spec`，`split` 页字段如下（`path` 用绝对路径最稳）：

```json
{
  "type": "split",
  "title": "创面判读",
  "body": "左前胸穿透伤，活动性出血。",
  "image": { "path": "/absolute/path/from/attachment-note.jpg" }
}
```

Markdown `![](...)` 不能可靠插图；需要图时改用 `--spec`，不要新写 `.mjs` builder。

## 读取与审计

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" inspect --input "$INPUT_PPTX" --out "$PWD/scratch/qa/manifest.json"
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" audit --input "$INPUT_PPTX" --out "$PWD/scratch/qa/audit.json"
```

只读请求不要生成新 PPTX。

## 基于模板修改

保留源 PPTX，输出使用新文件名。先读
[template-following.md](references/template-following.md)，再按受控 JSON
映射走：

1. `inspect`
2. `validate-map`
3. `prepare-starter`
4. `apply-template`
5. `audit`

不要编写 `.mjs` builder。遇到无法安全映射的对象，返回 `unsupported`，
不要重建或覆盖源文件。

## 旧版 `.ppt`

`convert` 需要内网 Office Renderer，后端不可用时返回
`unsupported` 并保留源文件；不要安装转换器。原生 `.pptx` 不受影响。

## 其它保留命令

- `inspect`：读取页数、文本、对象、字体和 OOXML 信息
- `audit`：检查边界、重叠、文本适配、占位符和字体
- `themes`：列出 `--theme` 可选主题
- `render`：仅环境本来就有渲染后端时可选使用
- `validate-map` / `prepare-starter` / `apply-template` / `fidelity`：
  模板继承
- `deliver`：高级模板/候选封印；普通新建不需要

`scaffold` / `build` 仅为维护兼容保留，不属于 Agent 契约。

## 交付

只返回 `output` 指向的最终 `.pptx` 和简短说明。不要交付 Markdown、spec、
builder、audit JSON、候选文件、PNG、montage 或运行时目录，除非用户明确
要求。
