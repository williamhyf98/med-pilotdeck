# 创建与受控编辑表格

Agent 只填写 `spreadsheet.sh make` 参数；不要编写 JavaScript 或 Python。

## Markdown

只接受 GitHub 风格管道表：

```markdown
| 阶段 | 负责人 | 状态 |
| --- | --- | --- |
| 一级 | 张医生 | 完成 |
| 二级 | 李医生 | 进行中 |
```

Markdown 只适合一张简单表。公式、图表和多个工作表使用 JSON spec。

## 新建 XLSX spec

```json
{
  "title": "救治统计",
  "sheets": [
    {
      "name": "汇总",
      "headers": ["阶段", "人数", "完成数", "完成率", "状态"],
      "rows": [
        ["一级", 10, 8, {"formula": "C2/B2"}, "正常"],
        ["二级", 12, 9, {"formula": "C3/B3"}, "关注"]
      ],
      "numberFormats": [
        {"range": "D2:D3", "format": "0.0%"}
      ],
      "table": {"name": "CareSummary", "range": "A1:E3"},
      "validations": [
        {"range": "E2:E3", "values": ["正常", "关注", "风险"]}
      ],
      "conditionalFormatting": [
        {
          "range": "D2:D3",
          "rules": [
            {
              "type": "cellIs",
              "operator": "lessThan",
              "formulae": [0.8],
              "style": {"font": {"color": {"argb": "FFB91C1C"}}}
            }
          ]
        }
      ],
      "charts": [
        {
          "type": "column",
          "title": "救治人数",
          "categories": "A2:A3",
          "series": [{"name": "人数", "values": "B2:B3"}],
          "anchor": {"from": "G2", "to": "N16"}
        }
      ]
    }
  ]
}
```

## sheet 字段

- `name`：工作表名，最长 31 字符。
- `create`：编辑已有文件时，新建工作表必须为 `true`。
- `headers` / `rows`：新建工作表数据。
- `cells`：受控单元格赋值，格式为
  `{"cell":"B4","value":123}`。
- `formulas`：`{"cell":"D4","formula":"C4/B4"}`。
- `numberFormats`：`{"range":"B2:B20","format":"#,##0"}`。
- `table` 或 `tables`：原生 Excel 表格对象。
- `validations`：列表验证。
- `conditionalFormatting`：使用已文档化的 ExcelJS 规则。
- `charts`：原生 `line`、`column`、`bar` 图表。
- `images`：浮动图片（类似 Excel「插入 → 图片」），仅新建工作簿。
- `columns`：`{"column":"A","width":20}`。
- `freeze`：`{"rows":1,"columns":0}`。

## 插入用户上传的图片

在 sheet 上放浮动图（不塞进单元格二进制）：

```json
{
  "name": "汇总",
  "headers": ["阶段", "人数"],
  "rows": [["一级", 10]],
  "images": [
    {
      "path": "/abs/path/to/workspaces/.../inbox/<batch>/1-wound.jpg",
      "anchor": "G2",
      "width": 400,
      "height": 300
    }
  ]
}
```

- 路径优先用附件列表里的 **`$WS/inbox/...` 绝对路径**；相对路径相对 `--spec` 目录。
- 禁止 `http://` / `https://`。
- `anchor`：单元格如 `"G2"`，或 `{ "from": "G2" }` / `{ "col": 6, "row": 1 }`（0-based）。
- `width` / `height`：像素；未给 `height` 时按 3:4 估算。
- 仅支持**新建**工作簿；`make --input` 编辑既有文件时不要使用 `images`（既有 Drawing 包风险）。
- 图表仍用 `charts`；不要用图片冒充图表。

单元格值可以是字符串、数字、布尔值、null，或：

```json
{"formula": "SUM(B2:B10)"}
```

```json
{"date": "2026-08-21"}
```

## 修改已有 XLSX

```json
{
  "sheets": [
    {
      "name": "汇总",
      "cells": [
        {"cell": "A1", "value": "修改后的标题"},
        {"cell": "B4", "value": 125}
      ],
      "formulas": [
        {"cell": "D4", "formula": "C4/B4"}
      ]
    }
  ]
}
```

调用：

```bash
bash "$SHEET" make \
  --input "$INPUT_XLSX" \
  --spec "$PILOTDECK_WORK_DIR/spreadsheets/edits.json" \
  --out "$PWD/exports/修改后.xlsx"
```

不覆盖输入文件。已有工作表禁止 `headers` / `rows`，避免整表误重建。

## 公式安全

- 使用英文函数名，省略开头 `=`。
- 使用有界区域，例如 `B2:B5000`，不要 `B:B`。
- 阻断外部工作簿引用、`WEBSERVICE`、`FILTERXML`、`RTD` 和远程
  `HYPERLINK`。
- 不支持宏、数据模型、Power Query、CUBE、外部连接或动态数组保证。
- 无 LibreOffice 时不伪造缓存结果；Excel 打开后按 full calculation 重算。

## 字体与离线校验

新建工作簿默认声明捆绑 Noto Sans SC。`make` 总会完成结构、公式引用、日期、
原生图表与需求覆盖审计。LibreOffice 重算和页面 PNG 仅在后端本来存在时
运行；缺失时返回 warning，不安装系统软件。
