---
name: diagram-maker
description: 创建离线 SVG 流程图、概念图和架构图。所有转换只通过捆绑的 diagram.sh 完成。
---

# 图示制作

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
DIAGRAM_SKILL_ROOT="$(dirname "<path>")"
```

`diagram.sh` 使用交付包内的标准库布局并生成 SVG。运行时未就绪时会返回
「交付包不完整」；此时停止并报告，不要改走其它实现。

## Agent 可用表面

- 只调用本技能的 `diagram.sh`
- 只用 `.md` / `.mmd` / `.json` 暂存节点、边、分组等声明式内容
- 不手写 `.svg` / `.html` / `.excalidraw`
- 不搜索浏览器、Graphviz、Mermaid CLI 或替代工具
- 命令返回 `unsupported`、`invalid-diagram-input` 或「交付包不完整」时立即停止并报告

## 输出位置

用户给了路径就使用该路径；否则写到当前工作目录的 `exports/`：

```bash
mkdir -p "$PWD/exports" "$PWD/scratch/qa"
```

中间 Markdown/Mermaid/JSON 放在 `scratch/qa/`，不要交付。

## 新建图示

普通线性流程可直接传正文：

```bash
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make \
  --title "救治流程" \
  --body "分诊 → 抢救 → 后送" \
  --out "$PWD/exports/救治流程.svg"
```

分支、边标签或分组使用 Mermaid `flowchart` 子集。先用 `write_file` 写
`.mmd`，再调用：

```bash
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make \
  --markdown "$PWD/scratch/qa/flow.mmd" \
  --out "$PWD/exports/流程图.svg"
```

结构较复杂或需要架构节点类型时，用 `--spec` JSON：

```bash
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make \
  --spec "$PWD/scratch/qa/architecture.json" \
  --theme architecture \
  --out "$PWD/exports/系统架构.svg"
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
