/**
 * 预算计量。RQ3 要画质量—成本曲线，文档第 5 节还要求
 * "把初始化、索引、摘要、验证器和失败重试成本都纳入统计"。
 *
 * 做法是包一层模型客户端，而不是让每个工位自己上报：工位可能重试、
 * 可能内部多调一次，包在客户端上才数得全，也不会漏掉失败的那次调用。
 */
import type { CompleteJsonInput, StructuredModelClient } from "../trauma/modelClient.js";
import type { BudgetUsage } from "./state/types.js";

export type BudgetMeter = {
  readonly usage: BudgetUsage;
  /** 包装模型客户端，调用与 prompt 字符数都计入。 */
  meterModel(client: StructuredModelClient): StructuredModelClient;
  addPubMedRequests(n: number): void;
  addFullTextFetches(n: number): void;
  addHumanQueries(n: number): void;
  addWallClock(ms: number): void;
  snapshot(): BudgetUsage;
};

export function createBudgetMeter(initial?: Partial<BudgetUsage>): BudgetMeter {
  const usage: BudgetUsage = {
    modelCalls: initial?.modelCalls ?? 0,
    promptChars: initial?.promptChars ?? 0,
    pubmedRequests: initial?.pubmedRequests ?? 0,
    fullTextFetches: initial?.fullTextFetches ?? 0,
    humanQueries: initial?.humanQueries ?? 0,
    wallClockMs: initial?.wallClockMs ?? 0,
  };
  return {
    usage,
    meterModel(client) {
      return {
        async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
          usage.modelCalls += 1;
          usage.promptChars += input.system.length + input.user.length;
          return client.completeJson(input);
        },
        ...(client.streamJson
          ? {
            async streamJson<T>(
              input: CompleteJsonInput<T>,
              callbacks?: Parameters<NonNullable<StructuredModelClient["streamJson"]>>[1],
            ): Promise<T> {
              usage.modelCalls += 1;
              usage.promptChars += input.system.length + input.user.length;
              return client.streamJson!(input, callbacks);
            },
          }
          : {}),
      };
    },
    addPubMedRequests(n) { usage.pubmedRequests += n; },
    addFullTextFetches(n) { usage.fullTextFetches += n; },
    addHumanQueries(n) { usage.humanQueries += n; },
    addWallClock(ms) { usage.wallClockMs += ms; },
    snapshot() { return { ...usage }; },
  };
}
