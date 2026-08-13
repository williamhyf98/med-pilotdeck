# 救治研判演示数据包

「救治研判」读取本目录：`useEvalCompareData` → `index.json`。

目录名保留 `compare_eval_demo10`（历史命名），现仅服务研判案例加载，不再用于模型对比。

## 当前内容

- **演示案例**：`wse_0820`、`wse_0771`（各含 2 个分级场景）
- **索引**：`index.json` / `cases_preview.json`
- **案例包**：`cases/*.json`（含 `stage_samples`、`reference_gt`、`image_finding`）
- **影像**：优先引用 `/war_trauma/eval/...`（需本机挂载或软链）

## 路径约定

```text
compare_eval_demo10/
  index.json
  cases_preview.json
  cases/<case_id>.json
  jsonl/   # 可选辅助数据
```

前端入口：

`/data/compare_eval_demo10/index.json`
