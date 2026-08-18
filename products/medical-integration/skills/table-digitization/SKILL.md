---
name: table-digitization
description: 将医疗表格图像转为可核对的结构化表格，并生成防公式注入 CSV。
---

# 表格电子化

1. PilotDeck 负责调用视觉模型，要求只转写可见内容，不补全缺失值。
2. 将模型原始输出传给 `medical_sidecar_normalize_table`，优先 JSON，回退 Markdown/HTML。
3. 检查列数、行数、单位、合并单元格和空值；保留 warnings 与原始格式。
4. 对临床关键数字逐格人工抽查，任何自动规范化都不得改变数值或单位。
5. 导出时调用 `medical_sidecar_safe_csv`，对 `= + - @`、制表符和回车开头的单元格加安全前缀。
6. 表格编辑和版本持久化不属于当前 sidecar；由受认证、带所有权和乐观锁的存储层负责。

