# HTML 主题令牌

主题只负责**颜色与字体角色**，不改变页面结构、密度或交互。A/B/C 三档仍表示
阅读距离与信息密度，两者正交。

## 六套主题

| ID | 中文名 | 别名 | 适合 | 不建议 |
| --- | --- | --- | --- | --- |
| `clinical` **（默认）** | 临床晨光 | 临床、晨光、clinic-dawn | 门诊、出院小结、一般报告、影像报告 | 荟萃分析 |
| `academic` | 青黛循证 | 循证、学术、research | 荟萃分析、文献综述、科研标书 | 患者宣教 |
| `trauma` | 松风急救 | 急救、战创伤、emergency | 创伤、急诊、分诊、流程 | 文献综述 |
| `archive` | 宣纸病案 | 宣纸、病案、case-archive | 长病程、归档病案、病史回顾 | 急救、投屏 |
| `edu` | 杏林宣教 | 宣教、健康教育、patient-education | 患者教育、公共卫生 | 急救、法律文书 |
| `mono` | 灰阶印刷 | 灰阶、黑白、grayscale | 只能黑白打印、复印 | 彩色投影 |

**未指定时一律用 `clinical`（临床晨光），不要自行另选。** 只有内容用途明显更合适时
才可换（如“文献综述”→“青黛循证”），并在回复中说明换了哪套、为什么。

## 怎么用

1. 把 `assets/themes/pd-themes.css` 全文复制进 `<style>`；
2. `<html lang="zh-CN" data-pd-theme="academic">`；属性里必须写**英文 ID**，
   中文名和别名只用于对话与选择，审计会拒绝把别名写进 `data-pd-theme`；
3. 样式只用令牌：

| 令牌 | 用途 |
| --- | --- |
| `--pd-paper` / `--pd-surface` | 页面底色 / 卡片、表格底 |
| `--pd-ink` / `--pd-muted` | 正文 / 次要说明 |
| `--pd-primary` / `--pd-on-primary` | 主色（标题、表头）/ 主色上的文字 |
| `--pd-accent` / `--pd-support` | 强调线、提示块左边线 / 辅助信息 |
| `--pd-rule` / `--pd-soft` | 分隔线、边框 / 浅底块 |
| `--pd-on-dark` / `--pd-on-dark-muted` | 深色影像底板上的主/次文字 |
| `--pd-danger` / `--pd-warning` / `--pd-success` / `--pd-info` | 固定语义色，不随主题变化 |
| 同名 `-bg`（如 `--pd-danger-bg`） | 语义色浅底 |
| `--pd-font-body` / `--pd-font-heading` / `--pd-font-mono` | 正文字体 / 标题字体 / 数字与编码 |

`archive` 的标题与正文是衬线栈，其余主题是无衬线栈；不要在页面里另写字体名。

## A/B/C 变量的桥接

生成文件末尾已带一段 `html[data-pd-theme] { --bg: var(--pd-paper); ... }`。
如果页面沿用现有 A/B/C 变量（`--bg`/`--surface`/`--text`/`--muted`/`--border`/
`--accent`/`--accent-soft`），贴入整份 CSS 后会自动跟随主题。页面后面的
局部覆盖仍然生效。

## 硬规则

- **单文件：** 主题 CSS 必须内联；禁止 `<link rel="stylesheet">`、`@import`、
  Google Fonts / CDN。
- **字体：** 单文件交付只用系统字体栈（令牌已给全）。文件夹交付可在
  `assets/fonts/` 放本地字体并由页面相对引用；不要引用系统目录外的绝对路径。
- **颜色：** 只允许 `primary` / `accent` / `support` 三个装饰角色；红/琥珀/绿/蓝
  只表达真实语义。不要出现主题外第四种高饱和色。
- **不要自造主题：** 主题 ID 不认识时先修 `data-pd-theme` 或换主题，不要手写一套
  近似色。

## 签名组件（可选类名）

生成文件 `pd-themes.css` 末尾自带一组可选组件样式，同一类名在六套主题下长得不一样，
由各自的 `surface` 令牌决定。用了就是主题签名，不用也不影响页面：

| 类名 | 放在哪 | 各主题差异 |
| --- | --- | --- |
| `.pd-masthead` | 页首通栏信息条 | `academic` 实心色带、`clinical`/`trauma` 顶部粗线、`mono` 上下双细线、`archive` 细线、`edu` 无装饰 |
| `.pd-section-marker` | 章节标题（`h2`） | `clinical` 左侧强调竖线、`academic` 主色侧栏、`trauma` 胶囊标签、`archive` 中文数字风格、`edu` 圆点 |
| `.pd-table thead th` | 表格表头 | `primary-fill` 主色底、`ink-rule` 墨色下划线、`soft-fill` 浅底、`ink-fill` 墨色底 |
| `.pd-callout` | 提示/结论块 | `left-rule-soft` 左侧强调线、`hairline-box` 细线框、`rounded-card` 圆角卡 |
| `.pd-imaging` | 影像底板 | `clinical`/`mono` 深色底板（配 `--pd-on-dark` 文字）、其余主题不套底板 |
| `.pd-footer` | 页脚 | 细线（`edu` 无） |
| `.pd-stamp` | 印章/标记 | 所有主题统一：2px `accent` 边框 + 字距，常用于「已核对」「脱敏」 |

组件只引用已有令牌，不新增颜色。想看某个主题的成品，把类名贴进页面后交给用户确认——
本技能不做浏览器渲染，`visual_acceptance` 仍是 `not_performed`。

## 静态审计

```bash
bash "$FRONTEND_SLIDES_ROOT/scripts/html.sh" audit <文件或目录>
```

事实类检查（必须清零）：外链资源/脚本/字体、`file://`、绝对路径、目录穿越、
资源缺失、`id` 重复、未闭合标签、主题令牌缺失或与共享令牌不一致、空 `alt`。

安全类：`javascript:` 链接、`data:text/html` / `data:image/svg+xml` 等可执行
载荷、指向外网的 `meta refresh` 一律判错；内联 `on*` 事件、外网表单提交判警告。
整页请加 `<meta name="viewport">`，否则窄屏会按桌面宽度缩放。

警告类（可解释后保留）：缺少 `<title>`/`lang`/`charset`、空 section、
图片无 `alt`、内联脚本含 `fetch`/`WebSocket`、单文件超过 8 MB。

不做浏览器渲染，也不截图；`visual_acceptance` 固定记为 `not_performed`。
用户回传截图时以截图为准定位区块，再改、再生成新文件/新目录。

## 交付与验收

```bash
bash "$FRONTEND_SLIDES_ROOT/scripts/html.sh" package --html <页面.html>
bash "$FRONTEND_SLIDES_ROOT/scripts/html.sh" verify <交付目录>
```

`package` 生成 `exports/<短名>_<时间>/index.html` + `assets/` + 同名 `.zip`。
zip 内是入口页与页面实际引用的资源，条目时间戳固定，同一输入重复打包字节一致。
`verify` 检查入口页审计结果、zip 与磁盘每个文件是否一致；缺 zip 只算警告。

## 静态预算（可选）

页面可以给区块加 `data-pd-block="section|table|callout|figure-grid"`，图组可加
`data-pd-columns="3"`。审计会按字符宽度模型粗估高度和列宽：

- 高度 > 1350px → `estimate-tall-block`
- 表宽 > 1440px → `estimate-wide-table`
- 图组宽 > 1440px → `estimate-figure-overflow`

只是警告，只进内部报告，不阻断交付，也不改页面；不想看就加 `--no-estimate`。
自由布局、手写 HTML 不标这些属性完全没问题。
