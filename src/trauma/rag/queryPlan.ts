import { compactCaseStateForDownstream } from "../factMerge.js";
import { SUBSTAGE_TO_MAIN } from "../stageConfig.js";
import type { CaseState, MainStage, RagQueryKind, SubStage } from "../types.js";

export type PlannedRagQuery = {
  kind: RagQueryKind;
  query: string;
  reason: string;
  critical: boolean;
};

const SUBSTAGE_LABEL: Record<SubStage, string> = {
  primary_first_aid: "初级急救",
  advanced_first_aid: "高级急救",
  emergency_treatment: "紧急处置",
  surgical_resuscitation: "外科复苏",
};

const MAIN_STAGE_LABEL: Record<MainStage, string> = {
  battlefield_first_aid: "战现场急救",
  early_treatment: "早期救治",
};

const MAX_QUERY_TOKENS = 24;
const MAX_CAPABILITY_TOKENS = 5;

const BODY_ROUTE_RULES = [
  {
    terms: ["颅脑", "头部", "脑"],
    chapter: ["第六章", "第一节", "颅脑伤救治"],
  },
  {
    terms: ["颌面", "颈部"],
    chapter: ["第六章", "第二节", "颌面、颈部伤救治"],
  },
  {
    terms: ["胸部", "胸痛", "气胸", "血胸", "肺"],
    chapter: ["第六章", "第三节", "胸部伤救治"],
  },
  {
    terms: ["腹部", "腹痛", "腹腔"],
    chapter: ["第六章", "第四节", "腹部伤救治"],
  },
  {
    terms: ["脊柱", "脊髓"],
    chapter: ["第六章", "第五节", "脊柱、脊髓伤救治"],
  },
  {
    terms: ["骨盆"],
    chapter: ["第六章", "第六节", "骨盆伤救治"],
  },
  {
    terms: ["四肢", "肢体", "上肢", "下肢", "小腿", "大腿", "手臂", "手足", "骨折", "出血", "止血带"],
    chapter: ["第六章", "第七节", "四肢伤救治"],
  },
  {
    terms: ["多发伤"],
    chapter: ["第六章", "第八节", "多发伤救治"],
  },
] as const;

const INJURY_TYPE_ROUTE_RULES = [
  {
    terms: ["挤压伤"],
    chapter: ["第五章", "第一节", "挤压伤救治"],
  },
  {
    terms: ["冲击伤"],
    chapter: ["第五章", "第二节", "冲击伤救治"],
  },
  {
    terms: ["烧伤"],
    chapter: ["第五章", "第三节", "烧伤救治"],
  },
  {
    terms: ["冻伤"],
    chapter: ["第五章", "第四节", "冻伤救治"],
  },
  {
    terms: ["复合伤"],
    chapter: ["第五章", "第五节", "复合伤救治"],
  },
] as const;

const ENVIRONMENT_ROUTE_RULES = [
  {
    terms: ["核武器", "放射", "核伤"],
    chapter: ["第七章", "第一节", "核武器损伤防治"],
  },
  {
    terms: ["化学武器", "化学伤"],
    chapter: ["第七章", "第二节", "化学武器伤防治"],
  },
  {
    terms: ["生物武器", "生物伤"],
    chapter: ["第七章", "第三节", "生物武器伤防治"],
  },
  {
    terms: ["推进剂"],
    chapter: ["第七章", "第四节", "导弹和火箭推进剂损伤防治"],
  },
  {
    terms: ["新概念武器"],
    chapter: ["第七章", "第五节", "新概念武器伤防治"],
  },
  {
    terms: ["海战", "减压病", "海水浸泡", "水下冲击伤"],
    chapter: ["第八章", "第一节", "海战伤救治"],
  },
  {
    terms: ["飞行", "空运"],
    chapter: ["第八章", "第二节", "飞行人员特殊损伤救治"],
  },
  {
    terms: ["高原"],
    chapter: ["第八章", "第五节", "高原战伤救治"],
  },
  {
    terms: ["寒区"],
    chapter: ["第八章", "第七节", "寒区战伤救治"],
  },
  {
    terms: ["热区"],
    chapter: ["第八章", "第八节", "热区战伤救治"],
  },
] as const;

const COMPLICATION_ROUTE_RULES = [
  {
    terms: ["心功能", "心衰", "心律失常", "肺水肿"],
    chapter: ["第九章", "第一节", "心功能障碍防治"],
  },
  {
    terms: ["ARDS", "呼吸窘迫", "呼吸功能障碍"],
    chapter: ["第九章", "第二节", "急性呼吸窘迫征（ARDS）防治"],
  },
  {
    terms: ["肾功能", "肾衰", "高钾血症"],
    chapter: ["第九章", "第三节", "急性肾功能损害防治"],
  },
  {
    terms: ["肝功能"],
    chapter: ["第九章", "第四节", "肝功能不全防治"],
  },
  {
    terms: ["消化道"],
    chapter: ["第九章", "第五节", "消化道并发症防治"],
  },
  {
    terms: ["MODS", "多器官", "脓毒症"],
    chapter: ["第九章", "第六节", "战伤后多器官功能障碍综合征的防治"],
  },
  {
    terms: ["战斗应激", "应激反应"],
    chapter: ["第十章", "第一节", "战斗应激反应防治"],
  },
  {
    terms: ["PTSD", "创伤后应激"],
    chapter: ["第十章", "第二节", "创伤后应激障碍救治"],
  },
  {
    terms: ["精神障碍", "谵妄"],
    chapter: ["第十章", "第三节", "战创伤后精神障碍救治"],
  },
] as const;

const ACTION_KEYWORDS = [
  "止血带",
  "止血",
  "加压包扎",
  "包扎",
  "固定",
  "搬运",
  "通气",
  "气道",
  "穿刺",
  "引流",
  "封闭",
  "清创",
  "复苏",
  "抗休克",
  "监测",
  "后送",
  "洗消",
  "隔离",
  "镇痛",
  "镇静",
  "手术",
] as const;

type CompactCaseView = ReturnType<typeof compactCaseStateForDownstream>;

function latestVitals(view: CompactCaseView): string {
  const labels = {
    respiratoryRate: "RR",
    systolicBloodPressure: "SBP",
    heartRate: "HR",
    temperature: "T",
  } as const;
  const parts = Object.entries(labels).flatMap(([key, label]) => {
    const reading = view.vitals.latestByField[key as keyof typeof labels];
    if (!reading) return [];
    const unit = key === "temperature" ? "℃" : "";
    const freshness = reading.stale
      ? `第${reading.round}轮，本轮未测`
      : `第${reading.round}轮`;
    return [`${label} ${reading.value}${unit}（${freshness}）`];
  });
  return parts.join("，") || "生命体征未知";
}

function injurySummary(view: CompactCaseView): string {
  return narrativeSummary(view.injuryNarratives, "伤情未明");
}

function narrativeSummary(
  entries: CompactCaseView["injuryNarratives"],
  emptyLabel: string,
): string {
  if (entries.length === 0) return emptyLabel;
  return entries
    .slice(0, 3)
    .map((entry) => `第${entry.round}轮：${entry.text.slice(0, 300)}`)
    .join("；")
    .slice(0, 360);
}

function caseContext(state: CaseState): string {
  const view = compactCaseStateForDownstream(state);
  const current = view.currentSubStage
    ? `已确认救治级别：${SUBSTAGE_LABEL[view.currentSubStage]}`
    : "已确认救治级别：未定级";
  return [
    current,
    `机构：${view.facility?.name ?? "未记录"}`,
    `伤情：${injurySummary(view)}`,
    `处置：${narrativeSummary(view.treatmentNarratives, "未记录")}`,
    `后送：${narrativeSummary(view.evacuationNarratives, "未记录")}`,
    ...(view.note ? [`补充说明：第${view.note.round}轮：${view.note.text.slice(0, 300)}`] : []),
    `生命体征：${latestVitals(view)}`,
  ].join("；");
}

function uniqueParts(parts: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function buildQuery(parts: Array<string | undefined | null>): string {
  const tokens: string[] = [];
  for (const part of uniqueParts(parts)) {
    for (const token of part.split(/\s+/u)) {
      const trimmed = token.trim();
      if (!trimmed || tokens.includes(trimmed)) continue;
      tokens.push(trimmed);
      if (tokens.length >= MAX_QUERY_TOKENS) {
        return tokens.join(" ");
      }
    }
  }
  return tokens.join(" ");
}

function currentStageLabels(state: CaseState): { main: string; sub: string } {
  if (!state.currentSubStage) {
    return {
      main: state.currentStage ? MAIN_STAGE_LABEL[state.currentStage] : "未定级",
      sub: "未定级",
    };
  }
  return {
    main: MAIN_STAGE_LABEL[SUBSTAGE_TO_MAIN[state.currentSubStage]],
    sub: SUBSTAGE_LABEL[state.currentSubStage],
  };
}

function recentTexts(state: CaseState): string[] {
  const view = compactCaseStateForDownstream(state);
  return [
    ...view.injuryNarratives.map((entry) => entry.text),
    ...view.treatmentNarratives.map((entry) => entry.text),
    ...view.evacuationNarratives.map((entry) => entry.text),
    ...(view.note ? [view.note.text] : []),
  ];
}

function pickKeywords(texts: string[], terms: readonly string[], limit = 4): string[] {
  const combined = texts.join(" ");
  const result: string[] = [];
  for (const term of terms) {
    if (result.length >= limit) break;
    if (combined.includes(term) && !result.includes(term)) {
      result.push(term);
    }
  }
  return result;
}

function pickSectionHints(texts: string[], rules: readonly { terms: readonly string[]; chapter: readonly string[] }[]): string[] {
  const combined = texts.join(" ");
  const result: string[] = [];
  for (const rule of rules) {
    if (!rule.terms.some((term) => combined.includes(term))) continue;
    for (const token of rule.chapter) {
      if (!result.includes(token)) result.push(token);
    }
  }
  return result;
}

function formatVitals(state: CaseState): string[] {
  const view = compactCaseStateForDownstream(state);
  const labels = [
    ["respiratoryRate", "RR"],
    ["systolicBloodPressure", "SBP"],
    ["heartRate", "HR"],
    ["temperature", "T"],
  ] as const;
  return labels.flatMap(([key, label]) => {
    const reading = view.vitals.latestByField[key];
    if (!reading) return [];
    const unit = key === "temperature" ? "℃" : "";
    return `${label} ${reading.value}${unit}`;
  });
}

function buildQueryContext(state: CaseState): {
  mainStageLabel: string;
  subStageLabel: string;
  facilityName: string;
  capabilityKeywords: string[];
  injuryKeywords: string[];
  bodyKeywords: string[];
  injuryTypeKeywords: string[];
  complicationKeywords: string[];
  environmentKeywords: string[];
  actionKeywords: string[];
  vitalKeywords: string[];
  transportKeywords: string[];
  evacuationKeywords: string[];
  chapter2StageHints: string[];
  chapter3StageHints: string[];
} {
  const labels = currentStageLabels(state);
  const texts = recentTexts(state);
  const facilityName = state.currentFacility?.name?.trim() ?? "";
  const capabilityKeywords = uniqueParts([
    ...(state.currentFacility?.capabilities ?? []).slice(0, MAX_CAPABILITY_TOKENS),
    ...state.currentCapabilities.slice(0, MAX_CAPABILITY_TOKENS),
    ...state.requiredCapabilities.slice(0, MAX_CAPABILITY_TOKENS),
  ]).slice(0, MAX_CAPABILITY_TOKENS);
  const bodyKeywords = pickKeywords(texts, [
    "颅脑",
    "头部",
    "颌面",
    "颈部",
    "胸部",
    "胸痛",
    "气胸",
    "血胸",
    "腹部",
    "脊柱",
    "脊髓",
    "骨盆",
    "四肢",
    "肢体",
    "下肢",
    "上肢",
    "小腿",
    "大腿",
    "手足",
    "多发伤",
  ] as const, 4);
  const injuryTypeKeywords = pickKeywords(texts, [
    "挤压伤",
    "冲击伤",
    "烧伤",
    "冻伤",
    "复合伤",
    "开放伤",
    "穿透伤",
    "骨折",
    "气胸",
    "血胸",
    "休克",
    "出血",
  ] as const, 4);
  const complicationKeywords = pickKeywords(texts, [
    "休克",
    "感染",
    "心功能",
    "心衰",
    "心律失常",
    "ARDS",
    "肾功能",
    "肾衰",
    "肝功能",
    "消化道",
    "MODS",
    "多器官",
    "精神障碍",
    "战斗应激",
    "PTSD",
  ] as const, 4);
  const environmentKeywords = pickKeywords(texts, [
    "核武器",
    "化学武器",
    "生物武器",
    "推进剂",
    "新概念武器",
    "海战",
    "减压病",
    "海水浸泡",
    "水下冲击伤",
    "空运",
    "高原",
    "寒区",
    "热区",
    "山岳丛林",
  ] as const, 4);
  const actionKeywords = pickKeywords([
    ...texts,
    ...state.currentCapabilities,
  ], ACTION_KEYWORDS, 5);
  const evacuationKeywords = pickKeywords(texts, [
    "后送",
    "稳定后送",
    "转运",
    "车辆",
    "道路",
    "通行",
    "可用",
    "撤离",
    "运送",
  ] as const, 4);
  const injuryKeywords = uniqueParts([
    ...injuryTypeKeywords,
    ...bodyKeywords,
    ...complicationKeywords,
  ]).slice(0, 5);
  const vitalKeywords = formatVitals(state);
  const transportKeywords = uniqueParts([
    state.transport.gateStatus === "READY" ? "稳定后送" : "",
    state.transport.gateStatus === "BLOCKED" ? "后送受限" : "",
    state.transport.priority && state.transport.priority !== "pending"
      ? `后送优先级 ${state.transport.priority}`
      : "",
    state.transport.readiness !== "unknown"
      ? `后送准备 ${state.transport.readiness}`
      : "",
    state.transport.blockingReason ?? "",
  ]).slice(0, 4);
  const chapter2StageHints = uniqueParts([
    "第二章 分级救治",
    "第二章 分类救治",
    "第二章 救送结合",
    labels.main,
    labels.sub,
  ]);
  const chapter3StageHints = uniqueParts([
    "第三章 战伤救治技术范围",
    labels.main,
    labels.sub,
    ...capabilityKeywords,
  ]);
  return {
    mainStageLabel: labels.main,
    subStageLabel: labels.sub,
    facilityName,
    capabilityKeywords,
    injuryKeywords,
    bodyKeywords,
    injuryTypeKeywords,
    complicationKeywords,
    environmentKeywords,
    actionKeywords,
    vitalKeywords,
    transportKeywords,
    evacuationKeywords,
    chapter2StageHints,
    chapter3StageHints,
  };
}

function routeChapterHints(context: ReturnType<typeof buildQueryContext>): string[] {
  const hints = pickSectionHints(
    [
      ...context.injuryKeywords,
      ...context.bodyKeywords,
      ...context.injuryTypeKeywords,
      ...context.complicationKeywords,
      ...context.environmentKeywords,
    ],
    [
      ...INJURY_TYPE_ROUTE_RULES,
      ...ENVIRONMENT_ROUTE_RULES,
      ...COMPLICATION_ROUTE_RULES,
      ...BODY_ROUTE_RULES,
    ],
  );
  return hints.slice(0, 6);
}

export function buildBaselineQueries(state: CaseState): PlannedRagQuery[] {
  const context = buildQueryContext(state);
  const query1 = buildQuery([
    "战伤救治规则",
    "第二章 分级救治",
    "第三章 战伤救治技术范围",
    context.mainStageLabel,
    context.subStageLabel,
    context.facilityName,
    "机构职责",
    "救治范围",
    "技术范围",
    ...context.capabilityKeywords,
  ]);
  const query2 = buildQuery([
    "战伤救治规则",
    "第二章 分类救治",
    "第二章 救送结合",
    "第四章 伤势判断与救治优先顺序",
    "附件2 伤员伤势评估及救治顺序参考条件",
    context.mainStageLabel,
    context.subStageLabel,
    ...context.vitalKeywords,
    ...context.transportKeywords,
    ...context.evacuationKeywords,
    ...context.injuryKeywords,
    "伤势判断",
    "救治优先顺序",
    "后送分类",
    "稳定后送",
  ]);
  const query3 = buildQuery([
    "战伤救治规则",
    "具体伤情处置",
    ...routeChapterHints(context),
    ...context.injuryKeywords,
    ...context.bodyKeywords,
    ...context.complicationKeywords,
    ...context.environmentKeywords,
    ...context.actionKeywords,
    "处置",
  ]);
  return [
    {
      kind: "stage",
      query: query1,
      reason: "覆盖已确认级别的机构职责与技术范围",
      critical: true,
    },
    {
      kind: "classification_transport",
      query: query2,
      reason: "覆盖伤势判断、后送分类与救送结合规则",
      critical: true,
    },
    {
      kind: "primary_injury",
      query: query3,
      reason: "覆盖具体伤类、伤部、并发症与环境相关处置",
      critical: true,
    },
  ];
}
