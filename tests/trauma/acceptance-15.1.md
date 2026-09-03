# 说明书 §15.1 自动化核对

- 首次输入定位Ⅰ级初级急救：`stageConfig.spec.ts` 的初始状态与 `runner.spec.ts` happy path。
- 信息不足时先给当前方案再补充：`reasoner.spec.ts` 的结构化方案/缺失信息校验；真实模型措辞留待第三期评测。
- 生命体征变化生成分类版本：`factMerge.spec.ts` 与 `runner.spec.ts` 的回合版本断言。
- 到达新机构后重新分类：工位 A 的机构事实与每个有效回合强制生成分类；五轮真实模型回归留待第三期。
- 能力不足时不把高阶措施列为当前操作：`reasoner.spec.ts` 的 primary-first-aid action rewrite。
- urgent 与 not_ready 可并存：`gate.spec.ts` 的 not-ready transport case。
- BLOCKED 不切阶段且不发确认：`gate.spec.ts` 的 BLOCKED case；`events.ts` 只对 READY 合成确认。
- READY 发起 ask_user_question：`runner.spec.ts` 的 Round 2 fixture。
- 确认后切阶段、拒绝保持并留痕：`runner.spec.ts` 的 confirmed/declined transition cases。
- 冲突、依据不足进入 ASSESSING：`gate.spec.ts` 的 unresolved conflicts and missing evidence case。
- 任意后续阶段人工覆盖、BLOCKED 二次确认：`runner.spec.ts` manual override 与 `StageOverrideDialog.test.tsx`。
- 覆盖不新增叶子、不伪造能力、不立即运行 RAG：`runner.spec.ts` manual override case。
- 覆盖后下一病例回合使用新阶段：由持久化 `currentSubStage` 作为下一次 runner 输入保证；五轮回归留待第三期。
- 超时不自动切阶段：`timeline.spec.ts` 与 `runner.spec.ts` Round 2 fixture。
- Action 与 RAG Chunk 对应：`reasoner.spec.ts` 拒绝未知 chunk ID；语义关联度评测留待第三期。

第三期的真实模型五轮回归、医生审核和证据语义关联度报告不属于本阶段。
