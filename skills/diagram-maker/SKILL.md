---
name: diagram-maker
description: 创建离线 SVG/HTML 流程图、概念图和架构图。新建图示使用结构化工具 diagram_make；其余转换只通过捆绑的 diagram.sh 完成。
---

# 图示制作

新建图示时调用结构化工具 `diagram_make`，不要拼接 Bash 或自行查找脚本。高级维护入口才使用系统登记的 diagram.sh。

`diagram.sh` 使用交付包内的标准库布局并生成 SVG。运行时未就绪时会返回
「交付包不完整」；此时停止并报告，不要改走其它实现。

## Agent 可用表面

- 创建新图示：只调用 `diagram_make`
- `diagram_make` 的输入使用 `title`、`body`、`markdown_path`、`spec_path`、
  `theme`、`direction`、`format`、`output_path`、`force` 和 `timeout_ms`
- 需要创建声明式内容时，用 `write_file` 写入 `scratch/` 下的 `.mmd` / `.json`，
  再把相对任务路径传给 `diagram_make`

- 需要查看能力时可调用 `diagram.sh capabilities`
- 只用 `.md` / `.mmd` / `.json` 暂存节点、边、分组等声明式内容
- 不手写 `.svg` / `.html` / `.excalidraw`
- 不搜索浏览器、Graphviz、Mermaid CLI 或替代工具
- 命令返回 `unsupported`、`invalid-diagram-input` 或「交付包不完整」时立即停止并报告

`capabilities` 只用于查看已登记的业务入口和路径契约；不要调用
`diagram.sh --help`、`self-test` 或自行编写 SVG/HTML。

## 输出位置

交付文件写入本任务 `exports/`；中间文件写入 `scratch/`。需要目录时使用文件工具或由技能创建，不调用 `mkdir`。

中间 Markdown/Mermaid/JSON 放在 `$PILOTDECK_WORK_DIR/diagram/`，不要交付。

## 新建图示

普通线性流程可直接传正文：

```json
{
  "title": "救治流程",
  "body": "分诊 → 抢救 → 后送",
  "output_path": "exports/救治流程.svg"
}
```

分支、边标签或分组使用 Mermaid `flowchart` 子集。先用 `write_file` 写
`.mmd`，再调用：

```json
{
  "markdown_path": "scratch/diagram/flow.mmd",
  "output_path": "exports/流程图.svg"
}
```

结构较复杂或需要架构节点类型时，用 `--spec` JSON：

```json
{
  "spec_path": "scratch/diagram/architecture.json",
  "theme": "architecture",
  "output_path": "exports/系统架构.svg"
}
```

覆盖已有输出必须加 `--force`。

## 支持范围

- 布局方向：`LR`、`RL`、`TB`（Mermaid `TD` 视为 `TB`）
- Mermaid：`flowchart` / `graph`、`-->` / `---` / `-.->` / `==>`、简单 `subgraph`
- 节点形状：`id[步骤]`、`id(步骤)`、`id{判断}`（菱形）、`id{{数据}}`
- 边标签：`A -->|标签| B` 与 `A -- 标签 --> B` 等价
- 主题：`clean`（流程/概念）和 `architecture`（服务/数据库/队列/外部系统）
- 默认交付 SVG；只有用户明确要求独立网页时才用 `--format html`
- 时序图、类图、ER 图、状态图、gitGraph 和任意 Mermaid 扩展不支持
- 第一期不交付 Excalidraw；不要自行拼接元素数组
- **不支持嵌入用户照片 / inbox 图片**。本技能只画节点与边 → SVG。若用户要「流程图 + 伤情照」，改用 **pptx / docx / pdf / spreadsheets** 插图，diagram 只负责流程 SVG（可另嵌进那些文档）。不要去翻 `diagram_cli.py` 源码找插图能力。

详细输入契约见 `references/creation.md`。

## 质量要求

- 先抽出节点、分组、短标签和有向关系；避免把整段正文塞进节点
- 通常保持 5–9 个主要元素；过密内容拆成多张图
- `make` 已做 XML、安全和外部资源审计；成功 JSON 的 `output` 就是交付物
- 不要复制 `references/svg-template.md`，不要自己计算坐标或箭头路径
