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

## 配色主题（可选，与布局解耦）

`--theme` 只管**布局与节点形状**（`clean` 流程 / `architecture` 服务-数据库-外部系统），
`--design-theme` 只管**颜色与字体**。两者互不影响，可以任意组合：

```bash
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make \
  --spec "$PWD/scratch/qa/architecture.json" \
  --theme architecture \
  --design-theme 宣纸病案 \
  --out "$PWD/exports/系统架构.svg"
```

- 可用 ID / 中文名 / 别名：`clinical` 临床晨光、`academic` 青黛循证、`trauma` 松风急救、
  `archive` 宣纸病案、`edu` 杏林宣教、`mono` 灰阶印刷；spec 里也可以写
  `"designTheme": "academic"`，命令行参数优先。
- 主题只改颜色与字体角色：背景用 `paper`、标题用 `primary`、连线与边框用 `muted`、
  分组框用 `rule`、风险节点用语义危险底色、`archive` 换成衬线栈。
- **不改**节点坐标、画布尺寸、连线走向——换主题不会让排版重排。
- 不写 `--design-theme` 时保持原来的默认灰蓝配色，输出与旧版逐字节一致。
- 主题名写错会退出码 2，并列出六套中文名；不要自己编近似色。
- 成功 JSON 多一个 `designTheme: {id, label}` 字段，交付说明里写「配色：宣纸病案（archive）」。

## 交付前几何检查

生成后跑一次确定性几何审计（纯标准库，不启动浏览器）：

```bash
bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" audit \
  --input "$PWD/exports/救治流程.svg" \
  --report "$PWD/scratch/qa/diagram-audit.json"
```

- 检查 `viewBox` 是否存在、节点是否越出画布、文字估算范围是否被裁切、
  宽度是否超过报告正文常用的 1200px（`--max-width` 可调）。
- 再带上原始输入（`--body` / `--markdown` / `--spec`）时，会额外检查**节点文案是否
  超过三行上限**——超过就会被静默截断丢字，属 `error`；同时核对成品里的文字是否与
  来源一致，出现 `label-not-rendered` 说明这张 SVG 是改稿前生成的，需要重新 `make`。
- `status=warning` 可以交付，但要跟用户说明原因（例如"这张图较宽，插入 Word 会缩小"）。
- `status=error` 必须先修：缩短文案、拆成两个节点、或换布局方向，不要直接交付。
- `--report` 只是留档：**stdout 已经带全量 `issues`**。先看 `issues[].code`
  （`label-truncated` = 文案超三行会被丢字、`label-not-rendered` = 图是改稿前的、
  `overflow` = 越出画布），再决定改哪儿；不要靠猜。
- `make` 的返回里已有 `warnings`（例如 `label-truncated`），看到就先处理。

审计只覆盖几何与文案完整性；**配色是否好看、箭头是否易读仍需用户看**，不要
把审计通过说成"视觉效果已验收"。

## 排版约束（自动处理，不需要你调参）

- **判断节点（菱形）按文案加宽**：菱形只有腰部是全宽，两行文案在固定 184px 里会溢出
  斜边。现在按最长一行自动加宽；单行短文案仍是 184px，和旧图一致。
- **边标签避让**：折线连接器中间那一段是竖线（横向排布）或横线（纵向排布），标签原来
  正压在上面、把线截成两截。现在先放在线侧边，放不下才退到拐角上方，并且不会压到节点框。
- 这两条只改几何，不改配色；换 `--design-theme` 依然不会让图重排。

## 支持范围

- 布局方向：`LR`、`RL`、`TB`（Mermaid `TD` 视为 `TB`）
- **方向默认与自动转排：** 不写 `--direction` 时默认横向；若单链横向需要超过 1200px
  （报告正文宽度），会自动改成纵向 `TB`，并在 JSON 里返回 `direction` 与 `directionNote`。
  一旦显式写了 `--direction` / Mermaid 表头 / spec `direction`，就**永不改写**；
  有分支的图也不会自动转排（换轴只会换个方向继续变宽）。
- Mermaid：`flowchart` / `graph`、`-->` / `---` / `-.->` / `==>`、简单 `subgraph`
- 节点形状：`id[步骤]`、`id(步骤)`、`id{判断}`（菱形）、`id{{数据}}`
- 边标签：`A -->|标签| B` 与 `A -- 标签 --> B` 等价
- 布局：`clean`（流程/概念）和 `architecture`（服务/数据库/队列/外部系统）
- 配色：六套设计主题（见上节），与布局正交
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
