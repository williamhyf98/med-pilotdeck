/**
 * 基准数据已知问题登记。
 *
 * 2026-10-02 审计 dev 集 101 篇综述的 refined_picos（.scratch/audit_criteria.mjs）发现两类问题：
 *   1. 页脚截断：加载器在 PDF 页脚处把标准正文砍掉（52 篇受影响）。已在 load.ts 修复，不在此登记。
 *   2. 抽错章节 / 元素为空：P 或 I 整个为空，或内容来自综述里别的章节（如经济学评价部分）。
 *      这是上游构建 reviews_a 时的问题，加载器修不了。这些综述在任何筛选策略下都接近 0 分，
 *      留在 dev 集里只会把基线数字压低、把版本比较的噪声抬高，所以按 split 跑批时跳过并记录；
 *      用 --reviews 显式点名时仍然会跑（方便复现问题）。
 *
 * 处理原则：登记而不是静默删除——评测报告里要能看到跳过了哪些、为什么（设计文档 §7：
 * 不能把数据问题包装成方法收益）。修好数据后把条目删掉即可。
 */
export const BROKEN_CRITERIA_REVIEWS: Readonly<Record<string, string>> = {
  CD010841: "refined_picos.P 与 I 为空",
  CD013387: "refined_picos.P 与 I 为空；S 取自综述的经济学评价章节，且文字粘连（Wesoughteconomicevaluations）",
  CD014745: "refined_picos.P 与 I 为空",
  CD015436: "refined_picos.I 为空",
  CD015456: "refined_picos.P 与 I 为空",
};

export function isBenchmarkReviewUsable(id: string): boolean {
  return !(id in BROKEN_CRITERIA_REVIEWS);
}

/** 从一批综述里剔除已登记的坏数据，返回保留的与被跳过的（附原因），供日志与报告使用。 */
export function partitionUsableReviews(ids: readonly string[]): {
  usable: string[];
  skipped: { id: string; reason: string }[];
} {
  const usable: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const reason = BROKEN_CRITERIA_REVIEWS[id];
    if (reason) skipped.push({ id, reason });
    else usable.push(id);
  }
  return { usable, skipped };
}
