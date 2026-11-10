# 统一 QA 协议 v1

目标：DOCX / PPTX / XLSX / PDF / HTML / 图示共用一套**记录形状**与**状态机**，
但不替换各技能已有的交付命令和报告。新报告是附加层，旧记录继续可读。

## 三个记录

| 文件 | schema | 作用 |
| --- | --- | --- |
| `acceptance.json` | `pilotdeck-qa-acceptance/v1` | 冻结本次用户要求：必含文本、标题、页数、图片、表格、主题、交付范围 |
| `review.json` | `pilotdeck-qa-review/v1` | 逐页矩阵：页码、状态、截图路径与哈希、备注；必须绑定产物 SHA-256 |
| `qa-report.json` | `pilotdeck-qa-report/v1` | 汇总：产物/验收/评审哈希、四类检查状态、问题、缺项、耗时、最终状态 |

样例见 `samples/`，形状定义见 `qa-protocol.schema.json`。

## 状态机

```
acceptance 冻结
      │
      ▼
structural 检查 ──failed──▶ failed（修复后重跑）
      │passed
      ▼
visual 评审 ──failed──────▶ failed（修复后重跑）
      │passed / not_performed / 无评审
      ▼
assets 完整？ ──missing──▶ delivered_with_missing_assets
      │complete
      ▼
content 检查 + 无未处置 warning ──▶ passed
content 未通过 / visual 未做 / 有 warning ──▶ passed_with_warnings
```

硬规则：

1. `passed` 必须同时满足 `structural=passed`、`content=passed`、`visual=passed`，且无 error/warning。
2. `visual=passed` 要求评审矩阵覆盖**每一页**且全部 `passed`；有任何一页 `not_performed` 只能得到 `passed_with_warnings`。
3. 评审绑定的 `artifactSha256` 与当前产物不一致 → `review-artifact-mismatch`，旧评审作废。
4. 页码必须 1..pageCount 连续且唯一；缺页 → `review-incomplete`。
5. 缺图/缺资源 → `delivered_with_missing_assets`，必须列出 `missingAssets`；不得写成 `passed`。
6. 没有评审文件时 `visual=not_performed`，报告最多 `passed_with_warnings`。
7. `visual=passed` 必须有证据：要么是 `--review` 页矩阵，要么是技能自己的评审门留下、
   经适配器带入的 `visualEvidence`（含 `source`、`pagesReviewed`、绑定的 `artifactSha256`）。
   两者都没有 → `visual-evidence-missing`；`passed` 报告缺证据 → `report-evidence-missing`。

## 兼容策略

- DOCX 继续用它的 `acceptance.json` / preflight；PPTX 继续写 `delivery.json`；XLSX、PDF、HTML 保留现有报告。
- 适配器（T3a.2）把旧报告映射成这里的 `checks` / `issues`，不修改旧文件。
- 本协议**不**规定渲染方式：HTML 与无渲染环境一律 `visual=not_performed`。
- 时间与路径只做记录，不参与通过判定；同一产物换主题视为不同基线。

## 命令

```bash
python3 skills/_shared/qa/qa_protocol.py validate-acceptance acceptance.json
python3 skills/_shared/qa/qa_protocol.py validate-review review.json --artifact out.docx
python3 skills/_shared/qa/qa_protocol.py build \
  --skill docx --artifact out.docx --acceptance acceptance.json \
  --review review.json --checks checks.json --out qa-report.json
python3 skills/_shared/qa/qa_protocol.py validate-report qa-report.json
```

## 适配器（T3a.2）

适配器只**读**旧报告，生成一份新的 `qa-report.json`；旧命令、旧报告的字段和落盘位置都不变。

```bash
# DOCX：preflight 的 --report 产物
python3 skills/_shared/qa/adapters/adapt.py docx \
  --report <work>/docx/qa/preflight-final.json --artifact exports/病例报告.docx \
  --out <work>/docx/qa/qa-report.json

# PPTX：deliver 在 --qa-dir 下写的 delivery.json
python3 skills/_shared/qa/adapters/adapt.py pptx \
  --report <work>/pptx/qa/delivery.json --artifact exports/综述.pptx

# XLSX：deliver / audit 的 --report 产物
python3 skills/_shared/qa/adapters/adapt.py xlsx \
  --report <work>/xlsx/deliver-report.json --artifact exports/随访表.xlsx

# XLSX：make 不写 --report，如需适配先把标准输出存成文件
bash skills/spreadsheets/scripts/spreadsheet.sh make ... --out book.xlsx > <work>/xlsx/make-report.json

# PDF：deliver 的 --report 产物
python3 skills/_shared/qa/adapters/adapt.py pdf \
  --report <work>/pdf/qa/delivery.json --artifact exports/病例报告.pdf

# HTML：先做静态审计（带用户要求），再打包；两种报告都能适配
bash skills/frontend-slides/scripts/html.sh audit exports/报告.html \
  --require-text "建议两周后复诊" --out <work>/frontend-slides/qa/audit.json
python3 skills/_shared/qa/adapters/adapt.py html \
  --report <work>/frontend-slides/qa/audit.json --artifact exports/报告.html
bash skills/frontend-slides/scripts/html.sh package --html exports/报告.html \
  --report <work>/frontend-slides/qa/package.json
python3 skills/_shared/qa/adapters/adapt.py html \
  --report <work>/frontend-slides/qa/package.json --artifact <交付目录>/index.html

# 图示：几何审计（不需要浏览器）
bash skills/diagram-maker/scripts/diagram.sh audit --input exports/流程图.svg \
  --report <work>/diagram/qa/audit.json
python3 skills/_shared/qa/adapters/adapt.py diagram \
  --report <work>/diagram/qa/audit.json --artifact exports/流程图.svg

# 有逐页/逐张评审时加上 --review；页码必须与产物页数一致
... --review <work>/qa/review.json
```

未给 `--acceptance` 时，适配器把旧报告里**已经执行过的要求**回读成 `acceptance.derived.json`
（`derivedFrom.report` 记录来源），不让人手抄一遍。

`adapt.py html` 会按报告结构自动区分 `audit` / `package`，需要时可显式加 `--kind`；
HTML 与图示的 `acceptance` **不**回填产物自身的内容（避免把产物当成要求），
`derivedFrom.note` 会写明这一点。

### 映射规则

| 旧报告 | `structural` | `content` | `visual` | `assets` |
| --- | --- | --- | --- | --- |
| DOCX preflight | 包校验通过且无覆盖类错误 → `passed`；`package_validation` 非 `passed`、其余错误、产物哈希变了 → `failed` | `coverage.status` / `text_coverage` | `visual_review.status`：`not-reviewed` → `not_performed` | 图片数低于要求 → `missing` |
| DOCX preflight（Renderer 不可用） | 同上，结构检查继续有效 | `coverage.status=not_checked` 且 `text_coverage=not_checked` → `not_checked`；仍缺必含标题/目录 → `failed` | `not_performed`，并带 `render-unavailable` 警告 | 同上 |
| PPTX delivery | 完整性、交付门（除 `coverage_required`）、审计 error、渲染失败、产物哈希变了 → `failed` | `audit.coverage.status` | 恒为 `not_performed`（`delivery.json` 只记录“渲染成功”，不记录逐页评审） | `complete` |
| XLSX report | 公式/包/结构类 `hardFailures`、空白打印页、产物哈希变了 → `failed` | `coverage.status` 与 `requirement_not_met` | 恒为 `not_performed` | `complete` |
| PDF delivery | 审计硬失败、交付门错误、渲染失败、产物哈希变了 → `failed` | `coverage.status`（文本/页数要求） | `visualReview.status`；`deliver` 已带评审时随报告一并转成 `visualEvidence` | `complete` |
| HTML audit | 除缺资源外的 error（外链、重复 id、未闭合标签、`file:`/绝对路径…）→ `failed`；缺图不算结构失败 | `--require-text`/`--require-heading` 全命中 → `passed`，有未命中 → `failed`，没给要求 → `not_checked` | 恒 `not_performed`（不做服务端渲染） | 缺图 → `missing` |
| HTML package | `blocked` 或资源无法解码 → `failed` | 不判定（`not_checked`） | 恒 `not_performed` | 缺图 → `missing`，并保留是否已占位 |
| 图示 audit | 节点越出画布、脚本/外链、成品文案与来源不一致（`label-not-rendered`）→ `failed` | 文案被三行上限截断 → `failed`；只给 `--input`、没给原始输入 → `not_checked` | 恒 `not_performed` | `complete` |

固定语义：

1. **渲染成功不等于视觉通过。** 没有 `--review` 时，即使 Office Renderer 出了图，报告最多 `passed_with_warnings`。
2. **旧判失败不会被升级。** DOCX 的 `visual_review.status=failed` 保持 `failed`，新评审不能把它改成 `passed`。
3. **产物变了就作废。** 报告记录的 SHA-256 与当前文件不一致 → `artifact-changed-since-*`，`structural=failed`。
4. **技能自己的评审门也算证据。** DOCX/PDF 的旧评审门若已绑定产物哈希并覆盖每一页，
   适配器把 `pagesReviewed` 与 `artifactSha256` 带进 `visualEvidence`，不必让评审者再填一遍；
   没有这层记录时，`visual=passed` 一律被拒绝。
5. **HTML 与图示没有服务端渲染。** 两种格式的 `visual` 恒为 `not_performed`，`passed` 不可达；
   静态审计只证明内容在、资源可搬、几何不越界，不证明排版好看。
6. **渲染不可用不是文档缺陷。** DOCX `preflight` 在 Renderer 掉线时仍写报告（`render=skipped`），
   HTML/图示本来就无渲染；这几种情况都只能到 `passed_with_warnings`，且必须保留原因（`render-unavailable`）。

退出码：`passed` / `passed_with_warnings` / `delivered_with_missing_assets` 为 0，`failed` 为 1。

测试：`tests/skills/qa-adapters.test.mjs` 会用三个技能的真实 `make` / `preflight` / `deliver` / `audit`
产出报告再适配；本机缺少对应运行时（或 Office Renderer 不可达）时自动跳过并说明原因。
