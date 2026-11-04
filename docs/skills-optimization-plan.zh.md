# 通用 Skill 优化任务书

> 适用范围：`skills/` 下 6 个通用文档技能 —— `docx`、`pptx`、`spreadsheets`、`pdf`、`frontend-slides`、`diagram-maker`
>
> 本文是**执行与进度记录单**。每完成一项，勾选复选框并在「执行日志」追加一行；需求变更时加「变更记录」，不要直接删任务定义。
>
> 创建日期：2026-11-04　｜　当前状态：**任务书已建立，尚未开始编码**

---

## 0. 怎么用这份文档

1. 开工前先看第 1 节总览，确认依赖是否满足。
2. 按 T1 → T5 顺序推进；T3 可与 T2 并行，但都必须在 T1 之后。
3. 每个子任务有独立的**验收命令**，跑不过不算完成。
4. 完成一项就把对应的 `- [ ]` 改成 `- [x]`，并在第 9 节记一行。
5. 需求变更：在对应任务下加「变更记录」，不要直接删掉原任务。

---

## 1. 总览

### 1.1 一句话目标

把「模型每次现场手写 + 自己口头保证质量」，改成「统一设计令牌 + 模板化生成 + 可执行验收门 + 固定回归样本」。

### 1.2 任务清单

| 编号 | 任务 | 解决的核心问题 | 工作量 | 依赖 | 状态 |
|---|---|---|---|---|---|
| **T1** | 共享设计令牌（单一真源） | 同一主题在 6 个技能里各定义一遍，改一处漏五处 | 小 | — | ⬜ 未开始 |
| **T2** | HTML 生成器 | HTML 无生成器，每次手写 18KB、耗时 7.5 分钟、无法复现 | 大 | T1 | ⬜ 未开始 |
| **T3** | 统一验收门 | PPT/Excel/PDF 有审计但不拦；HTML/图表完全无验收 | 中 | T1 | ⬜ 未开始 |
| **T4** | 主题库扩展 | 只有 PPT 有 5 套主题，其余技能基本是「一件工作服」 | 中 | T1 | ⬜ 未开始 |
| **T5** | 回归样本集 | 改完技能无法判断是否退步；只有 2 个 fixture | 中 | T1、T3 | ⬜ 未开始 |

### 1.3 依赖关系

```
T1 共享令牌 ──┬──> T2 HTML 生成器 ──┐
              ├──> T3 验收门 ───────┼──> T5 回归样本
              └──> T4 主题库 ───────┘
```

**T1 不完成，后面四项都是空中楼阁。**

### 1.4 里程碑

| 里程碑 | 内容 | 可观测结果 |
|---|---|---|
| M1 | T1 完成 | `node skills/_shared/tokens.mjs --list` 能列出统一主题；6 个技能读到同一个 accent 值 |
| M2 | T3 完成（PPT/Excel/PDF 先做） | 交付前出现 `qa-report.json`；不过关时 `deliver` 非零退出 |
| M3 | T2 完成 | 同一份 `content.json` 两次生成 HTML **字节一致**；单页生成 ≤ 2 分钟 |
| M4 | T4 完成 | 用户说「用创伤风格」，6 个技能都能识别并注明主题名 |
| M5 | T5 完成 | `npm run test:skill-samples` 输出通过率基线 |

---

## 2. 统一验收口径（所有任务共用）

验收分三层，**只有第 1 层是必须全过的**：

| 层 | 名称 | 判定者 | 失败处理 |
|---|---|---|---|
| L1 | **自动断言** | 脚本 | 硬失败，禁止交付 |
| L2 | **视觉确认** | 人 / 多模态模型看截图 | 记录 `approved` / `waived` + 理由 |
| L3 | **内容溯源** | 脚本 + 人工抽查 | 关键数值与源材料比对，不一致即失败 |

**降级原则（全局）**：任何环境依赖（远程渲染器、浏览器）不可用时，**必须交付有效文件 + 明确写出「未完成视觉验收（原因）」**，不允许静默跳过，也不允许因此拒绝交付。

---

## 3. T1 —— 共享设计令牌（单一真源）

### 3.1 目标

建立一份唯一的 `design-tokens.json`，定义颜色、字号阶、间距、主题名；6 个技能都从这里读，而不是各写各的。

### 3.2 现状证据

| 位置 | 现状 |
|---|---|
| `skills/pptx/assets/layout-library/design-tokens.json` | 已有 5 个主题（clinical / academic / trauma / vital / mono）+ 6 个字体 profile + 2 个密度 |
| `skills/docx/scripts/docxlib/templates.py` | `_NEUTRAL_SHARED` 里 `title_color: "000000"`，只有 1 套 `neutral-document-v1` |
| `skills/frontend-slides/references/med-visual.md` | `--accent: #2563eb`（与 pptx 不是同一套） |
| `skills/diagram-maker/scripts/diagram_cli.py` | 主题硬编码在 `{"clean", "architecture"}` |
| `skills/spreadsheets/references/formatting.md` | 只有文字规范，无具体色值 |

### 3.3 实现思路

1. **新建共享目录** `skills/_shared/`。目录名以下划线开头且不含 `SKILL.md`；技能发现逻辑只收录含 `SKILL.md` 的目录（见 `src/extension/skills/migrateLegacyBundledSkills.ts:142`），因此不会被误当成技能。
2. **共享文件只放"跨技能通用"的部分**：语义色、字号阶、间距、圆角、字体栈名、主题清单、自动选主题规则。
3. **各技能保留自己的专有扩展**（例如 pptx 的 `navy`/`paper`/`white` 被版面代码硬编码引用，见 `skills/pptx/scripts/lib/toolkit.mjs:35-40` 的注释），但**颜色值必须来自共享文件**。
4. **加一个一致性检查脚本**，防止共享文件与技能投影漂移。
5. **必须可降级**：共享文件缺失时，各技能退回内置默认值，只记 warning，不阻断交付（避免打包漏拷导致全线崩）。

### 3.4 改动清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 新建 | `skills/_shared/design-tokens.json` | 唯一真源。含 `version` / `defaultTheme` / `themes` / `typography` / `spacing` / `autoSelect` |
| 新建 | `skills/_shared/tokens.mjs` | Node 读取器：`loadTokens()`、`resolveTheme(name)`、`listThemes()`、`autoPickTheme(taskKind)`；缺文件时返回内置默认 |
| 新建 | `skills/_shared/tokens.py` | Python 同能力读取器（供 docx / pdf / html / diagram 使用） |
| 新建 | `skills/_shared/themes.schema.json` | 主题文件结构定义，供 CI 校验 |
| 修改 | `skills/pptx/scripts/lib/toolkit.mjs` | `tokens()` 改为「共享令牌 + 本地版面扩展」合并，保留 `cachedTokens` 缓存 |
| 修改 | `skills/docx/scripts/docxlib/templates.py` | `_NEUTRAL_SHARED` 改为从共享令牌取色，保留 locale 排版变体 |
| 新建 | `scripts/check-skill-tokens.mjs` | 校验：① 共享 JSON 符合 schema ② 各技能能解析出全部主题 ③ 同名主题 accent 一致 |

### 3.5 令牌结构（初稿，实施时可微调）

```jsonc
{
  "version": 1,
  "defaultTheme": "clinical",
  "themes": {
    "clinical": {
      "name": "临床通用",
      "aliases": ["临床", "clinical"],
      "description": "浅灰纸面 + 深墨蓝 + 橙色强调；门诊、病例报告默认",
      "colors": {
        "canvas": "#fafafa", "surface": "#ffffff",
        "ink": "#171717", "muted": "#525252", "border": "#e5e5e5",
        "accent": "#2563eb", "accentSoft": "#eff6ff",
        "danger": "#b91c1c", "warning": "#b45309", "positive": "#15803d",
        "onAccent": "#ffffff"
      },
      "canvasDark": "#0f2540"
    }
  },
  "typography": {
    "fontStacks": { "sans": "...", "mono": "..." },
    "scale": { "title": "1.75rem", "h2": "1.25rem", "body": "1rem", "caption": "0.875rem" }
  },
  "spacing": { "xs": "0.25rem", "sm": "0.5rem", "md": "1.25rem", "lg": "2rem" },
  "autoSelect": {
    "case-report": "clinical",
    "academic-review": "academic",
    "trauma-plan": "trauma",
    "lab-imaging": "vital",
    "print-handout": "mono"
  }
}
```

说明：`canvasDark` 用于需要满版深色的版面；`fontStacks` 只存字体栈名字，**不存字体文件**。

**主题命名规则（v1.1）**：用户看到、说出、在界面上选的**一律是中文名**（`name`）。JSON 里的 `clinical` 这类 ASCII key 只作为脚本内部 id 与命令行别名，不对外展示。命令行同时接受中文名与 ASCII 别名，例如 `--theme 临床通用` 和 `--theme clinical` 等价。

理由：中文名进文件路径、shell 参数、缓存 key 时存在编码与转义风险；用 ASCII id 做内部键、中文做展示层，是唯一既满足"用户看到中文"又不引入转义问题的做法。

### 3.6 验收

```bash
node skills/_shared/tokens.mjs --list          # 列出 5 个主题
python3 skills/_shared/tokens.py --list        # 同上，Python 侧一致
node scripts/check-skill-tokens.mjs            # 一致性检查通过
node skills/pptx/scripts/pptx_cli.mjs themes   # pptx 主题列表不减少
python3 skills/docx/scripts/docx_cli.py capabilities
```

额外断言：删除 `skills/_shared/design-tokens.json` 后，前两条应返回内置默认 + warning，**不报错退出**。

### 3.7 风险与降级

| 风险 | 缓解 |
|---|---|
| pptx 版面代码硬编码了 `navy`/`paper`/`white` 语义 | 共享令牌**必须**保留这三个语义位（可改名映射，不可删） |
| 打包时漏拷 `_shared` | 读取器必须有内置 fallback；`check-skill-tokens.mjs` 加入打包前检查 |
| 同名主题在两处漂移 | CI 检查 + 只允许共享文件为真源 |

### 3.8 进度

- [ ] 3.8.1 起草 `design-tokens.json`（从 pptx 现有 5 主题迁移）
- [ ] 3.8.2 写 `tokens.mjs` / `tokens.py`（含 fallback）
- [ ] 3.8.3 改造 pptx `toolkit.mjs` 读取
- [ ] 3.8.4 改造 docx `templates.py` 读取
- [ ] 3.8.5 写 `check-skill-tokens.mjs`
- [ ] 3.8.6 跑通 3.6 全部验收

---

## 4. T2 —— HTML 生成器

### 4.1 目标

把「模型一次手写整页 HTML」改成「模型写内容 JSON，程序套模板出 HTML」，使生成**更快、可复现、可测试**。

交付形态支持两种：**单文件**（无图，或图片用 base64）+ **文件夹**（`index.html` + `assets/` 图片）。详见 4.10。

### 4.2 现状证据

| 证据 | 位置 |
|---|---|
| 无生成器，硬约束写死「用 `write_file` 写一个自包含 HTML，没有 `*.sh` 生成器」 | `skills/frontend-slides/SKILL.md` 第 8 行 |
| 三个文件被 SKILL.md 明令禁用：`STYLE_PRESETS.md`（"不要再读"）、`animation-patterns.md`（"不要依赖"）、`scripts/export-pdf.sh`（"不要运行"） | 同上，Phase 2 / Phase 3 / Phase 4 |
| 实际可用规范只剩 `references/med-visual.md`（111 行） | — |
| 实测：单次 `write_file` 参数 18,231 字节，模型耗时 **448 秒** | 2026-11-02 会话 `web:s_f6781e82...` |

### 4.3 实现思路

```
模型 ──写──> scratch/qa/content.json（约 3KB）
                    │
              html_cli.py make
                    │
                    ├─ 读 skills/_shared/design-tokens.json 取主题
                    ├─ 读 assets/templates/base.html 套骨架
                    ├─ 按 blocks[].type 渲染区块
                    └─ 内联 CSS，输出单文件 → exports/xxx.html
```

**技术选型：Python 标准库（零依赖）**

- 理由：`docx` / `pdf` 已是 Python 体系；`pptx` / `spreadsheets` 的 Node 运行时要靠 `runtime/` 带 node_modules，HTML 再引一套 Node 运行时是净负担。
- 用 `html.escape` + `string.Template` 足够，不引入 Jinja2。

**保留逃生通道**：用户要一次性自定义页面时，仍允许 `write_file` 直写，但**必须过 `html_cli.py audit`**。

### 4.4 区块类型（首版范围）

| block | 用途 |
|---|---|
| `hero` | 标题 + 副标题 + 来源说明 |
| `kpi` | 2–4 个关键结论卡 |
| `toc` | 锚点目录 |
| `section` | 章节 + 正文段落 |
| `table` | 表格（含对齐规则） |
| `risk-banner` | 风险/警告条（语义色） |
| `diagnosis-card` | 诊断方向卡（依据→评估→检查→处置） |
| `timeline` | 时间线（病程、救治阶段） |
| `checklist` | 待确认项 / 待办 |
| `callout` | 通用提示框（重要说明、免责声明） |
| `image` | 单张图 + 图注（影像、创面、流程图截图） |
| `figure-grid` | 2–4 张图并排 + 各自图注（对比影像、多部位） |

**首版不支持**：图表（chart）、翻页动画。缺省即「未提供」，避免为了塞版面造假数据。

> 图片支持是 v1.1 追加需求，具体规则见 4.10。

### 4.5 改动清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 新建 | `skills/frontend-slides/scripts/html.sh` | 运行入口，风格对齐 `docx.sh` / `pdf.sh` |
| 新建 | `skills/frontend-slides/scripts/html_cli.py` | 子命令：`make` / `audit` / `themes` / `render` / `self-test`；`make` 支持 `--name`（生成时间戳目录）、`--update <dir>`（原地更新）、`--single-file` |
| 新建 | `skills/frontend-slides/scripts/htmllib/__init__.py` | 包入口 |
| 新建 | `skills/frontend-slides/scripts/htmllib/blocks.py` | 各区块渲染器 |
| 新建 | `skills/frontend-slides/scripts/htmllib/audit.py` | L1 断言实现 |
| 新建 | `skills/frontend-slides/scripts/htmllib/render.py` | 可选截图（走远程服务，失败降级） |
| 新建 | `skills/frontend-slides/assets/templates/base.html` | 骨架模板 |
| 新建 | `skills/frontend-slides/assets/templates/base.css` | 由 token 生成 CSS 变量的模板 |
| 新建 | `skills/frontend-slides/assets/schema/content.schema.json` | `content.json` 结构定义 |
| 新建 | `skills/frontend-slides/assets/examples/case-report.json` | 首个可运行样例（病例报告） |
| 重写 | `skills/frontend-slides/SKILL.md` | 主路径改为 `html.sh make`；`write_file` 降为逃生通道；删除失效的三份文件引用 |
| 归档 | `skills/frontend-slides/STYLE_PRESETS.md` → `docs/archive/` | 已被明令禁用，移出技能目录避免误读 |

### 4.6 L1 断言清单（`html_cli.py audit`）

| 码 | 检查 | 严重度 |
|---|---|---|
| `external-resource` | 出现 `http://` / `https://` / `<link href>` / `<script src>` | error |
| `remote-font` | `@import` 或 `font-family` 引用非系统栈 | error |
| `missing-section` | `content.json` 声明的章节未出现在 HTML | error |
| `missing-theme` | 未使用任何已知主题 | error |
| `silent-empty` | 空值未写成「未提供」 | error |
| `broken-relative-asset` | 相对路径资源不存在（含图片丢失） | error |
| `absolute-path-image` | `<img src>` 用了绝对路径或 `file://` | error |
| `image-no-alt` | `<img>` 缺 `alt` | warning |
| `image-oversize` | 单张图 > 5 MB 或长边 > 4000 px | warning |
| `image-unused` | `assets/` 里有图片但页面未引用 | warning |
| `tag-imbalance` | 标签未闭合（`html.parser`） | error |
| `size-budget` | 单文件 > 300 KB | warning |
| `a11y-basic` | 缺 `lang`、标题层级跳跃 | warning |

**输出**：`scratch/qa/html-audit.json`，含 `status`、`errors[]`、`warnings[]`、`theme`、`bytes`、`sha256`。

### 4.7 验收

```bash
# 1. 能生成
bash skills/frontend-slides/scripts/html.sh make \
  --content skills/frontend-slides/assets/examples/case-report.json \
  --out "$PWD/exports/病例展示-样例.html"

# 2. 能自查
bash skills/frontend-slides/scripts/html.sh audit \
  --input "$PWD/exports/病例展示-样例.html" \
  --content skills/frontend-slides/assets/examples/case-report.json \
  --out "$PWD/scratch/qa/html-audit.json"

# 3. 确定性：同输入两次输出必须字节一致
shasum -a 256 exports/病例展示-样例.html   # 跑两次对比

# 4. 自测
bash skills/frontend-slides/scripts/html.sh self-test
```

**性能指标（写入验收）**：首版样例在 Qwen3.8-27B 环境下的端到端耗时 ≤ 2 分钟（现状 9 分 53 秒）。

### 4.8 风险与降级

| 风险 | 缓解 |
|---|---|
| 模板化后页面"千篇一律"，失去设计感 | 保留 5–6 个命名主题 + 区块组合，不追求自由排版；一次性创作走 `write_file` 逃生通道 |
| 模型不按约定产出 `content.json` | schema 校验 + 明确错误码 + SKILL.md 给出最小完整示例 |
| 截图依赖浏览器，离线环境不可用 | **不作为硬依赖**：`render` 失败时 `audit` 仍返回 `passed`，但带 `visual_acceptance: "not_performed"` |
| 旧 HTML 无法通过 audit | 无 `content.json` 时降级为纯静态检查 |

### 4.9 进度

- [ ] 4.9.1 定义 `content.schema.json` 与 `case-report.json` 样例
- [ ] 4.9.2 实现 `blocks.py` 首版 6 个必需 block（hero / section / table / risk-banner / diagnosis-card / callout）
- [ ] 4.9.3 实现 `base.html` + `base.css`（从 T1 令牌生成变量）
- [ ] 4.9.4 实现 `audit.py`（4.6 全部 9 项）
- [ ] 4.9.5 实现 `html.sh` 与 CLI 参数解析
- [ ] 4.9.6 重写 `SKILL.md`，归档 `STYLE_PRESETS.md`
- [ ] 4.9.7 补全剩余 4 个 block（kpi / toc / timeline / checklist）
- [ ] 4.9.8 跑通 4.7 验收 + 性能实测
- [ ] 4.9.9 实现 `image` / `figure-grid` 两个区块（见 4.10）
- [ ] 4.9.10 实现文件夹交付（复制图片 + 重写相对路径）

### 4.10 交付结构与图片处理（v1.1 补充）

#### 4.10.1 两种交付形态

| 形态 | 产出 | 何时用 |
|---|---|---|
| **单文件** | `exports/<名称>.html` | 无图，或只有 1–2 张小图（base64 内联，单文件 ≤ 300 KB） |
| **文件夹** | `exports/<名称>_<YYYYMMDD-HHmm>/index.html` + `.../assets/*` | 有影像、创面照、多张图 |

默认策略：`content.json` 里只要出现 `image` / `figure-grid` 且图片总大小 > 300 KB，就自动走文件夹；用户显式指定 `--single-file` 时强制 base64 内联（超限则 warning 不阻断）。

#### 4.10.2 文件夹结构与命名（v1.2：带时间戳）

**目录名 = `<页面短名>_<YYYYMMDD-HHmm>`，入口文件名固定为 `index.html`。**

```
exports/
├── 病例展示_心脏磁共振_20261104-1530/
│   ├── index.html          # 唯一入口，相对路径引用 assets/
│   └── assets/
│       ├── mri-01.png      # 原文件名清洗后重命名
│       └── mri-02.png
└── 病例展示_心脏磁共振_20261104-1712/    # 再次生成 → 新目录，不覆盖
```

命名规则：

1. **时间戳精度到分钟**（`YYYYMMDD-HHmm`），不用只有日期。理由：同一天重做同一份病例很常见，只带日期仍会撞车。
2. **撞名兜底**：同一分钟内再次生成同一页面，追加 `-2`、`-3`。
3. **不提供覆盖**：已存在目录一律不覆盖、不删除。要改内容，在原目录内用 `make --update` 重新渲染同一个 `index.html`。
4. **入口固定叫 `index.html`**：即使外层目录带时间戳，双击进入后入口名永远一致；后续更新、脚本引用、用户分享都不受目录名影响。
5. **单文件形态不改**：`exports/病例展示.html` 仍用原名，沿用现有「覆盖已有 exports 文件须用户明确同意」的保护。
6. **时间取本机本地时间**（`Asia/Shanghai`），不取 UTC，避免用户看到 8 小时偏差。

> 这样每次生成都是一份独立留档，可直接对比"上一版"和"这一版"，也符合 L3 内容溯源要求。

图片处理规则：

1. **图片一律复制**进 `assets/`，不引用工作区外的原始路径（`../source/x.png` 这类跨目录相对路径禁止）。
2. **文件名清洗**：非 `[A-Za-z0-9._-]` 的字符替换为 `-`，重名自动加序号；保留原扩展名。
3. **路径重写**：`content.json` 里写源路径，渲染时统一改写成 `assets/<清洗后名>`。
4. **缺失图不占位**：源图片不存在时，该块降级为 `callout`，文字写「图片未提供」，并记 `broken-relative-asset` warning。
5. **不复制重复图**：相同 `sha256` 只复制一份，多块共用。

#### 4.10.3 为什么不做 base64 默认

- base64 会膨胀约 **33%**，一张 2 MB 的 CT 截图变 2.7 MB，页面打开变慢
- 图片多时单文件轻松破 10 MB，浏览器首屏渲染明显卡顿
- 医生通常还要单独取用某张影像，文件夹形态可以直接拿原图

#### 4.10.4 已知副作用（必须写进 SKILL.md）

`FileArtifactCollector` 会递归扫描 `exports/`（`src/session/artifacts/FileArtifactCollector.ts:303`，`walk()` 在 502 行递归子目录），`.png` / `.jpg` 都在 MIME 映射内，因此：

> **文件夹交付时，`assets/` 里的每张图片也会作为独立文件卡片出现在对话里。**

这不是 bug，但要在回复里说明，避免用户以为"多生成了一堆文件"。控制办法：只复制页面实际引用的图片（`image-unused` 审计项兜底）。

#### 4.10.5 `content.json` 图片写法

```jsonc
{
  "blocks": [
    {
      "type": "image",
      "src": "scratch/qa/img/mri-01.png",
      "caption": "心脏磁共振延迟强化序列（来源：上传影像）",
      "alt": "心脏磁共振延迟强化图像"
    },
    {
      "type": "figure-grid",
      "columns": 2,
      "items": [
        { "src": "scratch/qa/img/mri-01.png", "caption": "延迟强化", "alt": "..." },
        { "src": "scratch/qa/img/mri-02.png", "caption": "T2 加权", "alt": "..." }
      ]
    }
  ]
}
```

`caption` 必填（图注是医学展示的可追溯要求）；`alt` 缺省由 `caption` 兜底但仍记 warning。

#### 4.10.6 验收

```bash
# 文件夹形态（目录名带时间戳）
bash skills/frontend-slides/scripts/html.sh make \
  --content skills/frontend-slides/assets/examples/case-with-images.json \
  --name "病例展示_样例"
# 产物：exports/病例展示_样例_20261104-1530/index.html

DIR=$(ls -d exports/病例展示_样例_* | tail -1)
test -f "$DIR/index.html"        # 入口存在且固定名
test -d "$DIR/assets"            # 图片目录存在
ls "$DIR/assets" | wc -l         # 只含被引用的图

# 相对路径可解析：在任意目录下用 file:// 打开也不应 404
grep -oE 'src="[^"]+"' "$DIR/index.html"

# 撞名保护：连续生成两次，必须得到两个不同目录，旧目录内容不变
bash skills/frontend-slides/scripts/html.sh make \
  --content skills/frontend-slides/assets/examples/case-with-images.json \
  --name "病例展示_样例"
ls -d exports/病例展示_样例_* | wc -l    # 期望 2（同分钟则第二个带 -2）

# 原地更新：只改原目录的 index.html，不新建目录
bash skills/frontend-slides/scripts/html.sh make \
  --content skills/frontend-slides/assets/examples/case-with-images.json \
  --update "$DIR"
ls -d exports/病例展示_样例_* | wc -l    # 期望不变

# 单文件形态
bash skills/frontend-slides/scripts/html.sh make \
  --content skills/frontend-slides/assets/examples/case-report.json \
  --out "$PWD/exports/病例展示-单文件.html" --single-file
```

**命名断言（写入自动化测试）**：

```bash
ls -d exports/*/ | grep -qE '_[0-9]{8}-[0-9]{4}(-[0-9]+)?/$' || echo "目录名未带时间戳"
```

---

## 5. T3 —— 统一验收门

### 5.1 目标

让每个技能在交付前必须"过闸"：自动断言全过 + 逐页视觉确认有记录；**不过关不放行**。

### 5.2 现状证据

| Skill | 已有 | 缺 |
|---|---|---|
| **docx** | `qa-init` / `qa-record` / `qa-finalize`（`scripts/docxlib/qa.py`），带 `artifact_sha256` + 逐页 `image_sha256` | 已完善，作为参照实现 |
| **pptx** | `audit`（7 类错误码：`empty_deck` / `out_of_bounds` / `unresolved_placeholder` / `duplicate_unit` / `text_fit_risk` / `overlap` / `strict_overlap`）、`render`（默认 144 DPI） | 无强制逐页确认；渲染完可直接 `deliver` |
| **spreadsheets** | `audit`、`render --per-sheet` | 同上 |
| **pdf** | `audit`、`render --dpi 144`、`qa-checklist.md` | 只有文字清单，无程序化门 |
| **frontend-slides** | 无 | 全部（由 T2 补） |
| **diagram-maker** | 仅 XML/安全审计 | 无几何审计、无渲染、无视觉确认 |

### 5.3 实现思路

**统一产物 + 统一闸门语义**（各技能实现语言不同，但契约一致）：

```
scratch/qa/
├── acceptance.json     # 开工前冻结：要做什么、必须满足什么
├── review.json         # 逐页视觉确认记录（含 artifact / image sha256）
└── qa-report.json      # 汇总：L1 结果 + L2 状态 + 是否可交付
```

**闸门规则**：

- `status: passed` → 放行
- `status: needs-attention` → 非零退出 + 列出待处理项（可用 `--dispositions` 显式豁免）
- `status: not-performed`（环境缺失）→ **放行但必须带标记**，并在回复中写明「未完成视觉验收（原因）」

### 5.4 改动清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 新建 | `skills/_shared/qa/PROTOCOL.md` | 统一契约：三个文件的结构与状态机 |
| 新建 | `skills/_shared/qa/qa_common.py` | Python 侧公共：sha256、路径守卫、状态机 |
| 新建 | `skills/_shared/qa/qa_common.mjs` | Node 侧同能力 |
| 修改 | `skills/pptx/scripts/pptx_cli.mjs` | 新增 `qa-init` / `qa-record` / `qa-finalize`；`deliver` 加前置检查 |
| 新建 | `skills/pptx/scripts/lib/qa.mjs` | pptx 侧实现（复用 `render` 输出的 PNG） |
| 修改 | `skills/spreadsheets/scripts/spreadsheet_cli.mjs` | 同上，按 sheet 记页 |
| 新建 | `skills/spreadsheets/scripts/lib/qa.mjs` | 同上 |
| 修改 | `skills/pdf/scripts/pdf_cli.py` | 新增 `qa-init` / `qa-record` / `qa-finalize` |
| 新建 | `skills/pdf/scripts/pdfqa.py` | 仿 `docxlib/qa.py` 的精简实现 |
| 修改 | `skills/diagram-maker/scripts/diagram_cli.py` | 新增 `audit` 子命令（几何检查） |
| 修改 | 5 个 `SKILL.md` | 把"可选自检"改为"交付前必须过闸" |

### 5.5 diagram-maker 几何审计（纯计算，最便宜）

| 码 | 检查 |
|---|---|
| `label-overflow` | 文本包围盒超出画布 / 节点矩形 |
| `node-overlap` | 两个节点矩形相交 |
| `edge-cross-node` | 连线穿过非端点节点 |
| `orphan-node` | 无连线的孤立节点 |
| `font-missing` | `font-family` 不在系统栈白名单 |

### 5.6 验收

```bash
# 正向：满足要求的文件应放行
bash skills/pptx/scripts/pptx.sh make ...
bash skills/pptx/scripts/pptx.sh qa-init --input ...

# 反向：故意缺一项必填，应被拦住
# 期望 qa-finalize 非零退出，错误码 missing-required-section

# 降级：断开 office renderer 后
# 期望 qa-report.json 中 visual_acceptance = "not_performed"，deliver 仍成功
```

### 5.7 风险与降级

| 风险 | 缓解 |
|---|---|
| 远程 renderer 排队导致 qa 超时（此前已发生过 30s Bash 超时） | 拆两段：`qa-init` 同步做 L1，渲染另起；Bash 超时提到 120s 并允许分步重试 |
| 逐页确认显著拉长交互 | 页面数 > 8 时只强制"新增页 + 摘要页"，其余抽样 |
| 两个语言实现漂移 | `PROTOCOL.md` 固定字段；`scripts/check-qa-protocol.mjs` 对比两实现输出字段 |

### 5.8 进度

- [ ] 5.8.1 写 `PROTOCOL.md`（三文件结构 + 状态机）
- [ ] 5.8.2 实现 `qa_common.py` / `qa_common.mjs`
- [ ] 5.8.3 pptx 接入 qa 三件套 + `deliver` 前置检查
- [ ] 5.8.4 spreadsheets 接入
- [ ] 5.8.5 pdf 接入
- [ ] 5.8.6 diagram-maker 几何审计
- [ ] 5.8.7 5 个 SKILL.md 改为强制过闸
- [ ] 5.8.8 正 / 反 / 降级三类验收全部跑通

---

## 6. T4 —— 主题库扩展

### 6.1 目标

让 6 个技能共享同一套**有名字**的主题，用户可选、可自动推荐、交付时注明用了哪一套。

### 6.2 现状

| Skill | 主题数 | 说明 |
|---|---|---|
| pptx | 5 | clinical / academic / trauma / vital / mono，带 label + description |
| docx | 1 | 仅 `neutral-document-v1`（黑白公文风） |
| spreadsheets | 0 | 只有文字规范 |
| pdf | 0 | 无 |
| frontend-slides | 0 | 现有 A / B / C 是**密度**不是主题 |
| diagram-maker | 2 | `clean` / `architecture`，硬编码 |

### 6.2.1 主题定名（v1.1：改用中文名）

对用户一律使用中文名；ASCII id 只做内部键与命令行别名。

| 中文名（用户可见） | 内部 id | 别名 |
|---|---|---|
| **临床通用**（默认） | `clinical` | 临床、通用、clinical |
| **学术循证** | `academic` | 学术、汇报、academic |
| **战创伤急救** | `trauma` | 战创伤、创伤、急救、trauma |
| **影像检验** | `vital` | 影像、检验、化验、vital |
| **灰阶打印** | `mono` | 打印、黑白、灰阶、mono |

命名约束：

1. 中文名 2–6 字，能单独说明用途，不带形容词（不用"优雅蓝""高级灰"这类营销词）。
2. 一个中文名只对应一个 id，不允许两名一物或一名两物。
3. 改名等于改契约：已交付文件里回显的是中文名，改名需走第 10 节变更记录。

### 6.3 实现思路

1. **主题集固定为 5 个**（不扩张），沿用 pptx 现有命名，避免"20 个主题 100 种组合"的维护爆炸。
2. **密度是独立维度**，不混进主题：`theme`（配色）× `density`（信息密度）× `profile`（字体平台）。
3. **自动选择**：按任务类型查 `autoSelect` 表；用户指定则优先用户。
4. **必须回显**：生成结果里写明「本次使用主题：临床通用（clinical）」。
5. **字体策略按格式区分**，不能一刀切：

| 格式 | 字体策略 |
|---|---|
| PDF | 必须嵌入（已有 `skills/pdf/assets/fonts/NotoSansSC-VF.ttf`，**单个 17.7 MB**） |
| DOCX / PPTX | 可嵌入，注意体积 |
| HTML | **只用系统字体栈**，不打包 webfont（一个中文字体就 17.7 MB，页面背不动） |
| XLSX | **不能嵌字体**（`formatting.md` 已明确），只写字体名 |

### 6.4 改动清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 修改 | `skills/docx/scripts/docxlib/templates.py` | 增加 `themes` 覆盖层（title / heading / table_header / callout / accent） |
| 修改 | `skills/docx/scripts/docx_cli.py` | 新增 `themes` 子命令 + `make --theme` |
| 修改 | `skills/docx/references/design-and-layout.md` | 补主题说明与选择建议 |
| 修改 | `skills/spreadsheets/scripts/spreadsheet_cli.mjs` | spec 支持 `theme`；新增 `themes` 命令 |
| 修改 | `skills/spreadsheets/references/formatting.md` | 补主题落位规则（表头 / 章节行 / 强调） |
| 修改 | `skills/pdf/scripts/pdf_cli.py` | `make --theme` |
| 修改 | `skills/diagram-maker/scripts/diagram_cli.py` | 主题从 2 个扩到 5 个，值从共享令牌取 |
| 修改 | `skills/frontend-slides/scripts/htmllib/blocks.py` | 由 T2 直接消费共享令牌 |
| 修改 | 各 `SKILL.md` | 补「主题可选、默认自动、必须注明」 |

### 6.5 验收

```bash
# 每个技能都能列出同样的 5 个主题
node skills/pptx/scripts/pptx_cli.mjs themes
bash   skills/docx/scripts/docx.sh themes
bash   skills/spreadsheets/scripts/spreadsheet.sh themes
bash   skills/pdf/scripts/pdf.sh themes
bash   skills/diagram-maker/scripts/diagram.sh themes
bash   skills/frontend-slides/scripts/html.sh themes

# 输出里必须出现中文名（临床通用 / 学术循证 / 战创伤急救 / 影像检验 / 灰阶打印）
node skills/pptx/scripts/pptx_cli.mjs themes | grep -c "临床通用"

# 中文名与 ASCII 别名等价
bash skills/docx/scripts/docx.sh make --theme 临床通用 ...
bash skills/docx/scripts/docx.sh make --theme clinical  ...
# 两次产物除时间戳外应一致

# 同一主题、同一内容 → 抽出主色应一致
node scripts/check-skill-tokens.mjs --strict
```

### 6.6 风险

| 风险 | 缓解 |
|---|---|
| 加主题导致版面溢出（换字号/加粗后框不住） | 主题只改**颜色**，不改字号/间距；字号变化走 density 维度并有 `text_fit_risk` 审计 |
| Excel 主题被误认为可换字体 | SKILL.md + `formatting.md` 明确禁止承诺字体 |
| 用户选了不合适的主题 | 允许，但结果里注明主题名，便于用户纠正 |

### 6.7 进度

- [ ] 6.7.1 docx 主题支持 + `themes` 命令
- [ ] 6.7.2 spreadsheets 主题支持
- [ ] 6.7.3 pdf 主题支持
- [ ] 6.7.4 diagram-maker 主题扩到 5 个
- [ ] 6.7.5 各 SKILL.md 补「可选 / 默认 / 注明」规则
- [ ] 6.7.6 跨技能一致性验收
- [ ] 6.7.7 五个主题改为中文名 + ASCII 别名的双轨命名（6.2.1）

---

## 7. T5 —— 回归样本集

### 7.1 目标

建立"真实医学材料 + 明确期望"的固定考卷，任何技能改动都能跑一遍看是否退步。

### 7.2 现状

- 已有 `tests/skill-e2e/cases.json`（11 个用例）与 `scripts/run-skill-e2e.ts`
- `tests/skill-e2e/fixtures/` 只覆盖 3 个文件：`wse_0820_00_injury.jpg`、`medical-batch/admission-note.xml`、`medical-batch/ultrasound.dcm`
- 现有断言偏"行为断言"（是否调了 `docx.sh make`、产物是否在 `exports/`），**缺"质量断言"**（排版、主题、必含章节、数据一致）

### 7.3 实现思路

1. **每个技能 3 个样本**：最小可运行 / 中等真实 / 边界（缺数据、超长、特殊字符）。
2. **断言分两层**：
   - 行为层：沿用现有 `expectBashNeedle` / `expectOutputGlob`
   - 质量层：新增 `acceptance` 字段，直接喂给 T3 的 `qa-report.json` 做校验
3. **确定性检查**：HTML 与 diagram 支持"跑两次字节一致"。
4. **基线记录**：首次跑出通过率写进本文，后续只允许上升。

### 7.4 改动清单

| 动作 | 文件 | 说明 |
|---|---|---|
| 新建 | `tests/skill-e2e/fixtures/general/` | 通用样本：病例摘要、检验表、救治方案 |
| 新建 | `tests/skill-e2e/fixtures/html/` | HTML 样本：`content.json` + 期望章节 |
| 新建 | `tests/skill-e2e/expectations/` | 每案例的 `acceptance.json` |
| 修改 | `tests/skill-e2e/cases.json` | 每个技能补 3 条；新增 `acceptancePath`、`deterministic` 字段 |
| 修改 | `scripts/run-skill-e2e.ts` | 支持 `--case <id>`、`--only skill`，输出 summary |
| 新建 | `scripts/run-skill-samples.mjs` | 只跑"确定性 + 质量断言"的快速回归（不调模型，测脚本层） |
| 修改 | `package.json` | 新增 `test:skill-samples` |

### 7.5 验收

```bash
npm run test:skill-samples                      # 脚本层回归，秒级
npx tsx scripts/run-skill-e2e.ts --case docx    # 单案例端到端
npx tsx scripts/run-skill-e2e.ts --only frontend-slides
```

**基线要求**：T5 完成时，脚本层回归通过率 = 100%（这是可控的）；端到端样本通过率记录为基线，不要求 100%。

### 7.6 风险

| 风险 | 缓解 |
|---|---|
| 端到端跑模型慢（单案例可达数分钟） | 拆两个套件：`test:skill-samples`（秒级，CI 必跑）/ 端到端（手动或夜间跑） |
| 样本含敏感医疗数据 | 只用项目内可公开材料 + 合成病例 |
| 样本与真实用法脱节 | 每条注明来源与场景；后续用真实失败案例替换 |

### 7.7 进度

- [ ] 7.7.1 收集并整理 6 技能 × 3 类样本
- [ ] 7.7.2 为每条补 `acceptance.json`
- [ ] 7.7.3 扩展 `cases.json` 与 runner
- [ ] 7.7.4 实现 `run-skill-samples.mjs`
- [ ] 7.7.5 记录首轮基线通过率

---

## 8. 风险登记（跨任务）

| 编号 | 风险 | 影响 | 触发条件 | 应对 |
|---|---|---|---|---|
| R1 | 上下文预算被撑爆 | 技能文档越长，模型生成质量下降 | SKILL.md 超 250 行 | 硬规则：SKILL.md ≤ 200 行，长内容进 `references/` 按需读 |
| R2 | 远程 Office Renderer 不可用 | 视觉验收无法完成 | 内网 / 服务停机 | 交付有效文件 + 明示「未完成视觉验收（原因）」 |
| R3 | 离线环境无浏览器 | HTML 截图不可用 | 部署环境无 Playwright | 截图永不作硬依赖；静态审计独立成立 |
| R4 | 打包漏拷 `_shared` | 6 个技能同时异常 | 打包脚本未更新 | 读取器内置 fallback + 打包前跑 `check-skill-tokens.mjs` |
| R5 | 模型一次生成过大导致超时 | `TOOL_ERROR[tool_timeout]` | 单次 `write_file` > 10KB | T2 拆分生成；`edit_file` 局部改；Bash 超时分级 |
| R6 | 主题/令牌改动破坏既有版面 | 已交付文件风格突变 | 共享令牌默认值变更 | 默认主题值冻结；改值需走迁移记录 |

---

## 9. 执行日志

> 每完成一个子任务追加一行。**不要删除历史行。**

| 日期 | 任务号 | 变更摘要 | 涉及文件 | 验收命令与结果 | 遗留问题 |
|---|---|---|---|---|---|
| 2026-11-04 | — | 建立任务书，未改代码 | `docs/skills-optimization-plan.zh.md` | — | — |

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-04 | v1.2：文件夹交付目录名改为 `<页面短名>_<YYYYMMDD-HHmm>`，入口固定 `index.html`，不覆盖、支持 `--update` 原地更新（4.10.2 / 4.10.6） |
| 2026-11-04 | v1.1：T2 增加文件夹交付与图片区块（4.10）；T4 主题改为中文名 + ASCII 别名双轨（6.2.1） |
| 2026-11-04 | 初版：T1–T5 + 全局验收口径 + 风险登记 |

---

## 附：一张图看懂全部工作

```
现在                               改后
─────────────────────────────     ─────────────────────────────
6 个技能各自定义颜色               1 份 design-tokens.json
HTML 靠模型手写 18KB               content.json(3KB) → 模板 → HTML
PPT/Excel/PDF 审计完照样交付       不过闸不交付
只有 PPT 有主题                    6 个技能共用 5 个命名主题
改完不知道有没有改坏              跑一遍样本集就有答案
```
