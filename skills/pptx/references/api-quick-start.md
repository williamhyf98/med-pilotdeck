# API 快速入门

所有命令示例都假定使用下列按轮次限定的路径。将每个构建器、候选文件、转换、渲染和报告都放在 `WORKSPACE` 下；只有 `FINAL_PPTX` 面向用户。

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/pptx"
FINAL_PPTX="$PWD/<requested-output>.pptx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

## 构建器约定

创建普通 ES 模块，导出一个异步函数并返回 PptxGenJS 演示文稿：

```js
export default async function build({ createDeck, layouts, resolveDesignTokens, pptxgenjs, imageSizingCrop }) {
  const tokens = await resolveDesignTokens({
    lang: 'zh-CN',
    profile: 'cross-platform-zh',
    density: 'presentation',
  });
  const pptx = await createDeck({ title: 'Example deck', lang: 'zh-CN', tokens });

  layouts.titleSlide(pptx, tokens, {
    eyebrow: 'Example',
    title: 'A clear title',
    subtitle: 'One sentence of useful context.',
    meta: 'Team · 2026',
  });

  layouts.chartSlide(pptx, tokens, {
    title: 'Adoption increased in every segment',
    type: pptx.ChartType.bar,
    series: [{ name: 'Adoption', labels: ['A', 'B', 'C'], values: [42, 57, 71] }],
    takeaway: 'Segment C leads by 14 points.',
    source: 'Source: verified internal data',
    page: 2,
  });

  return pptx;
}
```

迭代时使用 `build`。最终构建使用 `deliver`，使已验证的哈希、审计和渲染绑定到同一个 PPTX：

```bash
bash "$PPTX" build --builder "$WORKSPACE/tmp/deck.mjs" --out "$WORKSPACE/tmp/candidate.pptx"
bash "$PPTX" deliver --builder "$WORKSPACE/tmp/deck.mjs" --out "$FINAL_PPTX" --qa-dir "$WORKSPACE/qa" --target-platform cross-platform --require-render
```

## 工具包成员

- `createDeck(options)`：创建带主题的宽屏演示文稿。
- `resolveDesignTokens(options)`：选择与区域、平台和密度相关的排版令牌。
- `layouts`：12 个 PilotDeck 核心版式函数。
- `tokens`：画布、调色板、排版和间距值。
- `pptxgenjs`：PptxGenJS 构造函数和枚举持有者；尽可能从已创建的实例访问 `pptx.ShapeType` 和 `pptx.ChartType`。
- `imageSizingCrop(path, x, y, w, h)`：准备居中裁切。
- `imageSizingContain(path, x, y, w, h)`：在不变形的情况下适配图像。

## 对象命名

为有意义的元素设置 PptxGenJS `objectName`。使用稳定名称，例如 `Slide Title`、`Primary Chart`、`Hero Image` 和 `Page Number`。模板框架映射按 `inspect` 输出中暴露的名称寻址对象。

## 常用命令

```bash
bash "$PPTX" convert --input "$SOURCE_PPT" --out "$WORKSPACE/tmp/converted.pptx" --qa-dir "$WORKSPACE/qa/legacy"
bash "$PPTX" scaffold --out "$WORKSPACE/tmp/deck.mjs"
bash "$PPTX" build --builder "$WORKSPACE/tmp/deck.mjs" --out "$WORKSPACE/tmp/candidate.pptx" --verify --qa-dir "$WORKSPACE/qa/iteration"
bash "$PPTX" deliver --builder "$WORKSPACE/tmp/deck.mjs" --out "$FINAL_PPTX" --qa-dir "$WORKSPACE/qa" --require-render
bash "$PPTX" deliver --input "$WORKSPACE/qa/candidate.pptx" --out "$FINAL_PPTX" --qa-dir "$WORKSPACE/qa" --requirements "$WORKSPACE/tmp/requirements.json" --require-coverage --dispositions "$WORKSPACE/tmp/warning-dispositions.json" --require-render
bash "$PPTX" inspect --input "$FINAL_PPTX" --out "$WORKSPACE/qa/manifest.json"
bash "$PPTX" audit --input "$FINAL_PPTX" --out "$WORKSPACE/qa/audit.json" --target-platform cross-platform
bash "$PPTX" render --input "$FINAL_PPTX" --out-dir "$WORKSPACE/qa/slides" --montage "$WORKSPACE/qa/montage.png"
```

`deliver --builder` 会在质量目录下写入中间候选文件。仅当交付状态为 `passed` 时才创建所要求的输出。不要绕过退出状态，也不要交付 `candidate.pptx`。
