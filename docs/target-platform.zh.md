# 目标平台复验：医院 Linux + Office Renderer（T4.5）

> 目标平台：**医院内网 Linux 服务器 + Office Renderer（LibreOffice）+ 浏览器预览**。
> 本文只写**实测到的结论**和**部署侧要做的配置**，不含推测。
> 复验入口：`node scripts/platform-preflight.mjs --json`

## 1. 为什么单独有这一份

HTML 和 PDF 是"文件自带一切"：PDF 嵌字体、HTML 用系统字体栈。但 **DOCX / PPTX / XLSX
只写字体名字，不嵌字体**——最终长什么样由打开它的机器决定。离线部署里这一步最容易
出现"文件能打开、排版变了、中文变日文字形"，而生成阶段完全看不出来。

## 2. 现在写的是什么字体名（2026-11-10 起）

Generator 一侧已改为"写目标机一定有的名字"：

| 技能 | 现在写的名字 | 理由 |
| --- | --- | --- |
| PPTX（所有主题） | `Microsoft YaHei`；`archive` 用 `SimSun` | Windows 自带；Office for Mac 在 app 内自带 `msyh.ttc` / `Simsun.ttc` |
| DOCX（默认） | `Microsoft YaHei`；`archive` 用 `SimSun` | 同上（此前会按生成机平台写 PingFang / 随包 Noto，换机就变样） |
| XLSX（`cross-platform`） | `Microsoft YaHei`；`archive` 用 `SimSun` | 同上；显式 `--font-platform linux` 仍可写 Noto |
| PDF | 随包 `NotoSansSC-VF.ttf` / `NotoSerifSC-Regular.ttf`（嵌入） | 与目标机字体无关 |

**已验证（本机 macOS + PowerPoint）：** `archive` 的 PPTX 由 `SimSun` 渲染，导出的 PDF
里实际字体就是 `SimSun`，衬线真实生效；此前写 `Noto Serif CJK SC` 时同一份封面被替换
成 `Microsoft YaHei`（黑体），衬线丢失。DOCX `--design-theme archive` 的
`w:eastAsia` 也已切到 `SimSun`。

**未验证：** 上面这套新名字在 LibreOffice Renderer 上的解析结果——离线渲染器当前不可用，
下次联通后需重跑第 3.3 节的自检与 `pdffonts` 复核。按第 3.2 节的别名配置，预期
`Microsoft YaHei → Noto Sans CJK SC`、`SimSun → Noto Serif CJK SC`。

## 2.1 旧名字的实测（2026-11-09，保留作对照）

环境：Office Renderer（node12 上的 LibreOffice，`11-09` 批次）；方法：生成文件 →
渲染成 PDF → `pdffonts` 读实际使用字体。

| 技能 | 文件里写的字体 | 渲染后实际字体 | 判断 |
| --- | --- | --- | --- |
| DOCX（默认） | `Noto Sans SC`（`w:eastAsia`） | `NotoSansCJKjp-Regular` | ⚠ 日文字形，简体字可能笔画不同 |
| PPTX（默认） | `Noto Sans SC`（`typeface`） | `NotoSansCJKjp-Regular` | ⚠ 同上 |
| XLSX `archive` | `SimSun`（衬线意图） | `NotoSansCJKjp-Regular` | ⚠ 日文字形 **且衬线丢失**（变无衬线） |
| PDF | 随包 `NotoSansSC-VF.ttf` / `NotoSerifSC-Regular.ttf` | 嵌入 `NotoSansSC` / `NotoSerifSC` | ✅ 与目标机字体无关 |

对照组（Debian 12 容器，只装 `fontconfig`、不装任何中文字体）：

| 请求 | 解析结果 |
| --- | --- |
| `Noto Sans SC` | `DejaVu Sans` |
| `Microsoft YaHei` | `DejaVu Sans` |
| `SimSun` | `DejaVu Serif` |
| `Consolas` | `DejaVu Sans Mono` |

即：**没装中文字体时中文会显示成豆腐块**，不是"难看"，是不可读。

> 说明：`NotoSansCJKjp` 里的简体字仍能显示，多数常用字与简体一致，但「直/值/骨/每/说」
> 一类字在日文与简体下字形不同，医疗文书里属于应避免的观感问题。

## 3. 部署侧要做的三件事

### 3.1 装中文字体

```bash
# Debian / Ubuntu
apt-get install -y fonts-noto-cjk fonts-noto-cjk-extra fonts-dejavu-core
fc-cache -f
```

### 3.2 让简体中文优先（关键）

`fonts-noto-cjk` 是 JP/KR/SC/TC 合一的 OTC，fontconfig 在 `LANG` 未指定中文时默认
挑 **JP**。二选一：

```bash
# 方案 A：进程语言环境
export LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8
```

```xml
<!-- 方案 B：/etc/fonts/conf.d/99-pilotdeck-cjk.conf -->
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="same"><family>Noto Sans SC</family>
    <prefer><family>Noto Sans CJK SC</family></prefer></alias>
  <alias binding="same"><family>Microsoft YaHei</family>
    <prefer><family>Noto Sans CJK SC</family></prefer></alias>
  <alias binding="same"><family>SimSun</family>
    <prefer><family>Noto Serif CJK SC</family></prefer></alias>
</fontconfig>
```

这两条别名现在是**必须**的：生成端写的是 `Microsoft YaHei` / `SimSun`，而 Linux 服务器上
通常只装了 Noto。别名把这两个"Office 名字"指到 Noto，服务器渲染与医生本机渲染才会接近。
不配别名时，LibreOffice 会按自己的默认顺序回落（常见是 JP 变体或 DejaVu）。

### 3.3 自检

```bash
node scripts/platform-preflight.mjs                       # 人读
node scripts/platform-preflight.mjs --json                # 机器读
node scripts/platform-preflight.mjs --renderer http://<renderer>:19400
```

输出三档结论与退出码：

| status | 退出码 | 含义 |
| --- | --- | --- |
| `ok` | 0 | 字体、运行时、渲染器都正常 |
| `warning` | 0 | 可以跑，但有需要解释的替换（送检报告里要写明） |
| `error` | 2 | 缺 python3 / node，或渲染器配了但不可达；此时渲染类验收会被跳过，**不能当作通过** |

字体判定共五类：

| code | 含义 |
| --- | --- |
| `font-exact` | 名字完全命中 |
| `font-substituted` | 换成了同风格的简体字面（可接受） |
| `cjk-variant-mismatch` | 换成了 JP/TC/KR 字形（要修） |
| `serif-lost` | 需要衬线却拿到无衬线（要修） |
| `no-cjk-face` / `fontconfig-missing` | 没有中文字体 / 无法判断（要修） |

## 4. 溢出、跨页、图片的现状

| 场景 | 已有能力 | 证据 |
| --- | --- | --- |
| PPTX 文字溢出 | `audit` 返回 `textFitRisks`、`overlaps`；新版式超长文案靠 `fit: shrink` | T4.3 三页样张审计 0 错误 0 重叠 |
| PDF 长表跨页 | 原生 `LongTable` + `repeatRows=1`，60 行表跨 2 页且第 2 页重复表头 | `tests/skills/pdf-theme.test.mjs` |
| PDF 图注/图片 | 透明图按 `paper` 合成，避免浅色纸面出现白框 | T4.2 |
| DOCX 缺图 | `delivered_with_missing_assets`，不阻断交付但明确记录 | 能力矩阵 §3 |
| XLSX 图表裁切 | 浮动对象按页边裁切，不缩放；锚点默认 `G2:N18` 会超出 A4 纵向 | 能力矩阵 §4 第 11 条 |
| HTML 窄屏 | 仅静态预算（`data-pd-block` 估算），无浏览器渲染 | `references/themes.md` |

## 5. 仍然只能在现场闭环的部分

- 医院机器**实际装了哪些字体**、`LANG` 是什么 → 现场跑 `platform-preflight.mjs`。
- 医院浏览器版本对 HTML 的渲染 → 用户回传截图后按区块修正（技能侧不做服务端截图）。
- 真实 PowerPoint / WPS 与 LibreOffice 的版式差异 → 需要在目标机打开一次样张。

这三项不是实现缺口，是"离线调研替代不了现场确认"的边界；本文档提供了让现场 5 分钟自证的脚本。
