# 医学展示视觉（三套预览 + 定稿共用）

所有展示页、预览页必须落在工作站可读风格内：浅色或深色高对比、蓝强调、克制装饰。禁止紫渐变、霓虹、玻璃拟态堆砌、外链字体。

界面文案用中文。西文仅限通用缩写（CT、GCS、FAST 等）。

信息层级：主结论 → 依据（检查 / 影像 / 时间） → 待办或「未提供」。

## 系统字体栈

```css
--font-body: "Noto Sans SC", "Source Han Sans SC", "PingFang SC",
  "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
--font-mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
```

禁止 Google Fonts / Fontshare / `@import` 字体。

## 共用语义色

| 角色 | 用法 |
| --- | --- |
| 强调蓝 | 主按钮、当前导航、链接 |
| 红 / 琥珀 | 仅真实异常、警告、缺失 |
| 绿 | 仅真实完成/正常，不要装饰性大色块 |

## 三套变量（Phase 2 的三段与定稿都用这三套，不要自创营销名）

命名按**信息密度与阅读距离**，不是主题名。Phase 2 把三套分别挂在一个预览文件的 `.v-a` / `.v-b` / `.v-c` 上。

### A 信息密（近读）

案头近距离阅读，单屏放得下更多信息。

```css
:root {
  --bg: #fafafa;
  --surface: #ffffff;
  --text: #171717;
  --muted: #525252;
  --border: #e5e5e5;
  --accent: #2563eb;
  --accent-soft: #eff6ff;
  --danger: #b91c1c;
  --warning: #b45309;
  --title-size: 1.75rem;
  --body-size: 1rem;
  --space: 1.25rem;
}
```

### B 高对比大字（远看）

浅底，字号与对比更大、装饰更少，几米外也能读。用户选这套或口头要求投屏时，定稿纳入 `viewport-base.css`。

```css
:root {
  --bg: #ffffff;
  --surface: #ffffff;
  --text: #0a0a0a;
  --muted: #404040;
  --border: #d4d4d4;
  --accent: #1d4ed8;
  --accent-soft: #dbeafe;
  --danger: #991b1b;
  --warning: #92400e;
  --title-size: 2.25rem;
  --body-size: 1.25rem;
  --space: 1.5rem;
}
```

### C 深色低亮（暗光）

暗环境阅读，降低屏幕亮度感。仍高对比，禁止霓虹绿/紫。

```css
:root {
  --bg: #0a0a0a;
  --surface: #171717;
  --text: #f5f5f5;
  --muted: #a3a3a3;
  --border: #404040;
  --accent: #60a5fa;
  --accent-soft: #1e3a5f;
  --danger: #fca5a5;
  --warning: #fcd34d;
  --title-size: 1.75rem;
  --body-size: 1rem;
  --space: 1.25rem;
}
```

## 定稿前审查

写出或改完交付 HTML 后对照下列各项；不通过就改，不要另开 `frontend-design` skill。这是工作站展示页自检，不是产品官网清单。

- **层次：** 打开页立刻能看到主结论或标题；依据（检查 / 影像 / 时间）在其次；待办或「未提供」在后。不要把装饰、导航、卡片墙抢在结论前面。
- **对比：** 正文与背景对比足够（浅底深字 / 深底浅字）。弱化信息用 `--muted`，不要用浅灰压浅灰。强调只用 `--accent`，不要再加第二套高饱和色。
- **空态：** 缺检验、缺影像、缺剂量必须写「未提供」。不要用假数、占位图或空卡片把版面填满。
- **少装饰：** 不要紫渐变、霓虹、玻璃拟态、无信息图标墙、为「好看」加的大色块。边框与阴影克制；卡片只包真实分组。
- **对齐与节奏：** 同一页边距、字号阶、圆角用同一套 token（`--space`、`--title-size`、`--body-size`）。表、列表、章节标题左缘对齐，不要每块一种缩进。
- **颜色有语义：** 红 / 琥珀只表示真实异常、警告、缺失；绿只表示真实完成或正常。链接和当前项用强调蓝，不要把整页刷成彩色仪表盘。
- **阅读面：** 未要求投屏时允许长页滚动，正文行宽不要拉满整屏。投屏页保证一屏内主结论可读。窄窗口时内容仍可阅读（可折行、可纵向堆叠），不要做成必须横屏的营销落地页。
- **动效：** `prefers-reduced-motion: reduce` 时关掉非必要动画。默认少动效。

## 版式禁令

- 不要用 Inter / Roboto / Arial 作为「设计卖点」；系统栈即可。
- 不要大面积无信息卡片墙。
- 不要为审查项「响应式 / 空态」去引入框架或外链组件库。
