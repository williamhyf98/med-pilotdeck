# Med-PilotDeck 主题令牌规范

> 版本：v1.0（2026-11-06）
>
> 状态：**规范已定稿，尚未实现**。本文件是 T1 / T4 的编码依据，描述“应该建成什么样”，不代表代码已经这样。
>
> 上游任务书：`docs/skills-optimization-plan.zh.md`。两者冲突时以任务书的验收口径为准，本文件负责把令牌写到可直接落地的粒度。

---

## 0. 一句话

用**一个** `skills/_shared/design-tokens.json` 定义 6 套中文主题的**颜色、字体角色、组件规则**；六个技能各自解释这些令牌，不共享尺寸单位，也不承诺像素一致。

---

## 1. 四条设计原则

1. **三轴分离。** `designTheme` 管配色与气质，`layoutVariant` 管版式与组件组织，`density` / 字体 profile 管阅读密度与目标平台。三者互不替代。
2. **语义色锁定。** 红 / 琥珀 / 绿 / 蓝的临床含义由系统固定，任何主题都不得覆盖。主题只提供“装饰色”，不提供“异常色”。
3. **分档支持。** HTML / PDF / PPTX 做全量主题（含签名组件）；DOCX / XLSX / diagram-maker 只做令牌级。不追求六种格式长得一样。
4. **单真源 + 宽进严出。** 主题数据只有一份；读取端容忍未知字段（前向兼容），校验端对缺字段、别名冲突、对比度不达标一律失败。

---

## 2. 文件、加载与失败策略

| 项 | 约定 |
| --- | --- |
| 路径 | `skills/_shared/design-tokens.json`（随离线包分发） |
| 读取器 | `skills/_shared/tokens.mjs`（Node）、`skills/_shared/tokens.py`（Python 标准库） |
| 只读性 | 读取器不得加载 `sharp`、`python-docx`、`xlsxwriter` 等技能运行时 |
| 查找顺序 | 应用包内置 `skills/_shared` → 技能包同级的约定位置；**不从任意上级目录读取**同名文件 |
| 缺文件 | 运行端可用内置最小色板继续生成，结果与 QA 报告必须标记 `builtin-fallback` 及原因 |
| 文件损坏 / 版本过高 | 明确报错，不静默降级 |
| 打包检查 | 离线包缺少 `design-tokens.json` 或字体资源时**构建失败**，不允许用 fallback 掩盖漏包 |

---

## 3. 顶层结构

```json
{
  "schemaVersion": 2,
  "defaultTheme": "clinical",
  "semantic": {
    "danger":  { "fg": "B42318", "bg": "FDECEC", "onFg": "FFFFFF" },
    "warning": { "fg": "B45309", "bg": "FDF3E3", "onFg": "FFFFFF" },
    "success": { "fg": "157F3D", "bg": "E9F5EE", "onFg": "FFFFFF" },
    "info":    { "fg": "1F5FA9", "bg": "EAF1FA", "onFg": "FFFFFF" }
  },
  "fontRoles": {
    "sans": {
      "officeWindows": "Microsoft YaHei",
      "officeMac": "PingFang SC",
      "libreOffice": "Noto Sans CJK SC",
      "pdfFile": "NotoSansSC-VF.ttf",
      "htmlStack": "\"Noto Sans SC\",\"Source Han Sans SC\",\"PingFang SC\",\"Microsoft YaHei\",\"Noto Sans CJK SC\",system-ui,sans-serif",
      "htmlBundle": ["noto-sans-sc-400.woff2", "noto-sans-sc-700.woff2"]
    },
    "serif": {
      "officeWindows": "SimSun",
      "officeMac": "Songti SC",
      "libreOffice": "Noto Serif CJK SC",
      "pdfFile": "NotoSerifSC-VF.ttf",
      "htmlStack": "\"Noto Serif SC\",\"Source Han Serif SC\",\"Songti SC\",\"SimSun\",\"Noto Serif CJK SC\",serif",
      "htmlBundle": ["noto-serif-sc-400.woff2", "noto-serif-sc-700.woff2"]
    },
    "mono": {
      "officeWindows": "Consolas",
      "officeMac": "Menlo",
      "libreOffice": "DejaVu Sans Mono",
      "pdfFile": null,
      "htmlStack": "ui-monospace,\"SFMono-Regular\",Menlo,Consolas,monospace",
      "htmlBundle": []
    }
  },
  "themes": {
    "clinical": {
      "label": "临床晨光",
      "aliases": ["临床", "晨光", "clinic-dawn"],
      "status": "stable",
      "bestFor": ["outpatient", "discharge", "general-report", "imaging-report"],
      "avoidFor": ["meta-analysis"],
      "textUnsafe": [],
      "colors": {
        "paper": "FBF9F6",
        "surface": "FFFFFF",
        "ink": "1C2B33",
        "muted": "5C6B72",
        "primary": "12404F",
        "accent": "B4552D",
        "support": "2F7183",
        "rule": "E3DED7",
        "soft": "F3EAE3",
        "onPrimary": "FFFFFF",
        "onDark": "F2EDE7",
        "onDarkMuted": "BFD2D6"
      },
      "chart": {
        "series": ["12404F", "B4552D", "7C8B93"],
        "grid": "E3DED7",
        "axis": "5C6B72"
      },
      "typography": {
        "headingRole": "sans",
        "bodyRole": "sans",
        "numericRole": "mono",
        "headingWeight": 700,
        "bodyScale": 1.0,
        "lineHeightScale": 1.0,
        "letterSpacing": 0.0
      },
      "surface": {
        "masthead": "rule-line",
        "sectionMarker": "number-accent",
        "tableHeader": "primary-fill",
        "callout": "left-rule-soft",
        "imagingPanel": "dark-panel",
        "footer": "hairline"
      },
      "layoutVariant": "report"
    }
  },
  "recommend": [
    { "match": ["meta-analysis", "literature-review", "grant"], "theme": "academic" },
    { "match": ["trauma", "emergency", "triage", "protocol"], "theme": "trauma" },
    { "match": ["long-case", "archive", "history"], "theme": "archive" },
    { "match": ["patient-education", "public-health"], "theme": "edu" },
    { "match": ["print-only", "grayscale"], "theme": "mono" }
  ]
}
```

说明：

- 真实文件是**严格 JSON**，上面的 `themes` 只展开 `clinical` 作为示例，实际文件包含第 5 节的全部 6 套。
- 颜色一律为 6 位十六进制、无 `#`，与现有 `design-tokens.json` 保持一致。
- `status` 取值：`stable` / `deprecated` / `hidden`。
- `textUnsafe` 列出“不得用于正文小字”的颜色键；这些颜色仍可用于图形、色块、大号标题。

---

## 4. 颜色令牌字典

| 令牌 | 语义 | 允许用于正文小字 | 门槛 |
| --- | --- | --- | --- |
| `paper` | 页面底色（文档/网页/SVG 背景） | — | 与 `ink` ≥ 7.0 |
| `surface` | 卡片、表格单元格、内容块底色 | — | 必须为浅色，与 `primary` ≥ 4.5（用于压字时） |
| `ink` | 正文与标题主色 | 是 | 对 `paper` ≥ 7.0 |
| `muted` | 次要说明、图注、页脚 | 是 | 对 `paper` ≥ 4.5 |
| `primary` | 结构色：页眉、表头、章节号、主图形 | 是 | 对 `paper` ≥ 4.5 |
| `accent` | 强调色：关键数值、当前项、警示性装饰 | 是（除非列入 `textUnsafe`） | 对 `paper` ≥ 4.5，否则 ≥ 3.0 且仅图形 |
| `support` | 次强调：第二数据系列、证据标签、辅助图形 | 同上 | 同上 |
| `rule` | 分隔线、表格边框、网格 | 否（纯装饰） | 不承载信息；不得单独用线型表达状态 |
| `soft` | 提示块底色、斑马纹 | — | 与 `paper` 的相对亮度差 ≥ 0.03，与 `ink` ≥ 7.0 |
| `onPrimary` | 压在 `primary` 上的文字 | 是 | 对 `primary` ≥ 4.5 |
| `onDark` | 深色影像底板上的主文字 | 是 | 对 `primary` ≥ 4.5 |
| `onDarkMuted` | 深色底板上的次要文字 | 是 | 对 `primary` ≥ 4.5 |
| `chart.series[]` | 分类图表配色（**最多 3 个系列**） | — | 每个对 `paper` ≥ 3.0；相邻相对亮度差 ≥ 0.05 |

**固定语义色**（`semantic.*`，任何主题不得覆盖）：

| 角色 | fg | bg | 使用规则 |
| --- | --- | --- | --- |
| `danger` | `B42318` | `FDECEC` | 仅真实异常、危急值、禁忌 |
| `warning` | `B45309` | `FDF3E3` | 仅风险提示、待确认、临界值 |
| `success` | `157F3D` | `E9F5EE` | 仅“已完成 / 正常 / 达标” |
| `info` | `1F5FA9` | `EAF1FA` | 中性提示，不表示临床状态 |

> 红绿不得作为唯一区分手段：异常项必须同时有文字（“↑ / 异常 / 高于参考”）或符号。灰阶打印后语义仍须可读。

---

## 5. 六套主题完整令牌表

### 5.1 基础色

| 令牌 | 临床晨光 `clinical` | 青黛循证 `academic` | 松风急救 `trauma` | 宣纸病案 `archive` | 杏林宣教 `edu` | 灰阶印刷 `mono` |
| --- | --- | --- | --- | --- | --- | --- |
| `paper` | `FBF9F6` | `F7F8FA` | `F5F6F2` | `FAF6EC` | `FBF9F4` | `F5F6F7` |
| `surface` | `FFFFFF` | `FFFFFF` | `FFFFFF` | `FFFDF7` | `FFFFFF` | `FFFFFF` |
| `ink` | `1C2B33` | `16202A` | `1A211C` | `22201C` | `22302A` | `1A1D21` |
| `muted` | `5C6B72` | `5A6472` | `5B665E` | `5F5A50` | `56655D` | `5B636B` |
| `primary` | `12404F` | `1A3A5F` | `1D3B2A` | `2B2A26` | `2E5643` | `22282E` |
| `accent` | `B4552D` | `0F6E62` | `A55C11` | `9C3B2E` | `A85C22` | `5A646E` |
| `support` | `2F7183` | `A87B2A` | `2F6B57` | `6B5A3E` | `657747` | `7F888F` |
| `rule` | `E3DED7` | `DCE1E8` | `D8DED4` | `E6DFD0` | `E2E4D9` | `D5D9DD` |
| `soft` | `F3EAE3` | `E8F0EF` | `EDF0E6` | `F2EBDD` | `F1F3E7` | `ECEEF0` |
| `onPrimary` | `FFFFFF` | `FFFFFF` | `FFFFFF` | `FBF7EE` | `FFFFFF` | `FFFFFF` |
| `onDark` | `F2EDE7` | `E9EEF4` | `E7EDE6` | `EFE8D8` | `EDF2EC` | `F2F4F5` |
| `onDarkMuted` | `BFD2D6` | `B9C7D6` | `BCCBBE` | `C6BBA0` | `C3D0C2` | `C2C8CD` |
| `textUnsafe` | — | `support` | — | — | — | `support` |

### 5.2 对比度实测（相对 `paper`；`onPrimary`/`onDark` 相对 `primary`）

| 主题 | ink | muted | primary | accent | support | onPrimary | onDark | onDarkMuted | ink/soft |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| clinical | 13.85 | 5.26 | 10.67 | 4.67 | 5.24 | 11.22 | 9.64 | 7.16 | 12.26 |
| academic | 15.51 | 5.65 | 10.89 | 5.77 | 3.57 | 11.57 | 9.92 | 6.73 | 14.24 |
| trauma | 15.14 | 5.52 | 11.31 | 4.67 | 5.76 | 12.27 | 10.32 | 7.26 | 14.24 |
| archive | 15.07 | 6.35 | 13.31 | 6.32 | 6.16 | 13.44 | 11.77 | 7.54 | 13.71 |
| edu | 13.09 | 5.84 | 7.89 | 4.73 | 4.66 | 8.31 | 7.32 | 5.19 | 12.28 |
| mono | 15.63 | 5.64 | 13.75 | 5.57 | 3.33 | 14.88 | 13.49 | 8.81 | 14.54 |

### 5.3 图表系列

| 主题 | series[0] | series[1] | series[2] | 对 `paper` 对比度 | 相邻相对亮度差 |
| --- | --- | --- | --- | --- | --- |
| clinical | `12404F` | `B4552D` | `7C8B93` | 10.67 / 4.67 / 3.35 | 0.120 / 0.085 |
| academic | `1A3A5F` | `0F6E62` | `6E8CB4` | 10.89 / 5.77 / 3.25 | 0.081 / 0.132 |
| trauma | `1D3B2A` | `A55C11` | `549478` | 11.31 / 4.67 / 3.29 | 0.121 / 0.087 |
| archive | `2B2A26` | `9C3B2E` | `9A8053` | 13.31 / 6.32 / 3.48 | 0.081 / 0.125 |
| edu | `2E5643` | `A85C22` | `7C8F5E` | 7.89 / 4.73 / 3.36 | 0.085 / 0.086 |
| mono | `22282E` | `5A646E` | `7F888F` | 13.75 / 5.57 / 3.33 | 0.104 / 0.117 |

**分类图表最多 3 个系列。** 超过 3 类时：合并小类、改用直接标注、或使用图案（斜线/点阵），不得继续加色。

### 5.4 各主题设计语言

#### 临床晨光 `clinical`（默认）

- **气质：** 暖白纸面 + 深青 + 陶土，像印刷良好的门诊病历。
- **适用：** 门诊病例、出院记录、常规报告、影像报告。
- **字体：** 无衬线标题与正文；数字用等宽。
- **签名组件：** 左侧细标线、编号章节、关键值色块、**深色影像判读条**（原“月白影像”合并至此，按内容自动启用）。
- **不适用：** 多中心 Meta 分析的证据等级呈现（改用 `academic`）。

#### 青黛循证 `academic`

- **气质：** 冷白 + 藏青 + 墨绿 + 暖金，克制、学术。
- **适用：** 文献综述、Meta 分析、科研汇报、基金材料。
- **字体：** 无衬线；表格数字等宽对齐。
- **签名组件：** 藏青通栏页眉、证据等级标签（A/B/C）、编号边栏、三线表。
- **不适用：** 患者宣教（语气偏严肃）。

#### 松风急救 `trauma`

- **气质：** 灰绿纸 + 深松绿 + 琥珀，稳、快、可扫读。
- **适用：** 战创伤、急救流程、分诊、阶段处置。
- **字体：** 无衬线，正文比默认 +3%。
- **签名组件：** 时间轴轨道、阶段标签、分诊色标。
- **不适用：** 长篇文献（轨道与标签增加视觉噪音）。

#### 宣纸病案 `archive`

- **气质：** 米纸 + 墨 + 暗朱，档案感。
- **适用：** 长病例、病史整理、医疗档案、回顾性材料。
- **字体：** **衬线标题 + 衬线正文**，行距 +4%。
- **签名组件：** 印章式标记、宽留白、发丝分割线、中文序号（一、二、三）。
- **不适用：** 急救、投屏（笔画细、远看吃力）。

#### 杏林宣教 `edu`

- **气质：** 暖白 + 松绿 + 杏色，友好。
- **适用：** 患者教育、健康宣教、公众材料。
- **字体：** 无衬线，正文 +8%。
- **签名组件：** 圆角信息卡、大字号要点、图示优先。
- **不适用：** 急救流程、法律/鉴定文书。

#### 灰阶印刷 `mono`

- **气质：** 中性灰阶，只靠字重、线宽、灰度分层。
- **适用：** 黑白打印、低色准投影、其他主题不可用时的兜底。
- **字体：** 同正文角色。
- **签名组件：** 灰度阶、线型区分（实线/虚线/点线）。
- **不适用：** 彩色投屏（表现力最弱）。

### 5.5 与旧主题的关系

| 旧 ID | 处理 | 说明 |
| --- | --- | --- |
| `clinical` | **保留 ID，刷新色值** | 默认输出会变一次，需一次性重批视觉基线 |
| `academic` | **保留 ID，刷新色值** | 与旧值差异较大，属有意改版 |
| `trauma` | **保留 ID，刷新色值** | 同上 |
| `vital` | **保留为别名 → `clinical`** | 影像能力改为组件，不再单独成主题；解析时给 deprecation 提示 |
| `mono` | **保留 ID，刷新色值** | 仍只作打印兜底 |
| `clinical-legacy` | **新增隐藏主题** | 保存旧 `clinical` 色值，仅用于 A/B 对比与回退 |

---

## 6. 字体角色与规则

### 6.1 角色

| 角色 | 用途 | 说明 |
| --- | --- | --- |
| `sans` | 标题与正文（默认） | 医院 Windows 上最稳的是微软雅黑 |
| `serif` | 仅 `archive` 主题的标题与正文 | Windows 用宋体，mac 用宋体-简 |
| `mono` | 数值、检验值、编码 | HTML/CSS 用等宽栈；PPTX/DOCX 仅指定名称 |

### 6.2 各格式的字体策略

| 格式 | 做法 | 必须验证 |
| --- | --- | --- |
| **PDF** | 随包嵌入 TTF；标题与正文按 `headingRole`/`bodyRole` 选字族 | 注册成功、字形完整、子集化耗时、文件体积 |
| **HTML（文件夹交付）** | `assets/fonts/*.woff2` + `@font-face`；`unicode-range` 分片 | 断网可渲染、生僻字不豆腐、整包体积 |
| **HTML（单文件交付）** | 只用系统字体栈，不 base64 内嵌大字体 | 记录字体策略和资源模式即可，不要求在页面中加入说明文字 |
| **PPTX** | 同时写 `latin` 与 `ea` 字体名；不承诺嵌字 | 在目标 PowerPoint / LibreOffice Renderer 上目视复核 |
| **DOCX** | 写 `w:eastAsia` 字体名；不承诺嵌字 | Word / WPS 上标题与正文不回退成默认宋体 |
| **XLSX** | 只设置单元格字体名；**明确不承诺**跨软件一致 | Excel / WPS / LibreOffice 的列宽与换行 |

**离线字体预算（实测）：**

| 资源 | 体积 | 用途 |
| --- | --- | --- |
| `NotoSansSC-VF.ttf`（已有） | 17.0 MB | PDF 无衬线 |
| `NotoSerifSC-VF.ttf`（新增） | **24.0 MB**（25,125,512 B） | PDF 衬线（`archive`） |
| Noto Sans SC WOFF2 分片（400/700） | ≈ 8.6 MB（实测 4.3 MB/字重，101 片） | HTML 文件夹交付 |
| Noto Serif SC WOFF2 分片（400/700） | ≈ 6–9 MB（实测 400 字重 2.2 MB/77 片） | HTML `archive` 主题 |

### 6.3 字号与密度

主题**不定义**绝对字号，只提供三个乘数，由各技能乘到自己的字号表上：

| 参数 | 取值 | 作用 |
| --- | --- | --- |
| `bodyScale` | 0.98 / 1.0 / 1.03 / 1.08 | 正文相对缩放 |
| `lineHeightScale` | 1.0 / 1.04 | 行距相对缩放（衬线略增） |
| `headingWeight` | 700 | 标题字重 |
| `letterSpacing` | 0 / 0.02 | 标题字距（`archive` 略松） |

PPTX 仍使用现有 `typography.profiles` + `densityProfiles`；主题的乘数在其之后叠加，**不覆盖**既有 pt 值表。

---

## 7. 组件令牌（`surface`）

每套主题声明一组组件风格；各技能把字符串映射到自己的实现，**不认识的值回退到默认并告警**，不报错。

| 组件 | 可取值 | 含义 |
| --- | --- | --- |
| `masthead` | `rule-line` / `solid-band` / `hairline` / `none` | 页眉：细线 / 通栏深色块 / 发丝线 / 无 |
| `sectionMarker` | `number-accent` / `number-sidebar` / `phase-chip` / `cn-number` / `dot` / `plain` | 章节标记形式 |
| `tableHeader` | `primary-fill` / `soft-fill` / `ink-rule` / `ink-fill` | 表头：主色填充 / 浅底 / 仅墨线 / 深色填充 |
| `callout` | `left-rule-soft` / `hairline-box` / `rounded-card` | 提示块：左竖线+浅底 / 细线框 / 圆角卡 |
| `imagingPanel` | `dark-panel` / `none` | 是否提供深色影像底板 |
| `footer` | `hairline` / `none` | 页脚分隔 |

| 主题 | masthead | sectionMarker | tableHeader | callout | imagingPanel | footer |
| --- | --- | --- | --- | --- | --- | --- |
| clinical | `rule-line` | `number-accent` | `primary-fill` | `left-rule-soft` | `dark-panel` | `hairline` |
| academic | `solid-band` | `number-sidebar` | `primary-fill` | `left-rule-soft` | `none` | `hairline` |
| trauma | `rule-line` | `phase-chip` | `primary-fill` | `left-rule-soft` | `none` | `hairline` |
| archive | `hairline` | `cn-number` | `ink-rule` | `hairline-box` | `none` | `hairline` |
| edu | `none` | `dot` | `soft-fill` | `rounded-card` | `none` | `none` |
| mono | `rule-line` | `plain` | `ink-fill` | `left-rule-soft` | `dark-panel` | `hairline` |

**影像底板规则：** 底色用 `primary`，文字用 `onDark` / `onDarkMuted`，数据高亮用 `support`；只允许在“确有影像/波形/影像结论”的内容里出现，不得当装饰。

---

## 8. 版式变体（`layoutVariant`）

| 值 | 主要使用方 | 含义 |
| --- | --- | --- |
| `report` | PDF / DOCX 主题 | 封面、编号章节、图注、三线表 |
| `deck` | PPTX | 现有版面库；主题只改令牌，不改几何 |
| `page` | HTML | 推荐的页面组织方式；不强制固定区块或模板 |
| `timeline` | PPTX / HTML（trauma） | 时间轴轨道 + 阶段标签 |
| `archive` | PDF / DOCX（archive） | 宽留白、发丝线、印章、中文序号 |
| `cards` | HTML（edu） | 圆角信息卡 + 大字号要点 |
| `sheet` | XLSX | 表头 / 斑马纹 / 分组 |
| `diagram` | diagram-maker | 节点 / 连线 / 分组 |

`layoutVariant` 与 `clean`/`architecture` **不是同一层**：后者是 diagram-maker 的图形布局，继续独立保留。

---

## 9. 主题选择与推荐

优先级：**用户显式指定** > **内容与用途推断** > **`defaultTheme`**。

| 任务特征 | 推荐主题 |
| --- | --- |
| 门诊、出院、常规报告、影像报告 | `clinical` |
| 文献综述、Meta 分析、科研汇报、基金 | `academic` |
| 战创伤、急救、分诊、处置流程 | `trauma` |
| 长病例、病史整理、档案、回顾性 | `archive` |
| 患者教育、健康宣教、公众材料 | `edu` |
| 明确只需黑白打印 | `mono` |
| 无法判断 | `clinical` |

**披露：** 每次生成都要在结果和 QA 报告中写明 `本次主题：青黛循证（academic）`；推断得来时追加 `（按用途推荐）`。

---

## 10. 分档支持矩阵

| 格式 | 档位 | 颜色 | 字体角色 | 组件令牌 | 签名版式 |
| --- | --- | --- | --- | --- | --- |
| **HTML** | A 全量 | ✅ | ✅ | ✅ | ✅ |
| **PDF** | A 全量 | ✅ | ✅（嵌字） | ✅ | ✅（report / archive） |
| **PPTX** | A 全量 | ✅ | ✅（写 ea/latin） | ✅ | ⚠ 仅 2 种：`deck` 默认 + `timeline` |
| **DOCX** | B 令牌 | ✅（仅显式主题） | ✅ | ⚠ 仅表头 / 提示块 | ❌ |
| **XLSX** | B 令牌 | ✅ | ⚠ 仅请求名称 | ⚠ 仅表头 / 斑马纹 | ❌ |
| **diagram-maker** | B 令牌 | ✅ | ⚠ 仅 SVG 字体栈 | ⚠ 仅节点 / 连线 | ❌ |

**默认行为：**

- DOCX 未指定主题 → 继续 `neutral-document-v1`（黑白），**不上色**。
- XLSX、diagram-maker 未指定主题 → 输出与现在一致。
- 完成 T0 基线、改版前后对照并批准默认观感升级后，PPTX、PDF、HTML 未指定主题 → 使用刷新后的默认主题（`clinical`）；在批准前继续保持现有默认输出。

---

## 11. 各格式映射细则

### 11.1 PPTX

- 旧键映射（布局代码不改）：`paper→paper`、`white→surface`、`ink→ink`、`muted→muted`、`navy→primary`、`accent→accent`、`cyan→support`、`rule→rule`、`positive→semantic.success.fg`、`negative→semantic.danger.fg`。
- `colors.white` 历史上同时承担“浅色背景”和“深底上的白字”，因此硬约束：`surface` 必须为浅色，`primary` 必须为深色，且 `onPrimary` 对 `primary` ≥ 4.5。
- 必须把 `core.mjs` 的 9 处浅蓝灰（`C7D8E5`、`D7E2EA`、`A9BECC`、`E5EAF0`、`CAD2DC`）改为 `onDark` / `onDarkMuted` / `soft` / `rule`，否则暖色主题的深底页会发脏。
- 主题可覆盖 `typography`（新增能力）；合并顺序：`base.typography` → `profile` → `density` → `theme.typography`（只允许乘数类字段）。
- **中文必须同时写 `latin` 与 `ea`**；`cross-platform-zh` 不得再用 `Arial` 这类无中文字形的字体。

### 11.2 HTML

- 主题以 `data-pd-theme="<id>"` 挂在 `<html>` 上。
- CSS 变量：`--pd-paper`、`--pd-surface`、`--pd-ink`、`--pd-muted`、`--pd-primary`、`--pd-accent`、`--pd-support`、`--pd-rule`、`--pd-soft`、`--pd-on-primary`、`--pd-on-dark`、`--pd-on-dark-muted`、`--pd-danger`、`--pd-warning`、`--pd-success`、`--pd-info`。
- 字体：`--pd-font-body` / `--pd-font-heading` / `--pd-font-mono` 由 `fontRoles` 注入。
- 现有 A/B/C 三档继续表示**阅读距离与密度**，与颜色主题正交；选择主题不改变默认布局。
- 文件夹交付时允许 `assets/fonts/`；单文件交付时只用系统栈。字体策略写入内部 QA/生成元数据，不在页面中强制加入说明文字。
- 规则调整：原“只允许一种高饱和强调色”改为“**只允许 `primary`/`accent`/`support` 三个装饰角色，语义色固定**；同一页面不得出现主题外第四种高饱和色”。

### 11.3 PDF

- 现有 7 处色值改为令牌：`172033→ink`、`5F6B7A→muted`、`D8E0EA→rule`、`2F6FED→accent`。
- 字号角色：标题 `headingRole`、正文 `bodyRole`；`archive` 使用衬线，其余无衬线。
- 字体文件：`NotoSansSC-VF.ttf`（现有 17.0 MB）+ 新增 `NotoSerifSC-VF.ttf`（24.0 MB）。
- 表头、图注、提示块按 `surface` 渲染；页眉线用 `rule`。

### 11.4 DOCX

- `neutral-document-v1` 保持不动，作为默认。
- 新增 `themed-v1` 策略：仅在用户显式指定主题时启用。
- `themed-v1` 允许的彩色范围**只限**：标题 / 各级标题 = `primary`；正文 = `ink`；表头填充 = `primary` + `onPrimary` 文字；边框 = `rule`；提示块 = `soft` 底 + `accent` 左边线。
- 预检 / 审计：颜色值必须来自当前主题令牌，否则仍告警；不得出现任意自定义填充色。
- 修正文档与实现不一致：现文档写“中文衬线正文”，代码实际为 `Noto Sans SC`（无衬线）。以代码为准先修文档；是否改为衬线需单独评审（会影响既有用户基线）。

### 11.5 XLSX

- 表头：`primary` 填充 + `onPrimary` 文字。
- 斑马纹：`soft`；边框：`rule`；分组小计行：`soft` + 加粗。
- 图表系列：`chart.series`（最多 3 个）；网格线 `chart.grid`。
- 字体只设置名称，**不承诺**跨 Excel/WPS/LibreOffice 一致；不得宣称“与 HTML 同款”。
- `table.style.theme`（Excel 原生表格样式）继续独立，`designTheme` 不得复用该字段。

### 11.6 diagram-maker

- 颜色改由令牌派生，写死在 `render_svg()` 的 21 处色值全部移除。
- 映射：背景 `paper`；节点填充 `soft`；节点描边 `primary`；分组虚线 `rule`；连线 `muted`；标题 `ink`；**连线标签光晕 `paper`**（当前硬编码 `#f8fafc`，暖色底会出现白边）。
- `--theme` 继续表示布局（`clean`/`architecture`）；新增 `--design-theme` 表示配色。两者可任意组合。

---

## 12. 校验门禁

### 12.1 数据门禁（`scripts/check-skill-tokens.mjs`）

任一项失败即退出非 0：

1. **Schema：** 必填字段齐全；颜色为 6 位十六进制大写；未知字段只告警不失败。
2. **别名唯一：** 中文名、别名、ID 全局不得冲突；每个主题至少 1 个别名。
3. **对比度：**
   - `ink/paper` ≥ 7.0
   - `muted/paper` ≥ 4.5
   - `primary/paper` ≥ 4.5
   - `accent/paper` ≥ 4.5（列入 `textUnsafe` 时 ≥ 3.0）
   - `support/paper` ≥ 4.5（列入 `textUnsafe` 时 ≥ 3.0）
   - `onPrimary/primary` ≥ 4.5
   - `onDark/primary` ≥ 4.5
   - `onDarkMuted/primary` ≥ 4.5
   - `ink/soft` ≥ 7.0
4. **灰度：** `chart.series` 每项对 `paper` ≥ 3.0；相邻相对亮度差 ≥ 0.05；`|L(paper) − L(soft)|` ≥ 0.03。
5. **语义锁定：** 主题不得定义 `danger/warning/success/info`；语义色对 `paper` ≥ 4.5。
6. **完整性：** 6 套对外主题全部存在（`clinical-legacy` 不计入对外集合，但必须可解析）；`defaultTheme` 必须存在且 `status=stable`；`vital` 别名可解析。

### 12.2 渲染门禁

| 检查 | 方法 | 判定 |
| --- | --- | --- |
| 主题可解析 | CLI `themes --json`，用 ID / 中文名 / 别名各取一次 | 三次结果完全一致 |
| 默认观感 | T0 保存旧基线；批准后固定样本再次生成 | 只有完成改版前后对照并批准后，才切换默认主题；旧基线由 `clinical-legacy` 复现 |
| 字体确定性 | 检查 PPTX XML 的 `a:latin` 与 `a:ea` | 两者均为真实中文字体，不为 `Arial` |
| 溢出 | PPTX 文字框 / PDF 跨页表格；HTML 只做静态资源和结构检查 | Office/PDF 渲染结果无截断、无重叠、无空白页；HTML 静态检查不得冒充浏览器布局结论 |
| 灰度 | 有可靠渲染环境时对 Office/PDF 样张抽检；HTML 仅在本地人工检查时可选 | 标题、正文、表格、图表仍可区分；不作为医院服务器上的自动门禁 |
| 色盲 | deuteranopia 模拟 | 语义不依赖色相；异常项有文字/符号 |
| 离线 | 抓取生成过程的外链请求 | 0 个外部 `http(s)` 资源 |

### 12.3 失败与降级记录

- 主题不存在：`未知主题「XX」，可用：临床晨光（clinical）、青黛循证（academic）……`
- HTML 未部署浏览器时：内部 QA 记录 `visual_acceptance=not_performed`；默认用户回复不输出固定免责声明，只有用户要求视觉验收、追问或已发现具体问题时再说明限制。
- 字体缺失：`未找到衬线字体，已按无衬线降级；本次主题：宣纸病案（降级）`

---

## 13. 验收用例（最小集）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| U1 六主题 × HTML | 同一份病例内容 | 6 个单 HTML 或文件夹产物；令牌与可选签名组件符合主题；无外链；不要求固定模板或像素一致 |
| U2 六主题 × PPTX | 同一份 8 页大纲 | 无溢出；`ea` 字体正确；深底页文字对比达标 |
| U3 六主题 × PDF | 同一份 6 页报告 | 字体嵌入；`archive` 为衬线；表格跨页正常 |
| U4 DOCX 默认 | 不指定主题 | 与 `neutral-document-v1` 一致（黑白） |
| U5 DOCX 指定主题 | `--design-theme academic` | 仅标题/表头/提示块着色，其余中性 |
| U6 XLSX | 指定主题 + 原生图表 | 表头/斑马纹/系列色正确；公式值不变 |
| U7 图示 | `--theme architecture --design-theme archive` | 布局不变，配色变；连线标签无白边 |
| U8 别名 | `--theme 宣纸`、`--theme archive`、`--theme 病案` | 三者产物一致 |
| U9 `vital` | 旧参数 | 解析为 `clinical`，返回 deprecation 提示，不报错 |
| U10 缺字体 | 临时移除衬线字体 | 内部记录明确降级，不崩溃；不要求每份用户页面显示降级文案 |

---

## 14. 待实测（实现前必须补数据）

1. ReportLab 能否稳定注册 24 MB 的可变衬线字体，以及生成 20 页 PDF 的耗时与体积增量。
2. 远程 Office Renderer（LibreOffice）对 `archive` 衬线主题的实际替换结果。
3. Word / WPS 打开 `themed-v1` 文档时，表头填充与标题色是否保持一致。
4. Excel / WPS / LibreOffice 三端对 `chart.series` 的呈现差异。
5. HTML 文件夹交付带 15 MB 字体时，页面首屏加载时间与内存占用。
6. 6 套主题在真实病例长文本（8000 字以上）下的分页与留白表现。


