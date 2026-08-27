---
name: pptx
description: 创建、读取、审计和安全修改 Microsoft PowerPoint .pptx 演示文稿。输入或交付物是 .pptx 时使用本技能。所有转换只通过捆绑的 pptx.sh 完成。
---

# PowerPoint PPTX

只用 `read_skill` 返回的 `<path>` 所在目录：

```bash
PPTX_SKILL_ROOT="$(dirname "<path>")"
```

`pptx.sh` 会定位完整的隔离运行时和内置布局库。运行时未就绪时会返回
「交付包不完整」；此时停止并报告，不要改走其它实现。

## Agent 可用表面

- 只调用本技能的 `pptx.sh`
- 只用 `.md` / `.json` 暂存声明式内容
- 不搜索运行时、缓存、系统字体或替代工具
- 命令返回 `unsupported`、`blocked` 或「交付包不完整」时立即停止并报告

## 输出位置

用户给了路径就使用该路径；否则写到当前工作目录的 `exports/`：

```bash
mkdir -p "$PWD/exports"
```

中间 Markdown/JSON 放在 `scratch/qa/` 或 `PILOTDECK_WORK_DIR`，不要交付。

## 新建 PPTX

普通新建只调用 `make`。

短演示可以直接传正文：

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" make \
  --title "战创伤四级救治" \
  --body "现场处置。

紧急救治。

专科救治。" \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

长演示先把完整内容写成 Markdown，再传路径：

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" make \
  --title "战创伤四级救治" \
  --markdown "$PWD/scratch/qa/slides.md" \
  --out "$PWD/exports/战创伤四级救治.pptx"
```

可用参数：

- `--title`
- `--body` / `--body-file`
- `--markdown`
- `--spec`
- `--locale`（默认 `zh-CN`）
- `--footer`
- `--out`
- `--force`（只有用户明确要求替换已有输出时）

`make` 使用内置 16:9 布局库、PptxGenJS 和 Noto Sans SC 字体声明，运行
OOXML 检查和结构审计。成功 JSON 的 `output` 是用户交付文件。

页面 PNG 不是离线现场硬依赖。没有 LibreOffice 时 `preview` 为空并带
warning，但 PPTX 仍可交付；不要为此安装任何软件。

## Markdown 约定

- 第一个 `#` 可作为演示标题；
- 后续 `#` 是章节页；
- `##` / `###` 开始普通内容页；
- 标题下的段落、`-` / `*` 列表和 `1.` 编号变为该页要点；
- 每页尽量只讲一个结论，最多约 6–8 个要点；
- 不要把分析过程、实现说明或 QA 备注写进幻灯片。

短内容不必先写 Markdown；Markdown 只是为长文、分页和避免 shell 转义。

复杂图表、表格、对比、时间线、引用或收尾页使用 `--spec`。只用
[creation.md](references/creation.md) 记录的类型和字段。禁止改写内置
layout-library。

## 把对话已有内容做成 PPT

`pptx.sh` 读不到聊天记录。用户说「把以上内容做成 PPT」时，完整内容已在
当前对话里：直接使用原文和事实，不要让用户重贴，不要把全文缩成无依据的
新版本。先整理为按页 Markdown 或 spec，再调用一次 `make`。

## 插入用户上传的图片（优先这样做）

聊天里的图**不能**从气泡/base64 直接嵌进 PPT。必须用磁盘上的绝对路径。
创面照、X 光、报告截图等，**绝大多数**就是本会话（或更早轮次）用户上传的附件。

路径在用户消息里的附件清单中（后续轮次不再重复打印，但路径仍有效，到历史消息里找）：

```text
[Files attached by user and available for reading in the project:]
- wse_0820_00_injury.jpg (1-wse_0820_00_injury.jpg): /…/inbox/<批次id>/1-wse_0820_00_injury.jpg
```

落盘位置：

- `{当前项目根}/inbox/<批次id>/`
- 或 `inbox/<批次id>/`（本仓库本地启动常见）

规则：

1. **直接使用清单里的绝对路径**（常见 `$WS/inbox/...`）。不要 `find /`，不要下载 URL，不要手写 Python/JS 去读图，不要翻 `pptx` 脚本源码猜字段。
2. `inbox/` 算作允许的本地路径；不必先 `cp` 到 `exports/`（复制可选，不是必需）。
3. 本轮消息没有清单时：在**同一会话更早的用户消息**里找同一标记；G9/`med_trauma_stage_plan` 返回的 `image_paths_used` 也可复用。
4. 禁止 HTTP/HTTPS。禁止打开或修改 `assets/layout-library/`。
5. 插图用 `--spec`，`split` 页字段如下（`path` 用绝对路径最稳）：

```json
{
  "type": "split",
  "title": "创面判读",
  "body": "左前胸穿透伤，活动性出血。",
  "image": { "path": "/absolute/path/from/attachment-note.jpg" }
}
```

Markdown `![](...)` 不能可靠插图；需要图时改用 `--spec`，不要新写 `.mjs` builder。

## 读取与审计

```bash
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" inspect --input "$INPUT_PPTX" --out "$PWD/scratch/qa/manifest.json"
bash "$PPTX_SKILL_ROOT/scripts/pptx.sh" audit --input "$INPUT_PPTX" --out "$PWD/scratch/qa/audit.json"
```

只读请求不要生成新 PPTX。

## 基于模板修改

保留源 PPTX，输出使用新文件名。先读
[template-following.md](references/template-following.md)，再按受控 JSON
映射走：

1. `inspect`
2. `validate-map`
3. `prepare-starter`
4. `apply-template`
5. `audit`

不要编写 `.mjs` builder。遇到无法安全映射的对象，返回 `unsupported`，
不要重建或覆盖源文件。

## 旧版 `.ppt`

`convert` 需要 LibreOffice，因此离线现场通常不可用。返回
`unsupported` 并保留源文件；不要安装转换器。原生 `.pptx` 不受影响。

## 其它保留命令

- `inspect`：读取页数、文本、对象、字体和 OOXML 信息
- `audit`：检查边界、重叠、文本适配、占位符和字体
- `render`：仅环境本来就有渲染后端时可选使用
- `validate-map` / `prepare-starter` / `apply-template` / `fidelity`：
  模板继承
- `deliver`：高级模板/候选封印；普通新建不需要

`scaffold` / `build` 仅为维护兼容保留，不属于 Agent 契约。

## 交付

只返回 `output` 指向的最终 `.pptx` 和简短说明。不要交付 Markdown、spec、
builder、audit JSON、候选文件、PNG、montage 或运行时目录，除非用户明确
要求。
