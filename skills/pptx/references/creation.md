# 创建 PowerPoint

Agent 只填写 `pptx.sh make` 的参数；不要编写 JavaScript 或 Python。

## 常见调用

```bash
bash "$PPTX_TOOL" make \
  --title "演示标题" \
  --markdown "$PWD/scratch/qa/slides.md" \
  --out "$PWD/exports/演示标题.pptx"
```

短内容可直接用 `--body`；长内容用 `--body-file` 或 `--markdown`。

## Markdown

```markdown
# 战创伤四级救治

## 现场处置
- 快速评估威胁
- 控制致命性出血

## 紧急救治
- 稳定气道与呼吸
- 建立后送优先级
```

第一个一级标题可作为演示标题。后续一级标题生成章节页，二/三级标题生成
内容页。标题下段落和列表成为该页要点。

## JSON spec

```json
{
  "title": "战创伤四级救治",
  "subtitle": "离线教学演示",
  "locale": "zh-CN",
  "footer": "内部培训",
  "slides": [
    {
      "type": "content",
      "title": "现场处置",
      "items": ["快速评估威胁", "控制致命性出血"]
    },
    {
      "type": "timeline",
      "title": "救治链",
      "steps": [
        {"label": "一级", "detail": "现场处置"},
        {"label": "二级", "detail": "紧急救治"},
        {"label": "三级", "detail": "专科救治"}
      ]
    }
  ]
}
```

支持的 `slides[].type`：

- `title`
- `section`
- `statement`
- `content`
- `split`
- `two-column`
- `metric`（兼容注册表别名 `metrics`）
- `comparison`
- `timeline`
- `chart`
- `table`
- `quote`
- `closing`

对应内容字段沿用 `assets/layout-library/layouts/core.mjs` 的稳定数据对象，但
Agent 不得复制或修改该文件。常用字段：

- 通用：`title`、`kicker`、`footer`、`page`
- content：`items` 或 `body`
- statement：`statement`、`support`
- split：`body`（左侧文字）；配图时加 `image: { "path": "<绝对路径或相对 spec 文件的路径>" }`
- two-column / comparison：`left`、`right`
- metric：`metrics[{value,label,detail}]`
- timeline：`steps[{label,detail}]`
- table：`rows`
- quote：`quote`、`attribution`、`context`
- closing：`title`、`action`、`contact`

插图必须是本机已有文件。用户聊天上传的图（创面照等）路径见用户消息中的
`[Files attached by user…]` 清单，文件在 `inbox/<批次>/`。
优先填该**绝对路径**；禁止 HTTP/HTTPS URL；不要改 `layout-library`。

## 离线校验

`make` 必须完成：

1. 生成原生可编辑 PPTX；
2. 解析 OOXML 并核对页数；
3. 运行边界、重叠、文本适配、占位符和字体审计；
4. 以原子方式提升到 `--out`。

LibreOffice 页面渲染是可选项，不是交付硬门禁。缺少渲染器时返回 warning，
不要安装系统软件。
