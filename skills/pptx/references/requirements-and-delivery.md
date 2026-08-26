# 需求与最终交付

## 有选择地使用需求文件

当用户提供确切事实、数量、必选章节、特定幻灯片文案或基准验收标准时，创建需求文件。对于没有明确覆盖要求的开放式视觉探索，跳过它。

```json
{
  "schemaVersion": 1,
  "slideCount": 10,
  "requirements": [
    {
      "id": "win-reason-values",
      "label": "Win-reason values 11 / 9 / 7",
      "priority": "critical",
      "terms": ["11", "9", "7"],
      "match": "all",
      "slides": [6]
    },
    {
      "id": "mobile-experience",
      "priority": "recommended",
      "terms": [["mobile experience", "移动体验"]]
    }
  ]
}
```

当必须有精确页数时，使用顶层 `slideCount`。每一项 term 可以是字符串，也可以是可接受别名的数组。`match` 默认为 `all`；仅当一种备选即可时使用 `any`。缺失关键需求会使覆盖失败。缺失推荐需求仍是必须修复或显式处置的审计警告。当每一项关键需求都存在时，覆盖本身为 `passed`。

此项检查确认提取的幻灯片文本覆盖。除非提供了幻灯片选择器，否则它不能证明主张正确、可读，或位于预期视觉位置。

## 核验一份不可变产物

对于全新演示文稿，构建并核验一次：

```bash
bash "$PPTX" deliver \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --require-coverage \
  --target-platform cross-platform \
  --require-render
```

`deliver` 会从质量目录自动发现 `WORKSPACE/tmp/requirements.json`，但只要存在精确标准就使用 `--require-coverage`，以便缺失清单时以失败关闭。对于模板输出或已构建的最终产物，使用 `--input "$FINAL_PPTX"`。使用 `--input "$WORKSPACE/qa/candidate.pptx" --out "$FINAL_PPTX"`，在添加处置后封存已审阅的候选文件。

交付报告记录结构性审计和渲染前后的 PPTX SHA-256。`deliver --builder` 构建到质量候选路径，并仅在每一项门禁都通过时将其复制到所要求的输出。切勿交付候选文件，也切勿在最后一次成功的封存交付报告之后重建或编辑该文件。

## 处置警告

在构建器中修复真正的缺陷。对于有意重叠、已核验的误报或已接受的渲染器限制，使用来自 `audit.json` 的警告 ID 创建处置文件：

```json
{
  "schemaVersion": 1,
  "artifactSha256": "<sha256 from audit.json>",
  "warnings": [
    {
      "id": "overlap:slide-4:timeline-node-label",
      "decision": "intentional",
      "reason": "The label is visually centered over its background field in the full-size render.",
      "evidence": "qa/slides/slide-04.png reviewed at full size"
    }
  ]
}
```

允许的决策为 `accepted`、`intentional` 和 `false_positive`。每一项处置都需要精确的产物哈希、具体原因和视觉证据。未知警告 ID、重复 ID、缺失证据和过期产物哈希会被拒绝。使用 `--dispositions` 重新运行 `deliver --input candidate.pptx --out "$FINAL_PPTX"`，以便封存未更改的候选文件。

## 解读状态

- `passed`：没有错误或未解决警告；覆盖和所需渲染已通过。
- `passed_with_warnings`：仅作为中间审计结果；产物未封存以供交付。
- `failed`：结构性错误、缺失关键需求、所需渲染失败、页数不匹配或产物完整性失败会阻断交付。

启发式文本适配警告和 LibreOffice 字体替换不会自动成为 PowerPoint 缺陷。
