# DOCX 能力与受控回退协议

在判定标准 DOCX 命令无法执行所要求操作之前阅读本文件。

## 1. 发现，不要猜测

运行：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command edit
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command review
```

实时 CLI 输出是权威的。文档中的示例不是完整的能力声明。

当操作声明为 `supported` 时，使用它。当它为 `partial`、`unsupported` 或 `blocked` 时，保留该状态并有意选择下一层级。

## 2. 决策阶梯

使用最低且足够的层级：

1. **标准命令** — 确定性的 `create`、`edit`、`review` 或其他捆绑操作，写入内部候选。
2. **辅助资源** — 生成图表、示意图或其他本地图像，然后使用标准图像块。
3. **定向 OOXML 补丁** — 通过带有窄范围包部件允许列表的 `fallback-patch` 修改既有 DOCX。
4. **完整自定义创建** — 通过 `fallback-create` 创建新 DOCX；切勿用它变更有价值的既有包。
5. **报告不受支持或被阻断** — 对签名、文档/写入保护、权限管理、不安全包，或无法核验的保真度是必需的。

不要从第 1 层跳到未跟踪的 Python 构建器。无法表达某一功能并不授权重建既有文档。
标准创建会规范化本地栅格资源，标准编辑支持
在段落之前或之后进行锚定行内图像插入。仅当实质性要求需要不受支持的浮动/环绕行为时才使用回退。

每一次成功的回退仍只产生内部候选。它并不
授权直接输出到项目根目录。像标准命令一样精确运行验收、逐页视觉质量检查、
预检和 `deliver`。
回退不会绕过冻结的文档策略：新文档中未请求的页眉、
页脚或页码域会使预检失败。最终交付
也仍在冻结工作区内，除非精确的外部路径已在
`prepare` 期间被授权。
对于 `fallback-patch`，输入路径会在受控脚本运行前通过会话版本
链解析。仅当当前用户明确要求较旧/原始编辑基础时，才使用 `--use-exact-input`。

## 3. 定向 OOXML 补丁

脚本约定为：

```bash
python patch.py --package-dir /temporary/unpacked/package
```

脚本仅编辑该副本。包装器计算前后哈希，拒绝允许列表之外的更改，重新打包，验证关系和 XML，并写入清单。
包装器从其自身目录以安全的环境
允许列表运行脚本。当设置了 `PILOTDECK_WORK_DIR` 时，脚本必须存放在
该目录下。这些控制减少意外的工作区写入和机密
继承；操作系统沙箱仍取决于宿主工具
权限模型。回退脚本必须仅使用其声明的输入参数
和本地任务资源，并且不得访问网络。

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fallback-patch \
  --input "$INPUT_DOCX" \
  --script "$WORKSPACE/tmp/patch.py" \
  --out "$CANDIDATE_DOCX" \
  --manifest "$WORKSPACE/qa/fallback-manifest.json" \
  --allow-part "word/document.xml" \
  --reason "The standard edit schema cannot update this field structure."
```

仅在需要时添加更多 `--allow-part` 值。模式使用 shell 风格匹配。常见的窄范围目标：

- `word/document.xml`
- `word/header*.xml`
- `word/footer*.xml`
- `word/settings.xml`
- `word/styles.xml`
- `word/numbering.xml`
- `word/_rels/*.rels`
- `[Content_Types].xml`

宏、ActiveX、签名和嵌入对象部件始终被禁止。什么都不改的脚本返回 `partial`；超出范围的脚本返回 `blocked`。
至少需要一个 `--allow-part`。除非用户明确授权 `--overwrite`，否则既有输出路径会被阻断。

## 4. 完整自定义创建

脚本约定为：

```bash
python create.py --out /temporary/candidate.docx
```

仅当标准创建器无法表达实质性要求时，才对新文档运行它：

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fallback-create \
  --script "$WORKSPACE/tmp/create.py" \
  --out "$CANDIDATE_DOCX" \
  --manifest "$WORKSPACE/qa/fallback-manifest.json" \
  --reason "The requested native diagram structure is outside the standard create schema."
```

包装器要求新的输出路径和有效的 `.docx`，记录脚本和输出哈希，并写入清单。它永远不会覆盖既有文档。清单不能证明视觉质量；之后运行检查、在相关处比较，以及预检。

## 5. 回退清单

将清单与内部质量产物放在一起。它记录：

- 协议和回退模式；
- 原因和路径；
- 脚本 SHA-256；
- 允许的以及实际更改的 OOXML 部件；
- 脚本退出状态和有界的 stdout/stderr；
- 输出 SHA-256 和验证结果。

如果回退失败，不要绕过包装器并直接重新运行其脚本。纠正脚本或其允许列表，或报告限制。

## 6. 保持被阻断的操作

不要对以下情况尝试受控回退：

- 编辑已数字签名的文档同时声称签名仍有效；
- 绕过文档/写入保护，或声称其凭据已核验；
- 宏、VBA、`.docm`、`.dotm` 或活动内容；
- 没有授权兼容工作流时处理权限管理、加密或受密码保护的内容；
- 在未检查所有可见文本、图像、链接、嵌入对象和包部件的情况下进行不可逆涂黑；
- 像简单插入/删除一样接受/拒绝复杂的移动或属性修订；
- 当需要 Microsoft Word 比较或经批准的等效方案时进行法律级比较。

返回 `blocked` 或 `unsupported`，说明缺失的保真度，并保留源文件。
