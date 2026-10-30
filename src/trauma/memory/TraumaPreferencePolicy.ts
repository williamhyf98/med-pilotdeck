import { redact } from "../../context/memory/MemoryPrivacyPolicy.js";
import type {
  ExtractedTraumaPreference,
  TraumaPreferenceCategory,
} from "../types.js";

const MAX_PREFERENCE_DIRECTIVE_CHARS = 300;

const CLINICAL_PATTERNS: readonly RegExp[] = [
  /血压|收缩压|舒张压|心率|脉搏|呼吸频率|血氧|体温|末梢循环|毛细血管再充盈/u,
  /\bSpO2\b|\bBP\b|\bHR\b|\bRR\b|\bETCO2\b/iu,
  /\d+\s*(?:mmHg|kPa|bpm|次\/分|℃|°C)/iu,
  /伤情分级|检伤分级|分诊|危重|轻伤|中度伤|重伤|濒死|伤情评分/u,
  /\bGCS\b|\bISS\b|\bAIS\b|\bRTS\b|\bNISS\b|\bMESS\b/u,
  /救治阶段|一期救治|二期救治|三期救治|阶梯救治|前接|后送|战位|救护所|火线|院前|分级救治/u,
  /伤员|患者|病人|病例|床号|担架号|编号|姓名|性别|军衔|部队番号/u,
  /骨折|气胸|出血|失血|休克|烧伤|截肢|穿透伤|贯通伤|挤压伤|颅脑损伤|脏器|创面|伤口/u,
  /止血带|止血|包扎|固定|输血|输液|补液|镇痛|气道|通气|插管|环甲膜|减压针|胸腔闭式/u,
  /用药|剂量|\d+\s*(?:mg|g|ml|mL|IU|单位)\b/u,
  /影像|CT|MRI|X线|超声|FAST|化验|血常规|血气/u,
];

export type ValidatedTraumaPreference = {
  sourceSpan: string;
  directive: string;
  category: TraumaPreferenceCategory;
  redactedCount: number;
  redactedHits: string[];
};

export type TraumaPreferenceRejectionReason =
  | "source_span_mismatch"
  | "empty_directive"
  | "clinical_content"
  | "empty_after_redaction";

export type TraumaPreferenceValidationResult = {
  accepted: ValidatedTraumaPreference[];
  rejected: Array<{ sourceSpan: string; reason: TraumaPreferenceRejectionReason }>;
};

export function containsTraumaClinicalContent(text: string): boolean {
  return CLINICAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function validateTraumaPreferences(input: {
  rawText: string;
  preferences: readonly ExtractedTraumaPreference[];
}): TraumaPreferenceValidationResult {
  const accepted: ValidatedTraumaPreference[] = [];
  const rejected: TraumaPreferenceValidationResult["rejected"] = [];

  for (const preference of input.preferences) {
    const sourceSpan = preference.sourceSpan.trim();
    const directive = preference.directive.trim().slice(0, MAX_PREFERENCE_DIRECTIVE_CHARS);
    if (!sourceSpan || !input.rawText.includes(sourceSpan)) {
      rejected.push({ sourceSpan, reason: "source_span_mismatch" });
      continue;
    }
    if (!directive) {
      rejected.push({ sourceSpan, reason: "empty_directive" });
      continue;
    }
    if (containsTraumaClinicalContent(sourceSpan) || containsTraumaClinicalContent(directive)) {
      rejected.push({ sourceSpan, reason: "clinical_content" });
      continue;
    }

    const redacted = redact(directive);
    const text = redacted.text.trim();
    if (!text) {
      rejected.push({ sourceSpan, reason: "empty_after_redaction" });
      continue;
    }
    accepted.push({
      sourceSpan,
      directive: text,
      category: preference.category,
      redactedCount: redacted.removedCount,
      redactedHits: redacted.hits,
    });
  }

  return { accepted, rejected };
}
