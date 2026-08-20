# 设计与版式

## 选择视觉路径

仅使用一种视觉来源：

1. 用户提供的 PPTX 或参考演示文稿。
2. 明确的用户美术方向。
3. 当前两者都不存在时，使用 PilotDeck 核心版式库。

不要把默认库混入已提供的模板。

## 核心版式库

阅读 `assets/layout-library/template-registry.json`，按 `useWhen`、`slots` 和 `densityBudget` 筛选版式，然后仅检查 `assets/layout-library/layouts/core.mjs` 中相关的导出。

可用导出：

- `titleSlide`、`sectionSlide`、`statementSlide`
- `splitSlide`、`twoColumnSlide`
- `metricSlide`、`comparisonSlide`、`timelineSlide`
- `chartSlide`、`tableSlide`、`quoteSlide`、`closingSlide`

将这些视为组合脚手架，而非强制样式。在适配内容时保留边距、层级和密度。

## 演示文稿原生设计

优先采用平面编辑式构图，而不是 UI 面板。除非主题明确是产品界面，否则避免重复的卡片、胶囊、按钮、导航栏和密集仪表盘。

默认保持相等的外边距。用对齐、留白、比例和一种强调色建立层级。变换幻灯片轮廓，但不要在每一页引入不同的视觉语言。

标准内容页最多使用一个主视觉。避免装饰性图表、无标签图标和低价值示意图。

## 排版与适配

标题保持一行。先缩短文本再缩小字号。从 `typography-and-fonts.md` 解析合适的排版配置；投影使用 presentation 密度，仅桌面阅读交付物使用 report 密度。在已渲染 PNG 中检查中文和中英混排换行，并将 LibreOffice 字体替换与目标 PowerPoint 兼容性分开处理。

## 图像

放置图像前先选定预期裁切。不要拉伸图像。让重要的人脸、标签和产品 UI 远离裁切边缘。默认不要在多张幻灯片上复用同一张非背景图像。
