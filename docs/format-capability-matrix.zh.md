# 六格式能力矩阵（2026-11-09）

> 只记录**代码里已经能跑通、并且被测试验证过**的能力。
> 文末的「待补」不进矩阵。机读片段 `capability-matrix` 由
> `tests/skills/format-capability.test.mjs` 与真实 CLI 逐条比对，改能力不更新本文会直接测试失败。

## 1. 主题支持现状

| 格式 | 档位 | 主题入口 | 现状 | 未做 |
| --- | --- | --- | --- | --- |
| PPTX | A | `--theme <ID｜中文名｜别名>` | 六套全量：语义色 + 字体角色 + 字号/行距乘数 + 图表序列/网格/轴色 + 对比页底色；隐藏回退色板 `clinical-legacy` / `vital-legacy` | 版式几何不随主题变化（版式是 `layoutVariant` 的事） |
| DOCX | B | `--design-theme` + `style_policy=themed-v1` | 六套令牌级：标题/各级标题、表头、提示块、表格边框；`archive` 把正文与标题切到 `SimSun`（衬线） | 版式几何不随主题变化 |
| HTML | A | 页面根节点 `data-pd-theme` + 内联 `assets/themes/pd-themes.css` | 六套令牌（16 色 + 4 组语义浅底 + 3 个字体角色 + A/B/C 密度桥接） | 文件夹交付未携带 WOFF2 分片 |
| PDF | A | `--design-theme` / `spec.designTheme` | 六套：颜色 + 字体角色（`archive` 用随包衬线）+ 字号/行距乘数 + 页眉页脚 + 章前强调线 + 表头配色；`--toc` 独立成页、两级缩进、点线页码、超页续页（见 §4 第 15 条） | 图表配色、影像页、页数优化属 T4.3/T4.5 |
| XLSX | B | `--design-theme` / spec `designTheme` | 六套令牌级：标题与表头用 `primary`/`onPrimary`（含把默认teal 表头重绘成主题色）、正文 `ink`、页签 `accent`、图表序列与网格跟 `theme.chart`；`archive` 把正文字体换成 `SimSun`（衬线角色） | 版式与数字格式不变；`--theme` 仍被拒绝（避免和 Excel 原生表格样式混淆） |
| 图示 | B | `--design-theme`（配色）+ `--theme clean｜architecture`（布局） | 六套令牌级：背景 `paper`、标题 `primary`、连线/边框 `muted`、分组框 `rule`、风险节点语义红底、节点填充取主题浅色；`archive` 换衬线；两条轴互不影响 | 版式与坐标不随主题变化；不嵌字体，靠系统字体栈 |

### 未指定主题时的默认（D1 已批准执行，2026-11-10）

| 格式 | 不传主题参数时的默认 | 取回旧观感的方式 |
| --- | --- | --- |
| PPTX | `clinical`（临床晨光），与显式 `--theme clinical` 逐页 XML 一致 | `--theme clinical-legacy`（隐藏回退色板） |
| PDF | `clinical`（临床晨光） | `--design-theme none`（`neutral` / `off` / `无` 同义）→ 旧纯黑白 |
| HTML | `clinical`（临床晨光）；页面根节点必须写 `data-pd-theme="clinical"` | 不内联 `pd-themes.css` 即无主题；内联了却漏写属性时 `html.sh audit` 报 `theme-attribute-missing` |
| DOCX / XLSX / 图示 | 仍为旧的中性观感（本次不刷新） | 本就是默认 |

旧基线、改版前后对照与批准记录见 `docs/skills-optimization-plan.zh.md` §0.1 D1 与 §9 执行日志。
HTML 没有生成器，默认值只能写在 `skills/frontend-slides/SKILL.md` 与 `references/themes.md` 的指令里，
由 `html.sh themes` 的 `default` 字段和审计告警兜底——这是三种格式里唯一无法用生成器硬断言的。

## 2. 内容能力（已实测）

| 格式 | 支持 | 入口 | 证据 |
| --- | --- | --- | --- |
| DOCX | 标题/副标题/各级标题、段落、项目符号、编号、引文、提示块、检查清单、定义列表、来源列表、**原生表格**、图片+图注、目录、字段、分页、留白 | `make --spec` 的 `content[]` 块 | `inspect` 返回 `table_count=1`、`image_parts`、`headings` |
| DOCX | 纯文本 + 标题 | `make --title/--body/--markdown` | `make` 成功；Markdown 管道表格**不会**变成 Word 表格（按段落原样输出） |
| XLSX | 工作表、表头/行、单元格、公式、数字格式、列宽、冻结、数据验证、原生表格对象、**条件格式**、**原生图表**（line/column/bar，主题化配色/网格）、浮动图片（仅新建）、六套主题 | `make --spec` 的 `sheets[]`；`--design-theme` | `inspect` 的 `package.features.charts=1`；主题文件 `chart1.xml` 含 `theme.chart.series` 色值与 `<tabColor>` |
| PPTX | 16 种版式：title/section/statement/content/split/two-column/metric(s)/comparison/timeline/chart/table/quote/closing/**case/evidence/imaging** | `make --spec` 的 `slides[].type`；图表种类写 `chartType`（bar/column/line/pie…） | `--spec` 三页样张（病例概况 / 胸部 CT / 证据与推荐）审计 0 错误；图表 XML 含 `<c:barChart>` |
| PPTX | Markdown 管道表格 → 原生表格页 | `make --markdown` | 表头即所在标题；表后正文另起一页；`<a:tbl>` 出现在 slide XML |
| PDF | 标题/作者、章节（标题 + Markdown 正文）、列表、**管道表格 → 原生表格**（跨页重复表头、数值列右对齐）、**目录**（`--toc`）、图片+图注、页码、六套主题 | `make --title/--body/--markdown/--spec`，`--design-theme`，`--toc` | `inspect --tables-out` 检出 1 张表且列值正确；60 行表格跨页后第 2 页仍有表头；`inspect.fonts` 显示 `archive` 嵌入 `NotoSerifSC` |
| HTML | 任意页面结构（模型自由写 HTML/CSS），主题可选 | `write_file` + `html.sh audit/package` | 审计 `status=ok`；打包出 `index.html` + `assets/` + `.zip` |
| 图示 | 节点（7 类）、边+标签+虚线、子图分组、4 个方向、2 套布局 + 六套配色；判断节点按文案自动加宽、边标签自动避让连线与节点、超宽单链自动转 `TB`（`directionNote` 说明） | `diagram.sh make --body/--markdown/--spec`，`--theme`、`--design-theme`、`--direction` | `audit` 返回节点数、viewBox、几何边界；换主题后节点坐标与画布尺寸不变；两行判断文案不再溢出菱形（`tests/skills/diagram-layout.test.mjs`） |

## 3. 交付门与断言

| 格式 | 结构 | 内容 | 视觉 | 缺项 |
| --- | --- | --- | --- | --- |
| DOCX | `preflight` 包校验 + 审计 | 必含文本/标题、页数、图片数、目录 | 渲染 + 逐页评审（Renderer 不可用时 `not_performed`） | 图片不足 → `delivered_with_missing_assets` |
| PPTX | `deliver` 完整性 + 交付门 + 审计 | 需求覆盖（`--requirements --require-coverage`） | 渲染记录（`not_performed` 直到有人逐页看） | — |
| XLSX | `deliver` 公式/包/结构 + 空白打印页 | 需求覆盖（工作表/区域/图表/条件格式） | 渲染记录 | — |
| PDF | `deliver` 结构审计 | `--require-text/--min-pages/--max-pages` | 可选渲染 + 可选 `--visual-review` | — |
| HTML | `html.sh audit` 事实类检查 | `--require-text/--require-heading` | **不做**（无服务端浏览器） | 缺图 → `delivered_with_missing_assets` |
| 图示 | `diagram.sh audit` 几何检查 | 文案三行截断检查 + 成品与来源一致性 | **不做** | — |

## 4. 已知限制（实测，不是猜测）

1. **PPTX `--markdown` 的 H1 段落截断（已修）**：`# 标题` + 正文曾把正文整段丢掉（section 版式不画正文）。
   现在有正文的 H1 自动降为 content 版式；纯分节 H1 仍是分节页。
2. **PPTX 图表种类必须用 `chartType`**：`slides[].type` 是版式名（`chart`），
   图表种类写 `chartType`（`bar`/`column`/`line`/`pie`/…），`column` 是 `bar` + `barDir=col` 的别名；
   写错会直接报错而不是生成空图表。
3. **DOCX `--markdown` 不解析 Markdown 表格**：表格行变成普通段落，`table_count=0`。
4. **DOCX 内置策略禁止直接颜色覆盖**：`callout.accent` 之类的字段会报 `builtin-style-override`；
   主题色只能通过 `--design-theme` 走 `themed-v1`。
5. **HTML / 图示没有服务端渲染**：`visual` 恒为 `not_performed`，最高 `passed_with_warnings`。
6. **图示文案上限三行**：超过会被静默截断，`diagram.sh audit` 会报 `label-truncated`。
7. **PPTX `--body` 是纯文本**：不会解析 `#`、`-`、`|`，需要结构时用 `--markdown` 或 `--spec`。
8. **XLSX 图表需求必须带数据溯源**：只要工作簿里有图表，`audit` 就会检查
   `requiredNativeCharts[]` 每条都同时给出 `sourceRanges`（≥2 个区域）和 `minPoints`（正整数），
   缺一项即 `native_chart_requirement_floor` 失败。
   只写 `{sheet, type}` 会被判失败，哪怕图表确实存在——这是刻意设计：
   不允许"声明有图"但不交代数据来自哪些单元格。
   正确写法：`{"sheet":"数据","type":"column","minPoints":2,"sourceRanges":["A2:A3","B2:B3"]}`。
9. **PDF 正文字重偏细**：随包 `NotoSansSC-VF.ttf` 是可变字体，ReportLab 只能用它的默认实例
   （`wght=100`，PostScript 名 `NotoSansSC-Thin`）。主题与非主题路径都一样，属历史基线。
   要改成 400 需再打包一个实例文件（约 +10 MB），是否值得由 T4.5 目标平台评估后决定。
10. **PDF 管道表格的识别条件**：表格块前必须有空行，且第二行是 `| --- |` 分隔行；
    缺分隔行的 `a | b` 文本仍按普通段落输出（避免把「收缩压 | 舒张压」这类记录误判为表格）。
11. **XLSX 图表要放得进可打印宽度**：图表是浮动对象，LibreOffice 导出 PDF 时会**按页边裁切**而不是缩放，
    锚点默认 `G2:N18` 在 A4 纵向的默认页宽里会有一半落在页外（预览里只看到左半张图，看起来像"图表坏了"）。
    要么把 `anchor` 收进 `A1:H20` 这类页内区域，要么在 Excel 里改横向/页边距。
12. **ExcelJS 的 solid fill 只写 `fgColor`**：Excel 能显示，LibreOffice 丢弃整块底色（表头变白）。
    本仓库统一走 `solidFill()` 同时写 `fgColor` + `bgColor`；这会让**默认（无主题）表头的 teal 底色在 LibreOffice 预览里第一次真正显示出来**，
    属于修正而非改版——Excel 里一直是这个颜色。
13. **图示与 HTML 都不嵌字体**：SVG 里只写 `font-family` 字体栈，HTML 单文件同样只用系统字体栈，
    `archive` 的衬线在缺少 `Noto Serif CJK` 的机器上会回落到 `SimSun`/`Songti`/系统 `serif`。
    这是"离线可用"的代价，属已知限制，不是缺陷。
14. **HTML 签名组件是可选的**：六个 `.pd-*` 类只改外观、不强制页面结构；页面不用这些类时
    与 T2 的纯令牌版本完全一致。组件样式只引用已有令牌，不新增颜色。

14. **DOCX / PPTX / XLSX 不嵌字体**，最终观感由目标机决定。实测：LibreOffice 基线把
    `Noto Sans SC` / `SimSun` 都换成 `NotoSansCJKjp`（日文字形，XLSX 的衬线还会丢）。
    部署侧要装 `fonts-noto-cjk` 并设 `LANG=zh_CN.UTF-8`（或用 fontconfig 别名），
    用 `node scripts/platform-preflight.mjs` 自检；完整配方与实测表见
    `docs/target-platform.zh.md`。PDF 不受影响（随包嵌字体）。

15. **PDF `--toc` 曾经只画出「目录」二字与点线、条目为空**（2026-11-10 发现，当日修复）。
    两个独立问题：
    1. ReportLab 的 `TableOfContents` 把每条目录做成带 `<onDraw>` 点线回调的 Paragraph，
       配上随包的可变字体后，条目文字虽然进了 PDF 文本层（`pdftotext` 能读到），
       但 poppler 和 Quartz 都不绘制——视觉上只剩点线。旧测试只断言文本层，所以一直是绿的。
    2. 目录后没有分页，目录与正文挤在同一页，页码全是 1。
    现在改为自己实现的两遍式目录（`_TocFlowable`）直接画在画布上：条目单独成页、
    `##` 一级、`###` 二级缩进、`####` 及更深不收录、点线按剩余宽度计算、页码右对齐、
    条目超过一页自动续页；`make` 返回 `tocEntries` 便于交付说明。
    同时给标题样式加 `keepWithNext`，避免标题落在页底而正文翻页。
    回归：`tests/skills/pdf-theme.test.mjs` 新增「目录独立成页」「层级与页码」「超页续页」三条。
    旧计划日志 T4.2 里「`--toc` 首页出现『目录』与三个标题」只对文本层成立，以本条为准。

16. **DOCX 勾选框依赖 Wingdings**（2026-11-10 修复）。`checklist` 原先写 `☒`/`☐` 文本字符，
    而微软雅黑、宋体、随包 Noto Sans SC 的 cmap 都没有 U+2610/U+2611/U+2612，
    Word 只能回落成两个一模一样的空框，`checked` 形同虚设。
    现在用 Word 原生符号 `<w:sym w:font="Wingdings" w:char="F0FE|F0A8"/>`（勾选框 / 空框），
    Wingdings 随 Windows 与 Word for Mac 一起安装。
    已知限制：Pages 与 LibreOffice 不渲染 `w:sym`，在这两个软件里勾选框不显示（条目正文仍在）；
    `inspect` 的段落文本也不含勾选状态，需要时请看 `checked` 源数据。

## 5. 待补（按 T4 计划，尚未实现）

- T0.3 HTML 默认观感刷新（等用户批准）
- T5 安全、真实且可重复的回归集（T5.1–T5.4）

## 机读片段

<!-- capability-matrix:begin -->
```json
{
  "themes": {
    "ids": ["clinical", "academic", "trauma", "archive", "edu", "mono"],
    "supported": ["pptx", "docx", "html", "pdf", "xlsx", "diagram"],
    "notSupported": []
  },
  "defaults": {
    "theme": "clinical",
    "approvedAt": "2026-11-10",
    "byFormat": {"pptx": "clinical", "pdf": "clinical", "html": "clinical"},
    "unchanged": ["docx", "xlsx", "diagram"]
  },
  "content": {
    "docx": {"nativeTable": true, "image": true, "toc": true},
    "xlsx": {"nativeChart": true, "conditionalFormatting": true},
    "pptx": {"chartLayout": true, "tableLayout": true, "timelineLayout": true,
             "markdownTable": true, "caseLayout": true, "evidenceLayout": true, "imagingLayout": true},
    "pdf": {"markdownTable": true, "nativeTable": true, "toc": true}
  }
}
```
<!-- capability-matrix:end -->
