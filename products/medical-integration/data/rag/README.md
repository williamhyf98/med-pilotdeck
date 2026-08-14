# RAG corpus relocated

The war-trauma JSONL/NPY corpus previously stored under this directory has been
**moved to the med-tools plugin** (self-contained, no product runtime dependency):

```text
plugins/med-tools/data/rag/
  manifest.json
  corpus/war_trauma_books_chunks.jsonl
  embedding/war_trauma_books_embedding.npy
```

Use `mcp__med-tools__med_trauma_rag_query` / `med_trauma_rag_status` instead of the
frozen medical sidecar RAG paths.
