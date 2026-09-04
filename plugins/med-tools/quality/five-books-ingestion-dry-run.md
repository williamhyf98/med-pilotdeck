# Five-Book Ingestion Dry Run

Date: 2026-08-26

## Source PDFs

Root: `/home/jiangzhenming/projects/med-pilotdeck/军事医学/军事医学`

| file | pages | size |
| --- | ---: | ---: |
| 军事医学丛书 大规模杀伤性武器与恐怖袭击应对手册.pdf | 316 | 38.9 MiB |
| 军事医学丛书 战场医学.pdf | 440 | 103.4 MiB |
| 军事医学丛书 核化生应急医学救援.pdf | 344 | 47.7 MiB |
| 军事医学丛书 美军战地医务人员（68W）高级战场急救技能训练手册.pdf | 573 | 134.6 MiB |
| 军事医学丛书 院前创伤生命支持 第7版.pdf | 693 | 148.0 MiB |

Total: 2366 pages, about 473 MiB source PDFs.

## Current Sample Baseline

- Active sample bundle: `/slow_share/jiangzhenming/med-pilotdeck-rag/bundles/hard-suite-text-image-v2`
- Sample bundle size: 6.1 MiB
- Sample MinerU acceptance outputs: 44 MiB
- Sample corpus rows: 63
- Sample pages: 50
- Bundled sample images: 36

## Disk State

- `/`: 85 GiB available
- `/slow_share`: 58 TiB available
- `/local_data`: 2.4 TiB available

## Proposed Full-Run Output

Use a new personal output root and keep the existing sample bundle unchanged:

```text
/slow_share/jiangzhenming/med-pilotdeck-rag/full-runs/five-books-v1/
/slow_share/jiangzhenming/med-pilotdeck-rag/bundles/five-books-v1/
```

Do not write full MinerU outputs, images, embeddings, or bundle assets into Git.

## Estimated Scale

Using the 50-page sample as a rough baseline:

- Page multiplier: about 47.3x
- MinerU intermediate outputs: roughly 2-3 GiB, depending on extracted images
- Self-contained RAG bundle: likely hundreds of MiB, depending on image density
- Embedding matrix for about 3000 text chunks at 2048 float32 dimensions: about 24 MiB

The dominant cost is MinerU intermediate images, not the vector matrix.

## Full-Run Gate

Before starting full ingestion:

1. Confirm no large files go under `$HOME` or repo-tracked paths.
2. Confirm output directory is under `/slow_share/jiangzhenming/med-pilotdeck-rag`.
3. Check CPU load and choose conservative workers, e.g. 4-8 CPU workers.
4. Keep the existing `hard-suite-text-image-v2` sample bundle as regression baseline.
5. Run one book first, not all five, then validate chunk count, image count, and 5-10 queries.
