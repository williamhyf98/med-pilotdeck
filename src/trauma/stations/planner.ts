import type { StructuredModelClient } from "../modelClient.js";
import { compactCaseStateForDownstream } from "../factMerge.js";
import { PLANNER_OUTPUT_SCHEMA, validatePlannerOutput } from "../schemas.js";
import type { PlannedRagQuery } from "../rag/queryPlan.js";
import type { CaseState, RetrievalTrace } from "../types.js";

const PLANNER_SYSTEM_PROMPT = `你是战创伤检索规划工位。根据当前病例状态和第一波检索覆盖度，决定是否需要第二波补充检索。

只建议尚未覆盖的关键缺口、其他活动性伤情、运输禁忌或规则冲突。不要重复第一波已经用过的 query 原文。
不要输出治疗方案、Gate 或阶段变化。queries 最多 3 条。critical 仅在该维度缺失将导致无法研判时为 true。`;

export function createPlannerStation(model: StructuredModelClient): {
  plan(input: {
    state: CaseState;
    firstWave: RetrievalTrace;
    remainingBudget: number;
  }): Promise<PlannedRagQuery[]>;
} {
  return {
    async plan(input) {
      const remainingBudget = Math.max(0, Math.min(3, input.remainingBudget));
      if (remainingBudget === 0) return [];

      const output = await model.completeJson({
        name: "trauma_plan",
        system: PLANNER_SYSTEM_PROMPT,
        user: JSON.stringify({
          remainingBudget,
          caseHistory: compactCaseStateForDownstream(input.state),
          firstWave: input.firstWave,
        }),
        schema: PLANNER_OUTPUT_SCHEMA,
        validate: validatePlannerOutput,
      });

      const seen = new Set(input.firstWave.queries.map((query) => query.query.trim()));
      const planned: PlannedRagQuery[] = [];
      for (const item of output.queries) {
        const query = item.query.trim();
        if (!query || seen.has(query)) continue;
        seen.add(query);
        planned.push({
          wave: 2,
          kind: "supplemental",
          query,
          reason: item.reason,
          critical: item.critical === true,
        });
        if (planned.length >= remainingBudget) break;
      }
      return planned;
    },
  };
}
