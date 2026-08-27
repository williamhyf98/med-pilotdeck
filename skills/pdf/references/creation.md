# 创建 PDF

生成新 PDF 或做实质性重新设计之前阅读本文。Agent 只填写参数；不要编写 Python。

## 固定流程

- 新建 PDF 只使用 `pdf.sh make`。
- 常见任务：`--title`、`--body`、`--out`。
- 对话里已有的长文（救治方案、病例报告）先写成 `--markdown` 文件，不要把全文塞进命令行。
- 多节内容也可以用 `--spec` JSON，不要复制或修改 `assets/starter_pdf.py`。
- 需要把用户上传的照片嵌进正文时，用 `--spec` 的 `images`（见下节）；不要读 `pdf_cli.py` 源码猜能力。
- `make` 只加载 `assets/fonts/` 下的捆绑字体。不要搜索系统字体，不要下载字体。
- 运行时未就绪时停止。不要 pip，不要改用系统 Python。

## spec 约定

```json
{
  "title": "文档标题",
  "author": "PilotDeck",
  "body": "开头段落。空行分段。",
  "images": [
    {
      "type": "image",
      "path": "/abs/path/to/workspaces/.../inbox/<batch>/1-wound.jpg",
      "width_mm": 120,
      "caption": "图 1 创面"
    }
  ],
  "sections": [
    {
      "heading": "小节标题",
      "body": "小节正文。",
      "images": [
        {
          "path": "/abs/path/to/workspaces/.../inbox/<batch>/2-xray.jpg",
          "width_mm": 100,
          "caption": "图 2 影像"
        }
      ]
    }
  ]
}
```

命令行的 `--title` / `--body` / `--author` 会覆盖 spec 中的同名字段。

## 插入用户上传的图片

- 只支持**本地文件路径**。优先用附件列表里的 **`$WS/inbox/...` 绝对路径**。
- 禁止 `http://` / `https://`；不要下载网络图片。
- 相对路径相对 `--spec` 所在目录解析。
- 可选字段：`width_mm`（默认 120，最大约 170）、`caption`（或 `alt_text`）、`type: "image"`。
- 也可用 `width_inches`（会换算成 mm）。
- 顶层 `images` 排在正文 `body` 之后；小节 `images` 排在该节正文之后。

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
