# 说明书 §15.1 自动化核对

本文只列当前仓库仍存在的自动化测试。模型回答质量、临床正确性和多轮真实病例效果不由这些单元测试代替。

## 已有自动化覆盖

- 新病例初始主级、子级、机构为空；阶段域仅含Ⅰ/Ⅱ级四个子级：`stageConfig.spec.ts`、`placement.spec.ts`。
- 表单必须包含至少一段叙述或一项实测体征；级别选择本身不算有效输入；字段范围、整数/小数精度和字数上限：`factMerge.spec.ts`、`TraumaTurnForm.test.tsx`。
- 四段叙述与本轮体征确定性追加，空字段不伪造本轮记录：`factMerge.spec.ts`。
- 下游病例视图保留最近 6 条体征记录，并为每个体征给出最近值、来源轮次与陈旧标记：`factMerge.spec.ts`。
- 表单明示子级时跳过工位 P，并按子级派生机构；外科复苏对应医务中心：`runner.spec.ts`、`placement.spec.ts`。
- 未明示子级时，工位 P 在 RAG 前使用固化定义；信息不足保持未落位，已处于专科治疗（Ⅲ级）或康复治疗（Ⅳ级）时返回超范围：`placer.spec.ts`、`placement.spec.ts`。
- 首次落位或级别变化通过 elicitation 暂停并恢复同一回合；建议不变时无需再次确认：`routing.spec.ts`、`placementEvents.spec.ts`、`runner.spec.ts`。
- 完整成功回合严格记录 14 个步骤：`runner.spec.ts`。
- `undetermined` / `out_of_scope` 使用 6 步短路径：合并后的合法表单以部分 `agent_turn` 持久化，`version` / `round` 递增，响应使用真实 runId，且不调用 RAG 或工位 B：`runner.spec.ts`。
- 第一波固定 3 条关键查询且不含时效查询；补检预算不超过 3；合并后注入不超过 15 个知识块，远程结果优先：`queryPlan.spec.ts`、`planner.spec.ts`、`ragMerge.spec.ts`。
- 能力不足时不把高阶措施列为当前操作；外科复苏之后的具体措施不进入结构化方案；未知知识块 ID 被拒绝：`reasoner.spec.ts`。
- `not_ready` 与更高能力需求形成 `BLOCKED`；冲突、缺证据或低置信度形成 `ASSESSING`；`READY` 必须同时满足目标阶段、能力与转运就绪：`gate.spec.ts`。
- Gate `READY` 仅表示医学建议，不产生第二张确认：`reasoner.spec.ts`、`TraumaWorkspace.test.tsx`。
- 人工覆盖必须遵守四个子级顺序，`BLOCKED` 覆盖需要二次风险确认；覆盖使用派生机构与能力：`runner.spec.ts`、`StageOverrideDialog.test.tsx`。
- 旧病例读取保留新格式记录，迁移旧体征为顺序轮次 `index + 1`，并拒绝损坏状态：`store.spec.ts`。
- 战创伤请求必须携带 `traumaForm` 并绕过通用 `AgentSession.submit`；通用医学仍走标准会话：`routing.spec.ts`。
- 前端提交把 `traumaForm` 放入命令 options，不把 JSON 暴露为可见文本：`sessionLauncher.test.tsx`、`MainContent.test.tsx`、`pilotdeck-bridge.test.js`。
- 战创伤工作台移除普通 composer，但持续挂载实时 `ChatInterfaceV2` runtime；提交期间显示实时进度以及落位 permission/elicitation banner；只读轮次时间线展示表单摘要与助手回答：`ChatInterfaceV2.layout.test.tsx`、`MainContent.test.tsx`、`TraumaWorkspace.test.tsx`。
- 病例读取与阶段确认/人工覆盖远程 RPC 转发：`tests/gateway/traumaRpc.spec.ts`。

## 留待第三期评测

- 真实模型多轮病例回归，包括到达新机构后的重新分类、跨轮更正理解与缺失信息追问质量。
- 医生审核：定级合理性、当前阶段措施边界、后送建议与安全性。
- 主文完整性、可读性以及 800～2500 字要求的稳定达成率。
- 引用证据与具体措施之间的语义关联度、覆盖率和可追溯性报告。
- 真实 RAG 服务下的召回质量、延迟、故障恢复与总体端到端性能。
