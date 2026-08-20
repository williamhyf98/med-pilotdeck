---
name: docx
description: 通过明确的能力、执行、受控回退与验收协议，创建、检查、编辑、审阅、比较、净化、渲染、审计、预检并定稿专业的 Microsoft Word .docx 文档。只要 PilotDeck 必须生成或修改 Word 文档、在保留现有文档的同时做定向修改、添加批注或修订替换、分析结构或元数据、核验无障碍与版式质量、比较修订、清除审阅数据，或交付经过视觉检查的 DOCX，就使用本技能。仅用于 .docx 文件，不用于旧版 .doc、启用宏的 .docm，或 Google Docs 操作。
---

# 专业 Word DOCX

把 Word 文档同时当作结构化内容和分页视觉制品。捆绑 CLI 是本技能能做什么的权威。切勿从示例推断缺失能力、静默忽略不受支持的字段，或用临时 Python 程序绕过 CLI。当已声明操作不足时，使用受控回退协议。在结构、渲染文本、警告处置和视觉审阅门禁全部通过之前，不要交付被改动的 DOCX。

## 解析并调用本技能

将包含本 `SKILL.md` 的目录解析为 `DOCX_SKILL_ROOT`。常见位置是：

```bash
DOCX_SKILL_ROOT="${PILOT_HOME:-$HOME/.pilotdeck}/skills/docx"
# 源码检出中：<repo>/skills/docx
```

所有确定性操作都通过以下方式调用：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" <command> [options]
```

所有中间产物都使用本轮作用域的 PilotDeck 工作目录。宿主
会设置 `PILOTDECK_WORK_DIR`。手动运行时，在调用任何修改命令之前
显式导出一个唯一的项目内部目录：

```bash
export PILOTDECK_WORK_DIR="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}"
WORKSPACE="$PILOTDECK_WORK_DIR/docx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

`prepare`、`qa-init`、`qa-record` 和 `qa-finalize` 需要该环境
变量，且绝不会搜索另一个会话或轮次目录。只要设置了
`PILOTDECK_WORK_DIR`，CLI 就会强制该边界。创建、
编辑和审阅规格；回退脚本与清单；检查、
审计、验收、处置、渲染、视觉审阅、预检报告
以及 DOCX 候选都是内部的。只有 `deliver --out` 可以创建那一份
项目可见的最终 DOCX。切勿把辅助代码放进 PilotDeck 源码树
或另一个工作区。

把 JSON 规格、检查结果、比较、渲染页、可选 QA PDF 和临时候选放在 `WORKSPACE`。源文档保持原位，只有请求的最终 DOCX 交付物才放到项目或用户选定的输出目录。切勿在用户文件旁边创建检查 JSON、渲染目录或其他中间产物。不要把任务产物写进技能目录。

## 路由请求

| 用户意图 | 主命令 | 先读 |
|---|---|---|
| 发现确切支持或 JSON 字段 | `capabilities`、`schema` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) |
| 冻结验收并获得规范内部路径 | `prepare` | 本文件 |
| 读取、摘要或检查 DOCX | `inspect` | [workflows.md](references/workflows.md) |
| 创建新文档或实质性重新设计 | `create` | [design-and-layout.md](references/design-and-layout.md)，然后 [specifications.md](references/specifications.md) |
| 在保留源文件的同时做定向编辑 | `edit` | [workflows.md](references/workflows.md)，然后 [specifications.md](references/specifications.md) |
| 添加审阅者批注或修订替换 | `review` | [ooxml-and-safety.md](references/ooxml-and-safety.md)，然后 [specifications.md](references/specifications.md) |
| 接受/拒绝更改或清除批注 | `finalize` | [workflows.md](references/workflows.md) |
| 比较两个文档版本 | `compare` | [workflows.md](references/workflows.md) |
| 清除个人元数据和修订标识符 | `sanitize` | [ooxml-and-safety.md](references/ooxml-and-safety.md) |
| 检查包完整性 | `validate` | 本文件 |
| 审计样式、层级、表格、无障碍或定稿状态 | `audit` | [design-and-layout.md](references/design-and-layout.md) |
| 将每一页转为 PNG 做视觉 QA | `render` | [workflows.md](references/workflows.md) |
| 用可见条目和页码填充活动目录 | `refresh-toc` | [workflows.md](references/workflows.md) |
| 初始化、记录并完成视觉 QA | `qa-init`、`qa-record`、`qa-finalize` | [workflows.md](references/workflows.md) |
| 运行较低层诊断门禁 | `preflight` | [workflows.md](references/workflows.md) |
| 将恰好一份已通过候选提升到请求的最终路径 | `deliver` | [workflows.md](references/workflows.md) |
| 把原始或先前路径解析为最新已交付会话版本 | `resolve-latest` | [workflows.md](references/workflows.md) |
| 执行标准 schema 之外的操作 | `fallback-patch` 或 `fallback-create` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md)，然后 [ooxml-and-safety.md](references/ooxml-and-safety.md) |

## 不可协商的操作契约

1. 在会话中第一次 DOCX 操作之前运行 `check`，然后运行 `capabilities`。对于修改请求，在第一次变更之前运行 `prepare`，以创建规范轮次路径并冻结验收。仅当依赖缺失且允许安装时才运行 `fix`。
2. 编写 JSON 规格之前运行 `schema --command <create|edit|review>`。未知字段和操作是错误；切勿假定它们已被应用。
3. 改每一份现有输入之前先校验并检查。阅读包特性和检查覆盖范围，而不仅是提取的段落文本。切勿绕过已声明的文档/写入保护。
4. 若操作被声明为受支持，先使用捆绑命令。不要用 `python-docx`、直接 ZIP/XML 变更或其他库替换它。
5. 若标准操作返回 `partial`、`unsupported` 或 `blocked`，停止并遵循 [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) 中的决策阶梯。切勿把这些状态当成成功。
6. 每一次回退都必须显式：说明未满足的能力和原因，把其程序放在 `WORKSPACE/tmp` 下，执行 `fallback-patch` 或 `fallback-create`，并把生成的清单保留在 `WORKSPACE/qa`。
7. 修改现有文档之前，运行 `resolve-latest --input <user-referenced-path>`，并把其 `resolved` 路径作为编辑基线。标准变更命令也会防御性地解析被跟踪的输入。仅当当前用户请求明确要求从更旧/原始版本重新开始时，才使用 `--use-exact-input`。
8. 应用能满足编辑请求的最小改动。保留原件，并把每一次变更写到 `PILOTDECK_WORK_DIR` 下的新内部候选。切勿把编号草稿、净化副本、回退候选或其他 DOCX 中间产物写到项目根目录。现有候选路径默认被阻断；`fallback-create` 从不覆盖。
9. 使用 `qa-init`，在检查完每一张当前页面图像后立即调用一次 `qa-record`，然后 `qa-finalize`。不要手写审阅 JSON、猜测工作路径，或自己对 PNG 做哈希。每条警告都必须修复或赋予具体处置。失败或未记录的视觉审阅是阻断项，不能被处置掉。
10. 预检通过后使用一次 `deliver`，把精确绑定 SHA-256 的候选提升到请求的最终路径。创建使用 `--new-document`，派生版本使用 `--source`。新文档必须使用尚不存在的最终路径；`--new-document --overwrite` 被阻断。现有文档工作默认使用新的最终文件名。单独的 `--overwrite` 从不允许替换源文件。
11. 仅当当前用户请求明确说要覆盖那一个确切文件时，才替换源文件。在那种情况下，也仅在那时，传入 `--source <path> --out <same-path> --replace-source`；命令会保留一份隐藏恢复副本并更新版本链。过去的同意或笼统偏好不够。
12. 只返回请求的交付物。除非被要求，否则规格、候选、清单、审计、PNG 页、可选 PDF、隐藏恢复副本和其他中间产物保持内部。自然提及最终文件名；PilotDeck 会渲染文件卡片。除非用户明确要求，否则不要添加 Markdown 下载/查看链接。

## 能力与结果协议

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

所有操作结果使用以下之一：

- `ok`：请求的操作在其声明保真度内完成。
- `partial`：输出或检查存在，但仍有未解析目标、警告、覆盖缺口或审阅。
- `unsupported`：请求的能力超出标准操作；选择已批准的回退或报告它。
- `blocked`：继续会危及保真度、签名、保护、包范围或安全。
- `error`：无效输入、无效规格、执行失败或无效输出。

只有 `ok` 是成功。不要使用 `|| true`、丢弃 stderr、把失败结果解析为交付物，或凭文件存在声称完成。

## 准备环境

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" check
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fix
```

`fix` 在用户缓存目录中创建隔离的 Python 环境，且从不全局安装包。LibreOffice 会被检测，但不会自动安装。

若 LibreOffice 不可用，`render` 和 `preflight` 报告 `unsupported`；完成结构校验和审计，披露视觉 QA 未完成，且不要声称交付通过了完整门禁。若渲染因其他原因失败，交付前先诊断环境。

## 在推理或编辑之前先检查

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --summary --out "$WORKSPACE/tmp/inspection-summary.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --search "target phrase" --max-items 50 \
  --out "$WORKSPACE/tmp/inspection-target.json"
```

至少审阅：

- 元数据和个人字段；
- 段落文本、样式、run 格式和位置；
- 标题顺序与层级；
- 表格和单元格内容；
- 节、页面尺寸、方向和边距；
- 页眉和页脚；
- 批注和修订计数；
- 域、图像、外部关系和校验警告。

当 `inspect` 能盘点某包特性但不能
解释其完整阅读顺序或行为时，会返回 `partial`，例如文本框、注释、
Office Math、SmartArt/图示、图表语义、内容控件、嵌入
对象、受保护文档行为或非标准自定义 XML。
只在明确覆盖的范围内继续；切勿把部分
检查描述为对文档的完整阅读。

对于只读问题，不要编辑或重新导出源文件。回答时保留来自标题、表格标签、注释和附近上下文的限定语。

## 有意识地创建新文档

在编写 JSON 规格之前：

1. 识别文档原型：简报、备忘录、报告、提案、SOP、参考指南、表单或简单文档。
2. 在 `prepare` 期间恰好冻结一条样式路径：
   - 仅当用户提供了具体视觉
     要求、参考模板，或必须保留样式的现有 DOCX 时，才使用 `--style-mode user`。记录匹配的 `--style-source` 和任何显式
     `--style-requirement`。
   - 其他每一次创建请求都使用 `--style-mode builtin`。诸如
     “report”、“professional”、“formal”、“business” 或 “polished” 这类词是文档
     目标，不是发明配色主题的许可。
   内置 `neutral-document-v1` 模板是唯一默认：黑色
   标题和标题样式、带中性线条的白色表格、克制的标注，
   以及感知区域的中文/西文排版。
3. 阅读 [design-and-layout.md](references/design-and-layout.md)。把每个主要信息单元映射为散文、列表、步骤、清单、标注、定义列表、真实数据表、图像或来源。
   若用户请求插图、图示、图表或数据图，把
   图像存在当作验收要求。在返回的 `tmp` 路径下生成本地资源，并使用标准图像块；不要只生成
   从未进入 DOCX 的图像。
4. 当交付物需要封面、目录和正文时，选择 `--document-structure formal-report`。该结构拥有分页边界：封面页、
   新页上的目录，以及另一新页上的正文。对没有这三部分结构的简报、
   备忘录、表单和文档使用 `simple`。
5. 查询 `schema --command create`，阅读 [specifications.md](references/specifications.md)，并用仅受支持的块创建规格。把冻结的 `document_structure` 复制进规格。
6. 运行标准 `create`。若 schema 无法表达所需特性，在编写自定义代码之前遵循受控回退决策。
7. 生成、检查，相关时比较，并运行预检。

对于新文档，除非当前用户明确请求，否则省略 `header`、`footer`、`PAGE` 和 `NUMPAGES`。`prepare` 默认拒绝这三项；
create 和预检门禁会强制冻结后的决策。

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" create \
  --spec "$WORKSPACE/tmp/document.json" \
  --acceptance "$WORKSPACE/qa/acceptance.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

不要依赖 Word 默认值来处理页面几何、标题行高、标题层级、列表语义、表格宽度或单元格内边距。优先使用可复用的 Word 样式和真实列表定义，而不是手工格式化的仿制品。图表可以生成为本地图像，并通过图像块引用，而不进入完整创建回退。当用户要求一张或多张图时，冻结 `--min-images`，使纯文本候选无法通过。

创建规格的 `style_policy` 必须与冻结的
验收清单完全匹配。内置模式拒绝样式覆盖、逐 run 的颜色或
字号、段落样式替换、标注颜色，以及表格样式/颜色
覆盖。用户模式只能表达用户提供的具体样式。
不要在看到草稿后再切换模式。

若候选路径已存在，使用 `WORKSPACE/tmp` 下的另一路径，或有意替换该内部候选。不要在项目根目录创建版本化候选。

打开时自动更新域默认关闭。不要仅为填充目录或页码域而设置
`update_fields_on_open: true`；它可能
让 Word 显示外部域警告。使用 `refresh-toc` 缓存可见
目录条目，且不会在打开时提示。

## 对外现有文档做外科式编辑

即使用户或对话仍点名最初上传的路径，也先解析编辑基线：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" resolve-latest \
  --input "$REQUESTED_INPUT_DOCX"

# 将 INPUT_DOCX 设为返回的 `resolved` 路径。
```

对受支持的局部更改使用 `edit`：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" edit \
  --input "$INPUT_DOCX" \
  --patch "$WORKSPACE/tmp/edits.json" \
  --acceptance "$WORKSPACE/qa/acceptance.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

除非用户要求重新设计，否则保留结构和格式。优先行内替换而非段落替换，优先段落替换而非整篇重建。使用标准 `insert_image`，在明确的段落锚点之前或之后放置本地图；不要为普通行内插图跳到 OOXML 回退。歧义目标需要 `occurrence` 或 `location`。缺失目标返回 `partial`；它不是成功的空操作。

当可能丢失包敏感特性时，标准编辑器会阻断 `python-docx` 往返。优先使用带窄 OOXML 部件白名单的 `fallback-patch`。仅当用户明确接受所列保真度风险时才使用 `--allow-lossy`；记录该决策。

`--overwrite` 授权替换现有内部候选或一份不同的
派生输出文件。它从不授权替换源文件。不要仅仅因为用户提供了原始文件名就传入
`--use-exact-input`；
版本链会有意把该名称解析到最新已交付
修订。

当用户请求可审阅更改时，使用批注或修订替换。不要把审阅任务静默变成干净重写。

## 管理审阅生命周期

添加批注和修订替换：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" review \
  --input "$INPUT_DOCX" \
  --spec "$WORKSPACE/tmp/review.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

定稿已审阅文档：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" finalize \
  --input "$INPUT_DOCX" \
  --accept-changes --remove-comments \
  --out "$WORKSPACE/tmp/candidate.docx"
```

请求时用 `--reject-changes` 代替 `--accept-changes`。切勿同时传入两者。审阅后和定稿后再检查，因为页面渲染并不能可靠暴露批注锚点。

## 校验与审计

校验 ZIP 包、必需 OOXML 部件、XML 良构性、归档安全和宏缺失：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate \
  --input "$WORKSPACE/tmp/candidate.docx"
```

审计语义和版式风险：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile draft --out "$WORKSPACE/qa/draft-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile final --out "$WORKSPACE/qa/final-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile accessible --out "$WORKSPACE/qa/a11y-audit.json"
```

按如下解释配置：

- `draft`：标记层级、假列表、过小文字、不稳定表格几何、过窄边距和格式漂移。
- `final`：包含草稿检查，并在仍有批注或修订时使审计失败；警告个人元数据。
- `accessible`：包含终稿检查，并标记缺失的图像替代文本或未标记的重复表头。

即使 `passed` 为 true，审计仍可包含警告。带错误
或部分检查覆盖的审计会返回顶层 `status: partial`；不得
当作成功审计。最终交付更严格：每条警告
都必须修复，或包含在把其问题代码映射到
具体理由的处置 JSON 中。

## 渲染并检查每一页

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out-dir "$WORKSPACE/qa/rendered" --emit-pdf
```

检查每一张 PNG 是否有：

- 裁切、重叠、缺失或被替换的文字；
- 损坏字形和不恰当的字体回退；
- 落在页底的孤立标题；
- 别扭的空白页或无法解释的大空隙；
- 换行或缩进不正确的列表；
- 表格溢出、过窄叙述列、拥挤单元格、丢失表头或被拆开的行；
- 超出边距的图像、变形缩放或分离的题注；
- 不一致的节几何；
- 错位的页眉、页脚和分页符。

渲染核验可见版式，但不核验全部文档语义。用 `inspect`、`audit` 或感知 OOXML 的命令在结构上核验批注、修订、关系、域和元数据。

## 刷新域、证明验收，并只交付一次

`create` 会插入活动目录域，但不会发明可见页码。当
规格包含目录时，在内容稳定后刷新其缓存结果：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" refresh-toc \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out "$WORKSPACE/tmp/candidate-with-toc.docx" \
  --render-dir "$WORKSPACE/qa/toc-render"

CANDIDATE_DOCX="$WORKSPACE/tmp/candidate-with-toc.docx"
```

`refresh-toc` 渲染文档，在渲染页上定位语义 Heading 段落，
并在保留活动域的同时写入可见缓存
条目、点状前导符和页码。缓存结果稳定后，它也会关闭打开时更新，
这样 Word 不会仅仅因为文档包含目录就提示。不要用手工打字的目录页替代。若
没有目录，把 `CANDIDATE_DOCX` 设为当前内部候选。

第一次变更之前，用 `prepare` 冻结验收并获得规范任务
路径：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" prepare \
  --style-mode builtin \
  --document-structure formal-report \
  --require-text "Executive Summary" \
  --require-heading "1:Executive Summary" \
  --min-pages 8 --max-pages 12 \
  --min-images 2 \
  --require-toc \
  --protect-source "/absolute/path/to/source.xlsx"
```

按需重复 `--require-text`、`--require-heading` 和 `--protect-source`。
仅当图是用户请求的一部分时才使用 `--min-images`。
`formal-report` 会自动要求已填充的语义目录，并冻结
封面/目录/正文的分页。
对于编辑，添加 `--existing-document`。页眉、页脚和页码
权限保持关闭，除非当前请求明确要求它们：

```bash
--allow-header
--allow-footer
--allow-page-numbers
```

只使用实际请求的权限。页脚中的页码需要
同时有 `--allow-footer` 和 `--allow-page-numbers`。

`prepare` 还会把当前工作区冻结为默认交付边界。
当用户未指定目的地时，在该工作区内选择最终 `.docx` 路径。切勿选择桌面、下载、另一个项目或任意绝对路径。仅当当前用户明确提供
确切的工作区外路径时，`prepare` 才可以包含：

```bash
--external-output "/exact/user/requested/path/result.docx"
```

这只授权那条确切路径。明确要求替换现有源文件由 `deliver --replace-source` 另行处理。
对于用户指定的样式，把 `--style-mode builtin` 替换为以下之一：

```bash
--style-mode user --style-source explicit-requirements \
  --style-requirement "Use the supplied navy brand color for Heading 1"
--style-mode user --style-source reference-template
--style-mode user --style-source existing-document
```

仅对当前请求或输入中存在的证据使用用户模式。
仅当标题级别是要求的一部分时才使用 `LEVEL:TEXT`。
省略用户未请求的约束；切勿仅仅为了让门禁通过而发明页数。`prepare` 会自行对受保护源做哈希，并返回
确切的 `tmp`、`qa`、候选、验收、渲染和报告路径。对完整任务复用
冻结清单。仅当当前用户请求改变验收要求时才运行 `prepare --overwrite`，切勿
在候选失败之后运行。

候选稳定后，初始化确定性 QA：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-init \
  --input "$CANDIDATE_DOCX" \
  --profile final \
  --disposition "personal-metadata=The user explicitly requested this author."
```

`qa-init` 运行自动化门禁，写入初始报告，渲染
最新候选，并创建已绑定到
候选 SHA-256 和每张解码页面图像 SHA-256 的待处理视觉审阅文件。其顶层
`status: ok` 表示 QA 初始化完成；并不表示候选
已通过。阅读 `automated_gate` 并解决每一个错误。修复警告或添加
具体处置；切勿使用笼统的 “acceptable” 理由。

打开 `qa-init` 返回的每一页路径。检查完一页后立即记录该页特定结果：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-record \
  --page 1 --status passed \
  --notes "Cover title, margins, and body content are complete and unclipped."

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-record \
  --page 2 --status passed \
  --notes "TOC entries, dot leaders, and page numbers are visible."
```

不要编辑视觉审阅 JSON、复制哈希，或对 PNG
文件运行 `sha256sum`。PNG 容器字节哈希与门禁使用的规范化解码像素哈希有意不同。`qa-record` 保留
规范摘要，并为恰好一页添加带时间戳的记录。检查
并记录每一张当前页；不要从缩略图推断未查看的页，或
复用笼统备注。

用同一候选完成门禁：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-finalize \
  --input "$CANDIDATE_DOCX"
```

`qa-finalize` 对照 `qa-init` 产出的那次确切渲染，校验当前候选、冻结验收、受保护
源和已记录审阅；
它不会创建第二次、可能不同的 LibreOffice 渲染。警告
处置属于 `qa-init`。若它们改变，在审阅页面之前重跑 `qa-init --overwrite`。任何候选变更也会使审阅过期：
重跑 `qa-init --overwrite`，检查新渲染的页面，并再次记录。较低层的 `preflight` 命令仍可用于诊断
和兼容，但修改工作流必须使用确定性 QA
命令。裸的 `--visual-review-status passed` 会被有意拒绝，
因为它不提供页面证据。

交付需要非空验收清单，并且仅当
预检报告 `status: ok`、`passed: true`、
`coverage.status: passed` 和 `visual_review.status: passed` 时通过。把那份
确切候选提升一次：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" deliver \
  --input "$CANDIDATE_DOCX" \
  --preflight-report "$WORKSPACE/qa/preflight-final.json" \
  --out "$FINAL_DOCX" \
  --new-document
```

`deliver` 对照成功报告核验候选 SHA-256，并
原子写入唯一项目可见 DOCX。预检后的任何变更
都会使交付失效，并需要新的预检。

相对 `--out` 路径从 `prepare` 冻结的工作区解析。
工作区外交付会被阻断，除非该确切路径已用
`--external-output` 冻结；笼统的 `--overwrite` 从不扩大该边界。

`deliver` 会阻断仍请求自动域更新的文档。
`--allow-update-fields-on-open` 是例外选择加入：仅当
当前用户明确请求动态更新并接受 Word 打开
提示时才使用。仅有警告处置并不是使用该标志的许可。

对于已编辑/审阅/定稿/净化的文档，把
`--new-document` 替换为 `--source "$REQUESTED_INPUT_DOCX"`。命令会把
已交付结果记录为最新会话版本，因此后续轮次点名
原始或任何先前修订时会从该结果继续。

默认情况下，`FINAL_DOCX` 必须是同时区别于请求
源和已解析最新版本的新路径。只有当前明确请求例如
“直接覆盖原文件”才允许：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" deliver \
  --input "$CANDIDATE_DOCX" \
  --preflight-report "$WORKSPACE/qa/preflight-final.json" \
  --source "$REQUESTED_INPUT_DOCX" \
  --out "$REQUESTED_INPUT_DOCX" \
  --replace-source
```

该例外模式会在原子替换之前保存一份经摘要核验的隐藏恢复副本。切勿从 `--overwrite`、更早一轮，
或为了避免选择新文件名而推断它。

## 比较与净化

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare \
  --before "$INPUT_DOCX" --after "$WORKSPACE/tmp/candidate.docx" \
  --out "$WORKSPACE/qa/comparison.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize \
  --input "$INPUT_DOCX" \
  --out "$WORKSPACE/tmp/sanitized-candidate.docx" \
  --remove-comments
```

`compare` 报告段落级文本差异和文档计数；它不是像素对比，也不能证明格式等价。`sanitize` 清除核心个人元数据、自定义属性、修订标识符，以及可选的批注；它不会从可见文档内容中涂改敏感词。

## 安全与保真规则

- 只接受 `.docx`。拒绝 `.doc`、`.docm`、`.dotm` 和不相关的 ZIP 归档。
- 拒绝不安全的归档路径、畸形 XML、宏载荷和异常膨胀的包。
- 切勿抓取远程图像。只使用本地工作区文件。
- 默认保留源文件并交付新版本。替换源文件
  需要当前用户的明确指示和 `--replace-source`。
- 不要声称已从渲染页视觉核验批注。
- 不要绕过文档或写入保护。不要在没有明确检查的情况下，对数字签名、嵌入对象、注释、Office Math、SmartArt/图示、复杂内容控件或自定义 XML 声称完全保真。在触碰包敏感文档之前阅读 [ooxml-and-safety.md](references/ooxml-and-safety.md)。
- 切勿把自定义 DOCX 构建器直接作为交付路径运行。必须先尝试标准操作或声明其不足；自定义代码必须通过受控回退命令和清单运行。
- 把引用和来源保留为普通人可读的文档文本。切勿在文档中暴露内部工具令牌、私有路径、凭据或隐藏推理。
- 不要把生成的事实呈现为有来源。保留已有引用，并清楚区分提供的事实与起草的语言。

## 交付门禁

返回 DOCX 之前，确认以下全部成立：

- 请求的内容和编辑已完成；
- 只有一份项目可见的最终 DOCX；所有候选和 QA 文件仍在本轮工作目录下；
- 输出是由 `deliver` 产生的新的、有效 `.docx`，除非当前
  用户请求明确授权了 `--replace-source`；
- 现有文档工作流以最新被跟踪修订为基线；
- 预检报告 `status: ok`、`passed: true`、`coverage.status: passed` 和 `visual_review.status: passed`；
- 每条警告都已修复或有具体已记录处置；
- 最新候选的每一张渲染页都有非空审阅备注；
- 所需标题、页数约束、图像数量、文档结构、目录状态和受保护源哈希满足验收清单；
- 批注和修订匹配请求的交付状态；
- 元数据和隐私状态匹配请求；
- 已交付 SHA-256 与通过的预检报告匹配；
- 回复提及最终文件名，且没有主动添加的 Markdown 下载/查看链接。

更改本技能本身时，运行捆绑的端到端回归：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" self-test
```
