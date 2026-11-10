# PPTX 页面纹理（默认开启）

> 决策日期：2026-11-09　状态：已上线，默认生效

## 为什么改

评审反馈「自动排版出来都是单色平涂，没有设计感」。核对代码后确认：16 种版式的背景
全部走同一个函数，而那个函数只画一个纯色矩形——`addBackground()` 里没有渐变、纹理、
图案或装饰。

这是**视觉层**缺口，不是版式缺口：版式结构（卡片、徽章、分隔线、时间轴）已经够用。

## 改了什么

- 新增素材 `skills/pptx/assets/textures/grain.png`（800×450，27 KB 起，双面纹理：
  中灰斑驳在浅底显暗、白色高光颗粒在深底提亮，一张图同时适配明暗页面）
- `addBackground(pptx, slide, color, name, texture)` 在纯色之上叠一层全幅纹理
- 纹理经 `resolveDesignTokens({ texture })` 注入，**16 种版式全部自动生效**，无需逐页改

## 默认值变更记录（D1）

原决策 D1 要求「未批准的默认观感刷新不得合入」。本次经需求方确认后执行，
以 PowerPoint 导出的 PDF 逐页目视核对作为改前/改后证据：

| | 无纹理 | 有纹理 |
| --- | --- | --- |
| 封面 | 纯 `#1A3A5F` | 同底色 + 轻微斑驳与边缘压暗 |
| 内容页 | 纯白 | 纸面颗粒 + 纤维痕 |

## 开关

```bash
# 默认：grain
pptx.sh make --spec deck.json --out deck.pptx

# 关闭，回到纯色平涂（历史观感）
pptx.sh make --spec deck.json --out deck.pptx --texture none

# 换纹理（读取 assets/textures/<name>.png）
pptx.sh make --spec deck.json --out deck.pptx --texture <name>
```

- 显式指定但不存在的纹理 → 直接报错，不回退
- 技能被部分拷贝、缺 `assets/textures/` 时 → 隐式默认退化为平涂，返回
  `textureFallback: "missing-asset"`；显式请求仍然报错

## 已知代价

- 位图按页嵌入，未去重：12 页约 +1.6 MB。需要控体积时用 `--texture none`，
  后续可做 media 去重（同一图片只写一份）
- 纹理是固定位图，不随主题变化；深色页效果弱于浅色页（已用白色高光层补偿）

## 验证

- `node --test tests/skills/*.test.mjs` → 146/146
- `tests/skills/pptx-texture.test.mjs`：默认带纹理、`none` 关闭、未知纹理报错
- `pptx.sh audit` 对开启纹理的 12 页 deck → `passed`，issues 0
- 默认路径的幻灯片 XML 与改动前逐字节一致（仅 `docProps` 时间戳不同）

---

# 第二批：结构令牌接通 + 组件升级（2026-11-09）

## 根因

`design-tokens.json` 里每套主题都写了 `surface`（masthead / sectionMarker /
tableHeader / callout / imagingPanel / footer），但 `toolkit.resolveDesignTokens()`
只把 `colors`、`typography`、`chart` 带回给布局层，**`surface` 直接丢了**。
所以六套主题过去只有配色不同，版式几何逐字节一致（125 个形状 0 处差异）。

## 接通方式

- `toolkit.mjs`：解析共享主题时把 `resolved.theme.surface` 并入 `tokens.surface`
- `core.mjs`：页眉、页码标记、表头、结论卡四处改由 `tokens.surface` 决定形态
- 未指定主题时布局使用与 `clinical` 等价的内置默认值，行为可预测

## 各主题的实际差异

| 主题 | masthead | sectionMarker | tableHeader | callout |
| --- | --- | --- | --- | --- |
| clinical | `rule-line` 标题下粗强调线 | `number-accent` 大号数字 | `primary-fill` 深色表头 | `left-rule-soft` 左竖线卡片 |
| academic | `solid-band` 通栏色带 + 反白标题 | `number-sidebar` 侧栏色块编号 | `primary-fill` | `left-rule-soft` |
| trauma | `rule-line` | `phase-chip` 圆角胶囊 | `primary-fill` | `left-rule-soft` |
| archive | `hairline` 顶部细线 | `cn-number` 中文序号（一/二/四…） | `ink-rule` 纸色表头 + 重线 | `hairline-box` 细边框卡片 |
| edu | `none` 无装饰 | `dot` 圆点 | `soft-fill` 浅色表头 | `rounded-card` 圆角卡片 + 投影 |
| mono | `rule-grid` 双细线标尺 | `plain` | `ink-fill` 墨色表头 | `left-rule-soft` |

## 同批组件升级

| 项 | 做法 | 影响面 |
| --- | --- | --- |
| 卡片微投影 | 统一 `CARD_SHADOW`（外阴影，10% 不透明度） | 资料卡、结论卡 |
| 标题强调线 | 非色带主题在标题下画 1.15in 的 accent 线 | 全部内容页 |
| 页码标记 | 六种形态，由 `sectionMarker` 决定 | 全部内容页 |
| 表格 | 斑马纹（`soft`）+ 首列加粗 + 四种表头风格 + 按行数垂直居中 | 表格页 |
| 图表 | 单系列柱/饼图默认显示数值标签，网格线减细至 0.75pt | 图表页 |

## 验证

- 六套主题各生成 12 页，PowerPoint 导出 PDF 后逐页目视核对
- `pptx.sh audit`：六套全部 `passed`，`issues: 0`
- `node --test tests/skills/*.test.mjs` → 155/155

---

# 第三批：封面也吃 masthead（2026-11-09）

## 问题

前两批只让**内容页**的页眉、页码、表头、结论卡吃 `surface` 令牌，封面
（`titleSlide`）仍是写死的一套：全幅深底 + 短强调线 + 左上标题。结果六套主题
打开第一页几乎一样，只有底色不同。

## 做法

`titleSlide` 按 `surface.masthead` 分成五套结构（trauma 另有一个 `phase-chip` 子分支）：

| masthead | 主题 | 封面结构 |
| --- | --- | --- |
| `rule-line` | clinical | 全幅主色场 + 标题下一道 1.25in 强调线 |
| `rule-line` + `sectionMarker: phase-chip` | trauma | 全幅主色场 + **左侧 0.22in 贯穿色带** + 强调线 |
| `rule-grid` | mono | 全幅主色场 + **通栏标尺（1 条横线 + 5 个刻度）**，无强调线 |
| `solid-band` | academic | 纸色页 + 顶部 2.9in 主色带（反白标题）+ 色带下 accent 横条 |
| `hairline` | archive | 纸色页 + 内嵌细边框 + 硃红印记方块 + 衬线标题 + 细分隔线 |
| `none` | edu | 浅柔底 + 白色圆角大卡片（带投影）+ accent 圆点 |

**为什么给 mono 新增枚举值 `rule-grid`：** 第一版把 mono 挂在 `rule-line` 下、用
`sectionMarker: plain` 当第二判据，结果是「靠另一个令牌偷渡结构」——`masthead` 这个
字段就没说实话。现在 `rule-grid` 是独立枚举：schema、`design-tokens.json`、
`core.mjs`、`theme-css.mjs`（HTML 的 `.pd-masthead`）四处同步声明，pptx 的封面与
内容页都由它直接决定形态，不再依赖 `sectionMarker`。

trauma 仍保留 `phase-chip` 子分支：它的左侧色带表达的是「急救」语义，而
`phase-chip` 在公开主题里只有 trauma 使用，这对组合是唯一且稳定的。

## 卡片与文字归属

| 元素 | 取色 | 说明 |
| --- | --- | --- |
| academic 色带上的标题 | `onPrimary` | 文字压在 primary 填充上 |
| academic 色带上的 eyebrow | `onDarkMuted` | 唯一还落在深色上的辅助文字 |
| academic 纸色半幅的副标题 | `ink` | 已离开色带，回到正文墨色 |
| 其余深底封面 | `white` / `onDark` / `onDarkMuted` | 与原设计一致 |

`tests/skills/pptx-fonts.test.mjs` 随之更新：原先断言封面必须有 `onDark`
（旧平涂封面的副标题色），现在断言 `onPrimary` + `onDarkMuted` + `ink` 三个令牌都
出现，且历史硬编码灰（`C7D8E5` / `D7E2EA` / `A9BECC`）一个都不许出现。

## 回归保护

`tests/skills/pptx-themes.test.mjs` 新增一条：六套主题各建一份封面，断言
`Cover Band` / `Cover Edge Bar` / `Cover Frame` / `Cover Card` / `Title Accent`
/ `Cover Ruler` 分别出现在对应主题里，且六份 slide1 XML 两两不同。

## 验证

- 六套主题 × 12 页：`make` 全部 `status: ok`，`audit` 全部 `passed`，`issues: 0`
- PowerPoint 导 PDF 逐张目视核对封面（存于 `~/Downloads/theme-preview/covers.png`）
- `node --test tests/skills/*.test.mjs` → 155/155

## 已知局限

- clinical 与 mono 同为「全幅深底」家族，靠主色 + 标尺 / 强调线区分；结构已不同，
  但缩略图尺寸下主色差异比结构差异更先被看到。
- archive 的衬线标题在缺少 `Noto Serif CJK SC` 的机器上会回退到系统衬线，观感变化较大。

## 字体是否随包分发（回答「不需要目标机装字体」）

| 产物 | 字体怎么进去的 | 缺字体时 |
| --- | --- | --- |
| PDF | `skills/pdf/assets/fonts/` 里的 `NotoSansSC-VF.ttf`、`NotoSerifSC-Regular.ttf` 被子集化**嵌入文件** | 不受影响，PDF 自带 |
| PPTX / DOCX / XLSX | OOXML 只写**字体名**（现为 `Microsoft YaHei` / `SimSun`），不含字体文件 | 打开方按名字找字体，找不到就替换（几何会移位） |
| HTML | `fontRoles.*.htmlStack` 只给 CSS 字体栈，`htmlBundle` 目前为空，没有 `@font-face` | 逐级回退到系统字体 |

所以「打包后不需要机器内置字体」这句话**只对 PDF 成立**。PPTX 的渲染方（用户本机
PowerPoint，或我们的 Office Renderer / LibreOffice）必须能解析到这些名字；
`scripts/platform-preflight.mjs` 就是为此写的：它把 OOXML 里实际写的字体名拿去
`fc-match`，解析到日/韩字形时报警。

### 实测（2026-11-10，本机 macOS）

| 检查 | 结果 |
| --- | --- |
| `v4-*.pptx` 内是否有 `ppt/fonts/`、`presentation.xml` 是否有 `embeddedFontLst` | 都没有，0 处 |
| `fc-match "Noto Sans CJK SC"` / `"Noto Serif CJK SC"` | 都落到 `Verdana`，本机**没有** Noto CJK |
| PowerPoint 导出的 PDF 实际字体 | 六套主题**全部**是 `MicrosoftYaHei` + `Calibri` |
| archive 主题（应为衬线） | pptx 里写的是 `Noto Serif CJK SC`，导出 PDF 里仍是 `MicrosoftYaHei`，**衬线没生效** |

也就是说：所谓「衬线主题」在本机渲染其实是黑体。这不是本次改动引入的，是字体名
解析不到时的静默替换。

### 自带字体文件的家族名对不上

| 文件 | 家族名 | pptx 里写的名字 |
| --- | --- | --- |
| `NotoSansSC-VF.ttf` | `Noto Sans SC` | `Noto Sans CJK SC`（主题路径）/ `Noto Sans SC`（`make` 路径） |
| `NotoSerifSC-Regular.ttf` | `Noto Serif SC` | `Noto Serif CJK SC` |

即便把这两个 TTF 随包安装，也**满足不了** `Noto Sans CJK SC` / `Noto Serif CJK SC`
这两个名字——它们指向的是另一套字体（CJK OTC 版本）。

### 决策（2026-11-10）：改写目标机自带的字体名

医生用自己的电脑打开文件，我们无法保证他装了任何字体。所以不再"想办法把 Noto 送到
他机器上"，而是**改写成他机器上一定有的名字**：

| 用途 | 写的名字 | 为什么安全 |
| --- | --- | --- |
| 无衬线（clinical / academic / trauma / edu / mono） | `Microsoft YaHei` | Windows 系统自带；Office for Mac 在 `Microsoft PowerPoint.app/Contents/Resources/DFonts/msyh.ttc` 自带 |
| 衬线（archive） | `SimSun` | Windows 自带；Office for Mac 自带 `Simsun.ttc` |
| 等宽数字 | `Consolas` | Windows 自带；Office for Mac 自带 `Consola.ttf` |

**已验证（macOS + PowerPoint，导出 PDF 后读字体表）：**

- `archive` 封面实际字体 = `SimSun`，衬线真实出现（改之前是 `MicrosoftYaHei`，衬线丢失）；
- 其余五套 = `Microsoft YaHei`（此前是"被替换成雅黑"，现在是"按名字就是雅黑"，结果一致但不再是运气）。

**仍未覆盖的情况：** 装了 Office 才有雅黑/宋体的 Mac。只用 Keynote / 快速预览打开的
Mac 用户仍会替换——这类场景请交付 PDF。

## 默认观感变更

本次改动同时改变了未指定主题时的输出（标题强调线、页码标记、表格斑马纹、数值标签）。
与纹理一样属于已批准的默认刷新，两者叠加后再冻结基线。
