"""Idempotent MinerU parse orchestration backed by the local ingestion ledger."""

from __future__ import annotations

from dataclasses import dataclass

from .ingestion_ledger import IngestionJob, IngestionLedger
from .mineru_adapter import MinerUInvocation, MinerUOutput, run_mineru, validate_mineru_output


@dataclass(frozen=True)
class MinerUIngestionResult:
    job: IngestionJob
    output: MinerUOutput | None
    skipped: bool


def ingest_pdf(*, ledger: IngestionLedger, invocation: MinerUInvocation) -> MinerUIngestionResult:
    """Parse once per source hash and persist either a success or a useful failure."""

    job, should_run = ledger.begin(
        source=invocation.source, output_dir=invocation.output_dir, job_key=invocation.job_key
    )
    if not should_run:
        return MinerUIngestionResult(job=job, output=validate_mineru_output(invocation), skipped=True)
    try:
        run_mineru(invocation)
        output = validate_mineru_output(invocation)
    except Exception as exc:
        ledger.fail(job, str(exc))
        raise
    return MinerUIngestionResult(job=ledger.succeed(job), output=output, skipped=False)
