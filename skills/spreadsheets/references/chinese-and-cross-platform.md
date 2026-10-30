# 中文与跨平台工作簿

## 默认行为

当用户未指定语言或目标平台时，将中文和英文视为同等重要的内容，并使用 `cross-platform` 配置。不要在该配置中强制使用仅限某平台的字体名；让 Excel 选择其原生东亚回退。LibreOffice 工作流会暴露已安装的系统字体，使中文在重新计算和渲染期间保持可见。

在填充并设置工作表样式之后使用 `helpers.applyChineseTypography`：

```js
helpers.applyChineseTypography(sheet, {
  platform: "cross-platform",
  bodySize: 10.5,
  titleSize: 16,
  titleRanges: ["A1:H1"],
});
```

支持的配置：

- `cross-platform`：让字族由主题驱动；默认使用此项。
- `windows`：Microsoft YaHei。
- `macos`：PingFang SC。
- `linux`：Noto Sans CJK SC；仅当部署提供该字体时使用。

XLSX 不能可靠地嵌入字体。不要承诺 Excel for Windows、Excel for macOS 和 LibreOffice 之间像素级一致的排版。硬性要求是完整的字形覆盖、可读文本且无裁切。当渲染输出仍然正确时，字体替换是警告。

## 字号与间距基线

- 正文和普通表格单元格：10.5–11 pt。
- 表头：11–12 pt，加粗。
- 章节标题：12–14 pt。
- 工作表标题：16–18 pt。
- 避免使正文实际小于 9 pt 的打印缩放。

使用 `helpers.autoFitColumns`；它将汉字和全角标点视为双倍宽度。当存在换行中文文本时，在设置列宽后使用 `helpers.autoFitRows`。先加宽列，再创建深度换行的行。

## 中文数据约定

- 保持值为数值。应用 `¥#,##0`、`¥#,##0.00` 或其他所要求的格式，而不是把 `¥` 写入单元格值。
- 将百分比保持为小数，并用 `0.0%` 或所需精度设置格式。
- 保持日期为类型化值。使用如 `yyyy-mm-dd` 这样的不变格式代码；仅当能改善所要求的呈现时，才使用如 `yyyy"年"m"月"d"日"` 这样的中文显示。
- 不要通过改变底层类型把值转换成 `万` 或 `亿`。使用由公式支撑的辅助值，或清晰标注的单位列。
- 在公式中为中文工作表名称加引号，例如 `'输入数据'!B2`。
- 将电话号码、身份号码、账号、邮政编码和带前导零的标识符保留为文本。

## 中文 CSV 和 TSV

运行时会检测 UTF-8、UTF-8 BOM、GBK 和 GB18030 输入。当检测不明确时使用 `--encoding`。新的 CSV/TSV 导出默认为带 BOM 的 UTF-8，以兼容 Excel；仅在需要时用 `--encoding utf8`、`gbk` 或 `gb18030` 覆盖。

## 质量检查

对于中文或双语工作簿：

1. 在 LibreOffice 重新计算之后检查有代表性的中文单元格。
2. 审阅 `cjk_font_fallback` 警告。
3. 渲染每一张工作表，并核验中文标题、表头、图表标题、坐标轴、图例以及月份/类别标签。
4. 将缺失字形、替换方块、空白中文标签和被裁切的汉字视为硬失败。
5. 当事关保障时，在用户目标平台上的 Microsoft Excel 中额外做冒烟测试。
