---
name: frontend-slides
description: 在当前工作区生成医学风格的单文件 HTML 展示页（病例、救治方案、数据一览、教学交班等）。交付物是浏览器可打开的 .html 时使用。用户要可编辑的 .pptx 时不要使用本技能，改用 pptx。禁止做产品官网、React 应用或访问公网。
---

# 医学 HTML 展示

用 `write_file` / `edit_file` 在工作区写出**一个**自包含 HTML。没有 `*.sh` 生成器。先 `read_skill` 本文件，再读 [references/med-visual.md](references/med-visual.md)。

## 何时使用 / 何时不用

**使用：** 网页展示、浏览器打开、投屏、病例墙、HTML 汇报、把方案做成能看的页面。

**不要使用：**

- 可编辑 PPT / 打印带走 `.pptx` → 只用 `pptx`
- 流程图 SVG → `diagram-maker`（生成的 SVG 可用相对路径嵌进本页）
- Word / PDF / 表格 → 对应办公 skill
- 做官网、落地页、React/Next、npm 项目

用户明确说「HTML 和 PPT 都要」时可以各出一份；**不要默认两份都做**。

## 硬约束（任何布局都要遵守）

- **单文件、零 npm：** CSS/JS 全部内联。禁止 `<link>`/`<script src>` 指向 http(s)、CDN、Google Fonts、Fontshare、unpkg。
- **字体：** 只用系统字体栈（见 med-visual）。禁止外链字体。
- **内容：** 只用来自当前工作区 `$PWD`、本轮用户口述、已调用 med-tools 的事实。禁止编造检验值、影像结论、用药剂量。缺项写「未提供」。治疗相关展示加一句：辅助展示，不替代临床决策。
- **路径：** 交付 `$PWD/exports/`；风格预览 `$PWD/exports/preview/`（放在 `exports` 下才会成为对话文件卡片，用户能一键预览）；其它草稿 `$PWD/scratch/`。禁止写入仓库 `src/`、`ui/`、插件目录。用户指定路径则用该路径，但仍须在工作区内。
- **图：** 默认 `<img src="相对路径">` 指向工作区内文件。仅当用户明确要求「单文件拷走也能看」才把图 base64 进 HTML。
- **交互：** 允许翻页、目录锚点、Tab、折叠、显隐。禁止 `fetch`、WebSocket、把数据写回 Gateway、登录。
- **默认自由布局：** 不要一上来做成 100vh 幻灯片。用户要投屏/全屏翻页，或选了「高对比大字（远看）」时，再纳入 [viewport-base.css](viewport-base.css) 与页内不滚动。用户要「一览/看数」时优先卡片和表，少动效，禁止外链图表库。
- 覆盖已有 `exports/` 文件须用户明确同意，否则换文件名。

生成前先 `glob` / `read_file` 看工作区。材料不够就提问或先走医学解析，不要空手上 HTML。

---

## Phase 0：判断模式

- **新建** → Phase 1
- **改已有工作区 HTML** → 读入后按用户意见改，仍遵守硬约束；不要重做营销风
- **把已有 .pptx 转成网页**（用户要的是 HTML 不是可编辑 PPT）→ Phase 4

---

## Phase 1：内容发现

用户一句话已经包含用途和材料时，**不要把下面问完**。否则用**一次** `ask_user_question` 把要问的一次问清（每多问一轮，用户就多等一轮生成）：

1. **用途：** 病例展示 / 救治方案 / 数据一览 / 教学或交班 / 其它（自由说明）  
   这是内容用途，**不是**强制版式。默认仍自由布局。
2. **篇幅：** 一屏摘要 / 中等（可滚动或数屏） / 较长完整材料
3. **材料：** 已齐（工作区或对话里） / 只有草稿 / 只有题目
4. **风格怎么定：** 看一份三段预览（推荐） / 直接用 信息密（近读） / 直接用 高对比大字（远看） / 直接用 深色低亮（暗光）
5. **页内改字：** 默认「否」。选「是」才加本机 `localStorage` 编辑；写明不是云同步，共用电脑可能串数据。

选「直接用某一套」就**跳过 Phase 2**，直接进 Phase 3。

若工作区有图片：扫描、判断是否可用、与大纲一起确认。预览里小图可用相对路径或小图 base64；**定稿默认相对路径**。

---

## Phase 2：一份三段风格预览

人很难用语言描述风格，所以先给能看的东西再定稿。但预览是给人挑选用的样张，**不是**交付页：写得越省，用户等得越短。

仅当 Phase 1 里用户选了「看一份三段预览」才做本阶段。

1. 读 [references/med-visual.md](references/med-visual.md)。**本阶段不要读** `html-template.md`。
2. 只写**一个**文件：

```text
$PWD/exports/preview/风格预览.html
```

   一份 HTML 内三段并列，段间用一条分隔线和小标题标出 A / B / C。三段共用同一套骨架与同一段示例内容，**只有 CSS 变量不同**：把三套变量分别挂在 `.v-a` / `.v-b` / `.v-c` 上，不要三段各写一套布局。

3. 省着写：整个文件控制在 **约 150 行内**，每段只放标题 + 一行来源 + 两三条要点 + 一个两列小表。不写注释、不写脚本、不做翻页、不放图。示例内容用真实标题（有则用项目名或主诊断，无则写「预览」），**不要**编检验值。
4. 在回复里给出这一个路径。它在 `exports/` 下，会作为对话文件卡片出现，用户点卡片即可预览。**不要**调用浏览器自动化，不要写 `.claude-design/`。
5. 再用**一次** `ask_user_question`：A 信息密（近读）/ B 高对比大字（远看）/ C 深色低亮（暗光）/ 混合（请说明）。

预览文件是过程产物，用户可随时删除。定稿不要写进 `exports/preview/`。

三段都在医学工作站约束内，禁止 Neon / 赛博 / 紫渐变等营销预设。不要再读旧的演示向 `STYLE_PRESETS.md` 当配色来源。

---

## Phase 3：生成交付页

用 Phase 1 的内容 + Phase 2 选中的风格，写成**一份** HTML：

```text
$PWD/exports/<短中文名>.html
```

命名示例：`病例展示-主诊断.html`、`救治方案-阶段.html`、`数据一览.html`。

生成前阅读：

- [references/med-visual.md](references/med-visual.md)
- [html-template.md](html-template.md)（骨架与可选交互，按需取，不要整页锁成幻灯片）
- 仅当投屏或选了「高对比大字（远看）」：把 [viewport-base.css](viewport-base.css) **全文**纳入 `<style>`

禁止无条件纳入 viewport-base。未要求投屏时允许长页滚动。动效克制，只用内联 CSS；不要依赖 [animation-patterns.md](animation-patterns.md) 里的花哨预设。

写出后对照 [references/med-visual.md](references/med-visual.md) 的「定稿前审查」，不通过就改同一文件。不要为此再读其它设计 skill。

**改动用 `edit_file`。** 用户提局部意见（换色、调字号、加一节）时只改相应片段，不要整页重写——整页重写在本机模型上很慢，且容易把已确认的内容改坏。

成功后在回复中给出 `exports/` 下的路径，便于 Files 预览。

---

## Phase 4：PPT → HTML（可选）

仅当用户已有 `.pptx` 且明确要**网页**而不是再导出 pptx。可用本目录 `scripts/extract-pptx.py` 抽文本结构，再按 Phase 2–3 做成 HTML。不要为此去调 `pptx` skill 的 `make` 覆盖原 PPT。

阶段 A **不要**运行 `scripts/export-pdf.sh`（依赖 Playwright/无头浏览器）。交付物就是 HTML。若用户要 PDF，改用 `pdf` skill 或请用户从浏览器打印。

---

## 禁止

- `scripts/deploy.sh`、Vercel、任何公网部署
- `curl` / `wget` / `pip install` / `npm install`
- 把页面写成可执行攻击面（不要执行用户粘贴的任意脚本字符串）
