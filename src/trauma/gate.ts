import type { ClinicalGateAssessment, RetrievalTrace } from "./types.js";

export function resolveGate(
  assessment: ClinicalGateAssessment,
  retrieval: RetrievalTrace,
): "ASSESSING" | "STAY" | "BLOCKED" | "READY" {
  const unresolvedConflict = assessment.ruleConflicts.some((item) => item.unresolved);
  const evidenceMissing = assessment.evidenceChunkIds.length === 0;
  const coverageInsufficient = retrieval.criticalCoverageGaps.length > 0;
  const confidenceInsufficient = assessment.confidence < 0.75;

  if (
    assessment.needHigherCapability === "unknown"
    || unresolvedConflict
    || evidenceMissing
    || coverageInsufficient
    || confidenceInsufficient
  ) {
    return "ASSESSING";
  }

  if (!assessment.needHigherCapability) return "STAY";

  if (assessment.transportReadiness === "unknown") return "ASSESSING";

  if (
    assessment.transportReadiness === "not_ready"
    || assessment.blockingFactors.length > 0
  ) {
    return "BLOCKED";
  }

  if (
    assessment.transportReadiness === "ready"
    && assessment.requiredCapabilities.length > 0
    && assessment.targetStage
    && assessment.targetSubStage
  ) {
    return "READY";
  }

  return "ASSESSING";
}
