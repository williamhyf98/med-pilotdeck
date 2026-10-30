"""One job per subprocess; all inference paths are derived from that job."""

import json
import os
import subprocess
import sys
from pathlib import Path

from .inputs import prepare_input
from .evidence import build_evidence
from .answer import generate_report


def run_job(job):
    job = Path(job).resolve()
    workspace = Path(os.environ["MED_DEEPCHEST_ROOT"]).resolve()
    python = workspace / ".venvs/radar/bin/python"
    request = json.loads((job / "request.json").read_text())
    environment = os.environ.copy()
    environment.update(
        CUDA_VISIBLE_DEVICES=os.environ["DEEPCHEST_GPU"],
        PYTHONNOUSERSITE="1",
        OMP_NUM_THREADS="4",
    )

    def phase(name):
        (job / "phase.txt").write_text(name)

    def execute(name, command):
        phase(name)
        with (job / f"{name}.log").open("w") as log:
            subprocess.run(
                [str(x) for x in command],
                cwd=workspace,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=True,
            )

    phase("prepare")
    binding = prepare_input(
        job / request["upload"],
        job,
        request["body_region"],
        request["modality"],
        request["intensity_units"],
    )
    (job / "binding.json").write_text(json.dumps(binding, ensure_ascii=False))
    mask = job / "segmentations" / "upload" / job.name
    execute(
        "segment",
        [
            python,
            workspace / "experiments/3dmedagent_repro/segment_deepchest.py",
            "--nifti",
            job / binding["volume"],
            "--output-dir",
            mask,
            "--fast",
        ],
    )
    segmentation = json.loads((mask / "deepchest_segmentation_report.json").read_text())
    if not segmentation["validation"]["passed"]:
        raise ValueError("Segmentation validation failed")
    execute(
        "ctclip",
        [
            python,
            workspace / "experiments/3dmedagent_repro/run_ctclip_deepchest.py",
            "--gpu",
            environment["CUDA_VISIBLE_DEVICES"],
            "--csv",
            job / "case.csv",
            "--data-root",
            job / "volumes",
            "--mask-root",
            job / "segmentations",
            "--output-root",
            job / "ctclip",
        ],
    )
    summary = json.loads((job / "ctclip/流水线汇总.json").read_text())
    if not summary.get("全部成功"):
        raise ValueError("CT-CLIP stage failed; see private job logs")
    evidence = build_evidence(job / "ctclip", job.name)
    evidence["input"] = {k: v for k, v in binding.items() if k != "volume"}
    (job / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False))
    phase("answer")
    report = generate_report(request["question"], evidence)
    result = {
        "case_id": job.name,
        "report": report,
        "evidence": evidence,
        "model": os.environ["FINAL_TEST_OPENAI_MODEL"],
        "source": "DeepChest CT-CLIP + 中文证据分析",
        "limitations": evidence["limitations"],
    }
    (job / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    run_job(sys.argv[1])
