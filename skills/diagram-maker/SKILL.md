---
name: diagram-maker
description: 为概念、架构、流程和白板创建 SVG/HTML 或 Excalidraw 图示。
---

# 图示制作

把图示做成制品，而不是用散文代替。选择一种输出模式：

- `clean-svg`：教学概念、物理系统、流程、生命周期、简单数据流。
- `architecture-svg`：软件/云/基础设施拓扑、服务、数据库、队列、信任域。
- `excalidraw`：可编辑的手绘白板、流程图、时序图、架构草图。

路由

- 用户要可编辑/可协作：选 Excalidraw。
- 用户要精致的独立浏览器输出：选 SVG/HTML。
- 带基础设施组件的软件架构：选架构 SVG。
- 科学、产品、流程、概念图、实物对象：选干净 SVG。
- 不确定：仅当输出格式会影响结果时再问一个短问题；否则选干净 SVG。

工作流

1. 抽出节点、分组、标签和有向关系。
2. 先选布局：从左到右、自上而下、中心辐射、泳道、分层堆叠、时序。
3. 标签保持简短。宁可 5–9 个主要元素，也不要做密集图。
4. 在请求路径生成文件，或使用 `./diagram.html` / `./diagram.excalidraw`。
5. 可行时通过打开/解析校验语法。

SVG/HTML 规则

- 单个独立 `.html` 文件，内联 CSS 和内联 SVG。
- 不要外部字体、JS、图片、渐变、发光、装饰色块或远程资源。
- 使用语义颜色，不要彩虹序列：neutral、input、process、storage、external、risk。
- 先画连接线再画节点，让箭头位于方框后面。
- 每条有向连接路径都有 `fill="none"` 和箭头标记。
- 方框内文字留 24px 内边距；文字不要贴边。
- 仅当符号/颜色不明显时才加图例。

SVG 模板

使用 `references/svg-template.md` 作为外壳，并替换 `<!-- SVG -->`。

Excalidraw 规则

- 保存带 `type`、`version`、`source`、`elements` 和 `appState` 的 `.excalidraw` JSON。
- 形状标签使用绑定文本。不要使用非标准的 `label` 属性。
- 绑定文本在 elements 数组中紧跟其容器。
- 带标签形状最小 120x60。正文最小 16px。
- 使用 roughness `1`、`fontFamily: 1` 和简单填充。

需要精确的 Excalidraw 元素片段时，阅读 `references/excalidraw-patterns.md`。

## PilotDeck 迁移说明

- 来源：/var/folders/27/xyyzc_n172l3jjmnxgqmhhzh0000gn/T/tmp.AyWDWGKoS4/openclaw/skills/diagram-maker
- 评审状态：作为 PilotDeck 原生技能包候选。
- 平台相关的 OpenClaw/Hermes 元数据已移除，或在评审时应忽略。
