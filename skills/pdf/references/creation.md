# 创建 PDF

生成新 PDF 或做实质性重新设计之前阅读本文。Agent 只填写参数；不要编写 Python。

## 固定流程

- 新建 PDF 只使用 `pdf.sh make`。
- 常见任务：`--title`、`--body`、`--out`。
- 对话里已有的长文（救治方案、病例报告）先写成 `--markdown` 文件，不要把全文塞进命令行。
- 多节内容也可以用 `--spec` JSON，不要复制或修改 `assets/starter_pdf.py`。
- `make` 只加载 `assets/fonts/` 下的捆绑字体。不要搜索系统字体，不要下载字体。
- 运行时未就绪时停止。不要 pip，不要改用系统 Python。

## spec 约定

```json
{
  "title": "文档标题",
  "author": "PilotDeck",
  "body": "开头段落。空行分段。",
  "sections": [
    { "heading": "小节标题", "body": "小节正文。" }
  ]
}
```

命令行的 `--title` / `--body` / `--author` 会覆盖 spec 中的同名字段。

## 页面与字体

- 页面为 A4，边距、字号和页脚由 `make` 固定。
- 中文、标点必须能用捆绑 Noto Sans SC 显示。不要回退到 Helvetica。
- 不要为了塞进一页而缩小到不可读。

## 已有 PDF 的视觉改版

对已有文件用 `inspect` / `render` 取证，再用 `merge`、`split`、`rotate`、`forms-fill` 做最小改动。不要为了改几个字就手写一套 ReportLab 脚本。

## 迭代

1. 运行 `make`（或对已有文件运行 `audit` + `render`）。
2. 查看 `preview` 或 `page-*.png`。
3. 调整参数或 spec，再次 `make --force`，直到质量清单通过。
