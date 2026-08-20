---
name: pptx
description: 创建、编辑、检查、渲染并校验可编辑的 Microsoft PowerPoint（.pptx）演示文稿，并通过已验证的转换将旧版二进制 .ppt 导入为 .pptx。用于原生 PowerPoint 创建、修改、模板继承、图表、表格、图像、旧版 .ppt 迁移以及幻灯片级质量保证。不要用于 HTML/浏览器演示文稿或 Google Slides。
---

# PPTX

通过可复现的 JavaScript 工作流创建和修改原生 PowerPoint 文件。保留 `.mjs` 构建脚本，渲染每一张终稿幻灯片，并在交付前修复结构与视觉缺陷。

## 硬性要求

- 使用 JavaScript ES 模块和捆绑的 `scripts/pptx.sh` 工作流。
- 全新幻灯片使用 PptxGenJS；继承模板幻灯片使用 pptx-automizer。
- 不要使用 `python-pptx`、`@oai/artifact-tool`、Google Slides API，或 HTML-to-PPTX 创作路径。
- 保留每一份输入 PPT 或 PPTX。除非用户明确要求替换，否则把编辑和转换写到不同的 `.pptx` 输出。
- 幻灯片文案面向观众。不要在幻灯片上暴露规划备注或实现说明。
- 将每一张终稿幻灯片渲染为 PNG，并按全尺寸检查每一页。拼图只作总览。
- 修复非预期裁切、溢出、换行、重叠、图像裁剪、断开的连接线、未解析的占位符、页脚/页码不一致，以及图表/数据不匹配。
- 最后一次构建或核验使用 `deliver`，使 PPTX 哈希、覆盖率、审计、渲染和封印都指向同一制品。最终报告之后不要再编辑或重建。
- 切勿追加 `|| true`、抑制 stderr，或以其他方式绕过 `deliver`。只有当 `delivery.status` 和 `delivery.seal.status` 都为 `passed` 时，文件才算终稿。
- 不要忽略 `audit` 警告。修复真实缺陷；对已核实的误报、有意重叠和已接受的渲染器限制给出明确处置。每条处置必须绑定到确切的 PPTX SHA-256，并包含具体理由和视觉证据。

## 阅读相关参考

- 规划幻灯片之前，始终阅读 [content-and-narrative.md](references/content-and-narrative.md)。
- 编写构建脚本之前，阅读 [api-quick-start.md](references/api-quick-start.md)。
- 没有提供模板的幻灯片，阅读 [design-and-layout.md](references/design-and-layout.md)。
- 当源 PPTX 提供视觉体系或可编辑框架时，阅读 [template-following.md](references/template-following.md)。
- 添加图表或定量表格之前，阅读 [charts-and-data.md](references/charts-and-data.md)。
- 当没有模板控制排版时（尤其是中文或中英混排），阅读 [typography-and-fonts.md](references/typography-and-fonts.md)。
- 当任务包含确切事实、必选章节、基准标准或高风险交付要求时，阅读 [requirements-and-delivery.md](references/requirements-and-delivery.md)。
- 当输入是 `.ppt`、扩展名含糊，或由 PowerPoint 97–2003 创建时，阅读 [legacy-ppt-conversion.md](references/legacy-ppt-conversion.md)。
- 交付前阅读 [qa-checklist.md](references/qa-checklist.md)。

## 解析路径并准备运行时

将包含本文件的目录解析为 `PPTX_SKILL_ROOT`，然后使用：

```bash
PPTX="$PPTX_SKILL_ROOT/scripts/pptx.sh"
bash "$PPTX" check || bash "$PPTX" fix
```

所有中间产物都使用本轮作用域的 PilotDeck 工作目录。宿主会设置 `PILOTDECK_WORK_DIR`；回退路径把手动运行限制在项目内部：

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/pptx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

把构建脚本、转换后的输入、源备注、渲染图、清单、映射、候选文件和 QA 报告放在 `WORKSPACE`。只有请求的最终交付物才放到项目或用户选定的输出目录。切勿在用户文件旁边创建 `.pilotdeck_build.mjs`、QA 目录或其他中间产物。不要用 Git ignore 变更来隐藏临时文件。

## 路由请求

恰好选择一条路线：

1. 旧版 `.ppt` 输入：保留它，一次性转换为已验证的临时 `.pptx`，检查配对渲染，下游只使用转换后的 `.pptx`。
2. 现有 PPTX 仅检查或回答问题：检查整套幻灯片；除非被要求，否则不要编辑。
3. 无模板的全新 PPTX：除非用户给出明确视觉方向，否则使用 PilotDeck 布局库。
4. 有明确视觉方向的全新 PPTX：构建自定义构图；不要与默认库混用。
5. 基于模板的创建或编辑：只把提供的源幻灯片作为视觉体系，并遵循模板模式。

当请求的输出是基于浏览器的 HTML 演示文稿时，改用 `diagram-maker` 生成本地 HTML/SVG。切勿把原生 Google Slides 或在线演示服务请求路由到本技能。

## 先规划表达，再写代码

写一句话，说明受众、期望结果和最重要的一条结论。然后做幻灯片计划，每页只承担一项任务。宁可做成连贯论证，也不要堆砌事实。

把视觉与叙事一起规划。仅当能提升理解时，才使用一张有力的图片、图表、表格或简单图示。除背景外不要重复同一张图。避免做成仪表盘、设置页或 UI 卡片网格那样的演示页。

当没有模板控制排版时，用 `resolveDesignTokens` 解析 locale 配置。未指定的简体中文或中英混排交付使用 `cross-platform-zh`，英文使用 `cross-platform-en`。仅当目标平台已知时才使用平台专用配置。在把字号缩小到所选密度配置以下之前，先缩短文案或改布局。

当用户提供确切数值、必用短语、必选章节或基准标准时，在创作前创建一份轻量需求文件。只有真正阻断的项才标为 `critical`；把偏好细节标为 `recommended`，以免 Harness 过度约束创作。

## 控制投入，不要用墙钟时限截断

优先交付完整、正确、可编辑且可审计的幻灯片，而不是反复视觉打磨。API 或工具等待时间不是停止仍在推进的任务的理由。

1. 每个源只读取并规范化一次；复用已提取的事实和文件哈希。
2. 在视觉打磨之前先确立完整幻灯片结构，然后产出一份可用的全套构建。
3. 运行 `audit` 并渲染全套。在审美细节之前，先修复关键内容、溢出、裁切和非预期重叠。
4. 硬性要求通过后，最多再做一轮可选的视觉抛光，除非用户明确要求更多。
5. 不要为细小间距、颜色或装饰差异重建整套幻灯片。只检查并修复受影响的页。
6. 使用捆绑的排版配置。除非所选字体破坏目标 PowerPoint 输出，否则不要扫描系统或反复比较字体。
7. 不要仅因为 LibreOffice 对中文字形的替换不同就重写一份有效幻灯片。把 PowerPoint 当作目标查看器，并记录该基线限制。
8. 当审计警告在视觉上是有意的，给出处置，而不是反复重做该页。

## 转换旧版 PPT

不要把 `.ppt` 直接交给 OOXML 检查或模板编辑。先转换并核验：

```bash
bash "$PPTX" convert \
  --input "$SOURCE_PPT" \
  --out "$WORKSPACE/tmp/source-converted.pptx" \
  --qa-dir "$WORKSPACE/legacy-conversion-qa"
```

检查源与转换后的拼图以及转换报告。页数或结构失败会阻断使用。视觉差异或旧版特性警告需要审阅，但不等于声称 `.ppt` 已无损转换。保留原始 `.ppt`；最终输出仍是 `.pptx`。

## 构建全新幻灯片

创建可执行构建脚本：

```bash
bash "$PPTX" scaffold --out "$WORKSPACE/tmp/deck.mjs"
```

编辑构建脚本，使其默认导出接收 PilotDeck 工具包并返回 PptxGenJS 演示文稿。使用普通 `.mjs`；不要加转译器。按内容语言解析设计令牌，把同一套令牌传给 `createDeck` 和布局函数，并为后续可能编辑的对象设置 PptxGenJS `objectName`。

构建 PPTX：

```bash
bash "$PPTX" build \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX"
```

仅当没有更强的视觉来源时，才使用捆绑的布局注册表和设计令牌：

- `assets/layout-library/template-registry.json`
- `assets/layout-library/design-tokens.json`
- `assets/layout-library/layouts/core.mjs`

不要用尽每一种可用布局填满幻灯片。选择能支撑故事的最小集合，并在整套中变化页面轮廓。

## 遵循提供的模板

在映射输出页之前，检查并渲染完整源幻灯片：

```bash
bash "$PPTX" inspect \
  --input "$TEMPLATE_PPTX" \
  --out "$WORKSPACE/tmp/template-manifest.json"

bash "$PPTX" render \
  --input "$TEMPLATE_PPTX" \
  --out-dir "$WORKSPACE/tmp/template-slides" \
  --montage "$WORKSPACE/tmp/template-montage.png"
```

创建 `template-frame-map.json`。把每一张输出页映射到一张源页，并列出允许改动的精确继承对象。编辑前校验映射：

```bash
bash "$PPTX" validate-map \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --out "$WORKSPACE/tmp/template-map-validation.json"
```

先创建未经编辑的起始幻灯片：

```bash
bash "$PPTX" prepare-starter \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --out "$WORKSPACE/tmp/template-starter.pptx"
```

渲染源与起始稿，然后运行 `fidelity`。在应用编辑之前解决无法解释的差异。只应用框架映射授权的操作：

```bash
bash "$PPTX" apply-template \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --edits "$WORKSPACE/tmp/template-edits.json" \
  --out "$FINAL_PPTX"
```

不要在无法访问的模板对象上叠加替换对象。若请求的目标无法保留或无法安全修改，停止并报告不支持的对象以及最接近、仍可用的源页备选。

## 图表、图示与图像

- 生成前校验图表类别数量、系列长度、单位、标签和显示合计。
- 为外部调研的数值和视觉素材保留源备注。
- 先创建连接线再创建图示节点，让边位于节点后面。
- 简单图示只用原生形状。复杂或偏审美的视觉使用准备好的栅格或 SVG 资源。
- 放置前确定图像宽高比和预期裁切。使用工具包中的 `imageSizingCrop` 或 `imageSizingContain`，不要拉伸图像。
- 不要把装饰形状当作主要视觉内容。

## 渲染与校验

重大修订后，用 `audit` 和 `render` 做快速迭代：

```bash
bash "$PPTX" audit \
  --input "$FINAL_PPTX" \
  --out "$WORKSPACE/qa/audit.json"

bash "$PPTX" render \
  --input "$FINAL_PPTX" \
  --out-dir "$WORKSPACE/qa/slides" \
  --montage "$WORKSPACE/qa/montage.png" \
  --pdf "$WORKSPACE/qa/rendered.pdf"
```

按全分辨率检查每一张 `slide-N.png`。把渲染页数与 PPTX 清单比较。修订构建脚本或模板编辑映射，重建并重复，直到所有硬失败消失，且每条警告都已解决或在视觉上确认为有意。

最终的全新构建运行：

```bash
bash "$PPTX" deliver \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --target-platform cross-platform \
  --require-render
```

对于精确覆盖率标准，把 `requirements.json` 保存在 `WORKSPACE/tmp` 下并加上 `--require-coverage`。`deliver` 会自动发现该文件。对于模板输出，改为运行 `deliver --input "$FINAL_PPTX"`。

若首次交付被警告阻断，检查全尺寸 PNG 和 `audit.json`。创建绑定哈希的处置文件，然后封印未改动的 QA 候选：

```bash
bash "$PPTX" deliver \
  --input "$WORKSPACE/qa/candidate.pptx" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --dispositions "$WORKSPACE/tmp/warning-dispositions.json" \
  --require-coverage \
  --target-platform cross-platform \
  --require-render
```

不要交付 `candidate.pptx`。只有 `passed` 的交付才会封印到 `FINAL_PPTX`。把 Microsoft PowerPoint 当作目标查看器，把 LibreOffice 当作自动化基线，尤其是中文字体替换。

修改本技能或其运行时之后，运行捆绑的集成测试：

```bash
bash "$PPTX" self-test --out "$WORKSPACE/self-test"
```

## 交付

返回已封印的最终 `.pptx` 和简明摘要。说明核验已通过，并披露已接受的兼容性限制。对于旧版输入，说明已将保留的 `.ppt` 转换为 `.pptx`，且宏、旧版动画、OLE 对象、WordArt、媒体和不常见字体不保证无损。除非用户要求，否则不要交付构建脚本、候选文件、清单、框架映射、渲染图或 QA 报告。
