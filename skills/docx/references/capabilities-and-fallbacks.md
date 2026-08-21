# DOCX 能力与限制处理

在判定标准 DOCX 命令无法执行所要求操作之前阅读本文件。

## 1. 发现，不要猜测

对高级编辑和审阅运行：

```bash
bash "$DOCX_TOOL" capabilities
bash "$DOCX_TOOL" schema --command edit
bash "$DOCX_TOOL" schema --command review
```

普通新建使用 `make`，不需要先查询 create schema。复杂新建若使用
`make --spec`，字段以 [specifications.md](specifications.md) 为准。

实时 CLI 输出是权威。未知字段和操作会失败，而不是被忽略。

## 2. Agent 可使用的层级

使用最低且足够的已捆绑能力：

1. **普通新建** — `make --title/--body/--markdown/--spec --out`。
2. **标准编辑** — `edit`、`review`、`finalize`、`sanitize`、
   `refresh-toc` 等受控命令。
3. **辅助资源** — 先创建本地图像，再由标准 image block 或
   `insert_image` 插入。
4. **报告限制** — 返回 `unsupported` 或 `blocked`，说明缺失的保真度并
   保留源文件。

不要进入第五层：不要写 Python 构建器、不要直接修补 OOXML、不要调用
`fallback-create` 或 `fallback-patch`。这些 CLI 名称可能为旧协议兼容和
维护测试保留，但不属于 Agent 可用契约。

## 3. 常见受支持范围

- 新建中性 Word 文档；
- 标题、段落、项目符号、编号、表格、图片、目录和受支持域；
- 定向文本/段落编辑；
- 批注和受支持的跟踪替换；
- 接受/拒绝修订及移除批注；
- 文本与包结构比较；
- 元数据净化；
- OOXML 校验、结构审计和 LibreOffice 页面渲染。

编辑既有文档时优先保留原包。若标准 `edit` 检测到宏、签名、嵌入对象、
复杂内容控件或其他包敏感功能，它会阻断可能有损的往返。

## 4. 必须保持阻断的操作

不要尝试绕过：

- 数字签名仍有效的编辑；
- 文档/写入保护或密码；
- 宏、VBA、`.docm`、`.dotm` 或活动内容；
- 未授权的权限管理或加密内容；
- 无法核验的不可逆涂黑；
- 复杂移动/属性修订的静默接受或拒绝；
- 要求 Microsoft Word 等效结果的法律级比较；
- 未建模 OOXML 结构的有损重建。

返回 `blocked` 或 `unsupported`，说明限制，并保留原始文件。

## 5. 运行时失败

- `missing-dependencies`：报告交付包不完整并停止；不要 `fix`、pip 或切换
  系统 Python。
- `render-backend-unavailable`：可报告结构校验结果，但必须明确页面视觉
  检查未完成。
- `partial`：只报告已完成的范围，不要把文件存在当作完整成功。
- 输出路径已存在：只有用户明确要求替换时才使用 `--force` 或对应覆盖参数。
