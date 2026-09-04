# RAG Query Suite v1 Report

Date: 2026-08-26

## Scope

- Page quality regression set: `plugins/med-tools/quality/quality-suite-v1.jsonl`
- RAG query suite: `plugins/med-tools/quality/rag-query-suite-v1.jsonl`
- Active manifest: `/slow_share/jiangzhenming/med-pilotdeck-rag/bundles/hard-suite-text-image-v2/manifest.json`
- Corpus: `military-medicine-hard-suite-text-image`
- Version: `2.0.0`
- Rows: 63
- Bundled images: 36
- Embedding model: `qwen3-vl-embedding`

## Run

Command:

```bash
PILOT_HOME=/home/jiangzhenming/projects/med-pilotdeck/.pilotdeck-home \
plugins/med-tools/.venv/bin/python \
plugins/med-tools/quality/run_rag_query_suite.py \
  --suite plugins/med-tools/quality/rag-query-suite-v1.jsonl \
  --out plugins/med-tools/quality/rag-query-suite-v1-results.jsonl \
  --top-k 5 \
  --min-score 0.0
```

## Summary

- Total cases: 24
- Ready responses: 24
- Full expected-term coverage: 24
- Required-image cases: 8
- Required-image top1 hit: 8
- No-image expected cases: 8
- No-image display clean: 8
- Optional-image cases: 8
- Image display policy: only images attached to rank-1 evidence are shown by default.

## Case Results

| id | topic | top section | term recall | display images | top1 images | top score | note |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| rq-001 | chemical-dust-agent | 粉毒剂 | 3/3 | 1 | 1 | 0.665 | Pass: text and image hit. |
| rq-002 | thickened-agent | 稠毒剂 | 3/3 | 1 | 1 | 0.671 | Pass. |
| rq-003 | nerve-agent-treatment | 神经毒剂的常规治疗 | 3/3 | 1 | 1 | 0.724 | Pass. |
| rq-004 | cs-agent | 作用 | 3/3 | 1 | 1 | 0.745 | Pass. |
| rq-005 | plague | 历史 | 4/4 | 0 | 0 | 0.852 | Pass: text-only top evidence remains image-free. |
| rq-006 | nuclear-emergency | （一）战时核应急医学救护的基本任务 | 3/3 | 0 | 0 | 0.917 | Pass. |
| rq-007 | pelvic-fracture | 6.骨盆骨折 | 3/3 | 4 | 4 | 0.771 | Pass: image-heavy page. |
| rq-008 | tourniquet | 使用标准止血带 | 3/3 | 4 | 4 | 0.829 | Pass: image-heavy page. |
| rq-009 | needle-syringe | 安装针头和针管 | 3/3 | 1 | 1 | 0.809 | Pass. |
| rq-010 | airway-obstruction | 机械阻塞 | 3/3 | 1 | 1 | 0.817 | Pass. |
| rq-011 | hemostatic-agent | 局部止血剂 | 3/3 | 0 | 0 | 0.790 | Pass: lower-rank images are not displayed. |
| rq-012 | pneumatic-anti-shock-garment | 禁忌证 | 3/3 | 0 | 0 | 0.821 | Pass: top-k evidence covers controversy, use in hemorrhagic shock, and contraindications. |
| rq-013 | biological-weapons-history |  | 3/3 | 0 | 0 | 0.767 | Pass. |
| rq-014 | influenza | 流行性感冒病毒（以下简称“流感病毒”) | 3/3 | 1 | 1 | 0.846 | Pass. |
| rq-015 | kinetic-energy-trauma |  | 3/3 | 1 | 1 | 0.774 | Pass. |
| rq-016 | energy-transfer-trauma | （）坚硬物体与人体之间的能量交换 | 3/3 | 1 | 1 | 0.834 | Pass. |
| rq-017 | endotracheal-intubation |  | 3/3 | 3 | 3 | 0.862 | Pass. |
| rq-018 | pressure-bandage |  | 3/3 | 5 | 5 | 0.813 | Pass. |
| rq-019 | prone-patient-immobilization |  | 3/3 | 2 | 2 | 0.849 | Pass. |
| rq-020 | plutonium-toxicology | 2.环 | 3/3 | 0 | 0 | 0.850 | Pass. |
| rq-021 | radium-toxicology | 3.镭 | 3/3 | 0 | 0 | 0.719 | Pass. |
| rq-022 | cyanide-methemoglobin | 1.高铁血红蛋白形成剂 | 3/3 | 0 | 0 | 0.862 | Pass. |
| rq-023 | biological-line-source-contamination | （二）生物战剂线源施放的污染区划定 | 3/3 | 3 | 3 | 0.827 | Pass. |
| rq-024 | trauma-prevention | 事件发生阶段 | 3/3 | 2 | 2 | 0.745 | Pass. |

## Findings

1. The minimal text + image RAG loop is now testable from a 24-case fixed query suite.
2. Required image retrieval works for all eight image-required questions.
3. Image presentation is now restricted to rank-1 evidence by default. This prevents lower-ranked evidence images from leaking into otherwise text-only answers.
4. Multi-aspect retrieval is adequate for this fixed suite when section titles are included in the evaluation surface. `rq-012` has all expected terms across top-k evidence.

## Next Actions

1. Keep `rag-query-suite-v1.jsonl` and `quality-suite-v1.jsonl` as regression sets.
2. Before full five-book ingestion, use `five-books-ingestion-dry-run.md` to confirm disk location and expected runtime.
3. For future UI work, consider letting the answer renderer show images only for chunks explicitly cited by the model.
