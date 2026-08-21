# 创建 Word DOCX

生成新 DOCX 或做实质性重新设计之前阅读本文。Agent 只填写参数；不要编写
Python。

## 固定流程

- 常见新建只使用 `docx.sh make`。
- 短文使用 `--title`、`--body`、`--out`。
- 对话里已有的长文先写成 Markdown，再使用 `--markdown`。
- 复杂表格、图片或精确结构可使用 `--spec`，字段必须符合
  [specifications.md](specifications.md) 的 create schema。
- 不要调用 `fix`、`fallback-create` 或自己编写 python-docx 脚本。
- 运行时未就绪时停止，并报告交付包不完整。

## 示例

```bash
bash "$DOCX_TOOL" make \
  --title "救治方案" \
  --markdown "$PWD/exports/qa/content.md" \
  --out "$PWD/exports/救治方案.docx"
```

重复生成同一路径时，只有用户明确需要替换旧输出才使用 `--force`。

## Markdown 约定

- ATX 标题 `#` / `##` / `###` 映射为 Word 1–3 级标题；
- 项目符号和编号列表映射为真正的 Word 列表；
- 空行分段，正文顺序保持不变；
- 若 Markdown 的一级标题与 `--title` 相同，不重复生成标题。

## spec 约定

`--spec` 接受现有严格 create spec。至少包括：

```json
{
  "style_policy": {
    "mode": "builtin",
    "template": "neutral-document-v1"
  },
  "document_structure": {"archetype": "simple"},
  "locale": "zh-CN",
  "page": "a4",
  "content": [
    {"type": "title", "text": "文档标题"},
    {"type": "paragraph", "text": "正文。"}
  ]
}
```

不要为了普通文本生成先执行 `prepare` / `schema`；它们保留给高级编辑与审阅
工作流。`make` 会把 spec 复制到内部工作目录，最终只交付 `output` 指向的
DOCX。

## 字体与校验

- 内置模板统一声明捆绑 Noto Sans SC，不搜索系统字体。
- DOCX 包完整性检查和结构审计由 `make` 内部完成。
- 页面 PNG 渲染不是离线现场的硬依赖。没有渲染后端时，`make` 仍应成功写出
  DOCX，并带 warning；不要安装 LibreOffice 或其它软件来补这一步。
- 有 warning 时不能假装做过视觉检查。
