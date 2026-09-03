import { createHash } from "node:crypto";

import type {
  CaseState,
  ExtractedFact,
  ExtractedTurnFacts,
  InjuryFinding,
  TreatmentAction,
  VitalSigns,
} from "./types.js";

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 12)}`;
}

function vitalKey(fact: ExtractedFact): string {
  return `${fact.measuredAt ?? ""}\0${fact.sourceMessageId}`;
}

function appendVitals(state: CaseState, facts: ExtractedTurnFacts["vitalSigns"], now: string): void {
  const grouped = new Map<string, VitalSigns>();
  for (const fact of facts) {
    if (fact.certainty === "excluded" || fact.certainty === "unknown") continue;
    const key = vitalKey(fact);
    const vital = grouped.get(key) ?? {
      measuredAt: fact.measuredAt ?? now,
      sourceMessageId: fact.sourceMessageId,
    };
    const value = fact.value.value;
    switch (fact.value.type) {
      case "respiratory_rate":
        if (typeof value === "number") vital.respiratoryRate = value;
        break;
      case "blood_pressure":
        if (typeof value === "object") {
          vital.systolicBloodPressure = value.systolic;
          vital.diastolicBloodPressure = value.diastolic;
        }
        break;
      case "heart_rate":
        if (typeof value === "number") vital.heartRate = value;
        break;
      case "spo2":
        if (typeof value === "number") vital.spo2 = value;
        break;
      case "gcs":
        if (typeof value === "number") vital.gcs = value;
        break;
      case "temperature":
        if (typeof value === "number") vital.temperature = value;
        break;
    }
    grouped.set(key, vital);
  }
  state.vitalSignsHistory.push(...grouped.values());
}

function mergeInjuries(state: CaseState, facts: ExtractedTurnFacts["injuryFindings"]): void {
  for (const fact of facts) {
    const existing = state.injuries.find(
      injury => injury.bodyPart === fact.value.bodyPart
        && injury.finding === fact.value.finding,
    );
    const certainty: InjuryFinding["certainty"] = fact.certainty === "unknown"
      ? "suspected"
      : fact.certainty;
    if (existing) {
      existing.certainty = certainty;
      existing.status = fact.value.status ?? existing.status;
      existing.sourceMessageId = fact.sourceMessageId;
      existing.sourceQuote = fact.sourceQuote;
      existing.confidence = fact.confidence;
      continue;
    }
    state.injuries.push({
      id: stableId("injury", fact.value.bodyPart, fact.value.finding),
      category: "extracted",
      bodyPart: fact.value.bodyPart,
      finding: fact.value.finding,
      certainty,
      status: fact.value.status ?? "active",
      sourceMessageId: fact.sourceMessageId,
      sourceQuote: fact.sourceQuote,
      confidence: fact.confidence,
    });
  }
}

function mergeTreatments(state: CaseState, facts: ExtractedTurnFacts["treatmentEvents"]): void {
  for (const fact of facts) {
    const action: TreatmentAction = {
      id: stableId("action", fact.sourceMessageId, fact.value.action),
      title: fact.value.action,
      description: fact.sourceQuote,
      scope: "current_stage",
      priority: 0,
      evidenceChunkIds: [],
      professionalConfirmationRequired: false,
    };
    if (fact.value.status === "completed") {
      if (!state.completedActions.some(item => item.id === action.id)) {
        state.completedActions.push(action);
      }
    } else if (!state.currentActions.some(item => item.id === action.id)) {
      state.currentActions.push(action);
    }
  }
}

function mergeCareFacts(state: CaseState, facts: ExtractedTurnFacts["careAndTransportFacts"]): void {
  for (const fact of facts) {
    const { description, type } = fact.value;
    if (type === "capability" && !state.currentCapabilities.includes(description)) {
      state.currentCapabilities.push(description);
    }
    if (type === "capability_gap" && !state.requiredCapabilities.includes(description)) {
      state.requiredCapabilities.push(description);
    }
    if (type === "destination") {
      state.transport.targetFacilityType = description;
    }
    if (type === "transport_constraint") {
      state.transport.blockingReason = description;
      state.transport.readiness = "not_ready";
    }
  }
}

export function mergeExtractedFacts(
  previous: CaseState,
  facts: ExtractedTurnFacts,
  now: string,
): CaseState {
  const state = structuredClone(previous);
  state.updatedAt = now;

  const eventTime = facts.context.eventTime?.value;
  if (eventTime && !state.timeline.injuryTime) {
    state.timeline.injuryTime = eventTime;
  }
  if (facts.context.facility?.value) {
    state.currentFacility.name = facts.context.facility.value;
  }

  appendVitals(state, facts.vitalSigns, now);
  mergeInjuries(state, facts.injuryFindings);
  mergeTreatments(state, facts.treatmentEvents);
  mergeCareFacts(state, facts.careAndTransportFacts);
  state.conflictingFactIds = Array.from(new Set([
    ...state.conflictingFactIds,
    ...facts.correctionsAndProvenance.conflictingFactIds,
  ]));

  return state;
}
