# Task 12：node12 技能多案例回归与路由诊断（2026-10-23）

环境：node12 `/local_data/huojianfan/med-pilotdeck`，`feat/multi-user-v2` / `98f208e`；隔离登录实例使用独立临时数据根、UI 4164、Gateway 19440 起始端口，日志确认 `[sandbox] bwrap (ok)`。未修改或重启正式 4020 实例。测试后已停止 4164 实例，其 Gateway PID 文件清空；测试数据与原始帧保留在隔离根。

## 原有 23 个场景

运行 `scripts/run-skill-e2e-multiuser.ts`：脚本报告 21 PASS、1 FAIL（影像科泛问句未调用 `read_skill`）、1 UNTESTABLE（`med-medical`）；无用户可见 home 绝对路径泄漏。原始 `results.json`、`baseline.md`、逐场景帧在 node12 仓库 `tests/skill-e2e/work/multiuser-2026-10-23T09-24-30-104Z/`。本轮未做浏览器实际页面路径验收，项目更新元数据路径仍要单独界定。

PDF、DOCX、PPTX、XLSX、流程图和网页演示均有交付产物，DOCX 具有最终 `exports/病例报告.docx`（不只是候选文件）；战创伤检索、救治方案、DICOM 路由和病例报告成功；RADAR/DeepChest 仅验证状态调用。PPTX、表格、流程图和网页演示虽 PASS，工具序列分别包含 2、2、1、3 次 `med_trauma_rag_query`；在这些“根据给定题目生成文件”的场景中属于值得减少的额外步骤，但本次没有证明它们必然错误（模型可能主观认为要查医学资料）。

**脚本误分类：** `med-medical` 被标为 UNTESTABLE，理由含“医学视觉模型服务不可用”、“未调用 `read_skill`”及“工具参数未引用批次目录”。检查实际帧：最初 `med_parse_medical` 由 `med-tools-skill-gate` 拦住，并**自动加载**了 `med-medical` 内容，之后模型调用影像路由，再次调用 `med_parse_medical({path:"ultrasound.dcm",continuation_mode:"material"})`。实际结果 `status=ready`、`vlm_ok=true`、`vlm_error=""`，报告约 2467 字符，回合完整结束。判“服务不可用”的正则错误匹配到了自动加载的技能说明中的 `MED_SPECIALIZED_CT_ENABLED`，不是服务报错。脚本只计显式 `read_skill`，遗漏自动门禁加载。**单份 DICOM 的解析成功；没有按原用例期望对 XML+DICOM 整个批次做一次解析，完整批量功能仍未验收通过。** 回答阅读过 XML 文本，不能冒充多文件医学工具批量解析。

## 补充对照（9 场景）

先前两次自写探针忘设 `PILOTDECK_E2E_SERVER`，HTTP 指向 4164 但 WebSocket 指向默认 3020；模型报 `fetch failed`。那两轮全部丢弃，**不计入**下表。修正端口并使用隔离账号后的帧及 `probe-results.json` 位于 node12 临时根 `/tmp/pd-task12-multicase.GuO27y/`；测试后隔离服务已退出。

| 场景 | 结果 | 归因 |
|---|---|---|
| 影像科泛问句重复 | 正常结束，工具调用 0；与完整回归相同 | 未加载技能；单独原用例另跑 1 次 `read_skill` 成功，存在波动 |
| 影像科具体报告征象 | `read_skill(med-role-radiology)` 成功 | 有具体征象时路由正常 |
| 明确要求影像科技能 | `read_skill` 成功 | 技能可加载 |
| 检验科泛问句重复、自然数值输入 | 两项均 `read_skill(med-role-laboratory)` 成功 | 这两轮未复现旧的漏选；不能证明长期稳定 |
| 表格普通题目 | `read_skill`、3 次医学 RAG，后续生成 XLSX | 路由/任务分解冗余，非 Linux bwrap 阻断 |
| 表格明确只排版不检索 | `read_skill`、0 次医学 RAG，生成 XLSX | 输入边界明确能减少额外调用 |
| 病例报告自然措辞 | `read_skill(med-case-report)` 成功 | 正常 |
| PPTX 明确只生成文件 | `read_skill`、0 次医学 RAG，最终 3 页 PPTX 71,584 字节；过程中有一次 `environment_issue`（命令把 `@app` 虚拟路径交给 `realpath`）及一次 `automation_policy_violation`（试图 `grep` 技能脚本），后续恢复交付 | 技能的路径示例与工具使用边界需要澄清；不能把最终产物归为全过程无错 |

额外验证：隔离用户的两个 XLSX 和 PPTX 均可用 ZIP 结构检查，PPTX 包含 3 页；两个 XLSX 分别有 1 和 3 个工作表。补充探针原始 `errors` 字段对非错误技能说明含“交付包不完整”等词产生误报；已按实际 `TOOL_ERROR` 和产物复核，表格两个场景无真实工具错误。

## 优先优化建议（本轮只诊断，未修改实现）

1. **先修验收脚本的误分类，再复跑医学附件案例。** 识别 `med-tools-skill-gate` 的自动加载；只从实际工具/错误结构判服务不可用，别扫描技能正文；区分“单份文件解析成功”与“按批次解析成功”。否则 Task 12 状态会被错误的 UNTESTABLE 掩盖。
2. **影像科角色路由：** 区分“仅询问一般阅片顺序”与“提供影像征象需要结构化解读”。当前 `med-role-radiology` 说明偏向已有征象，基线泛问句却断言必须 `read_skill`，先决定产品是否要让此泛问句触发技能；若要，调整说明/推荐或路由规则，并用多次有效样本验证。此轮同一泛问句 2 次跳过、1 次加载，具体征象与明确指定各 1 次加载。
3. **文档产物类路由：** 对仅按用户给定信息生成 PPTX/XLSX/SVG/HTML 的请求，优先相应生成技能，必要时才调用医学 RAG；不要抑制真正需要医学证据核查的内容。表格对照中 3 次 RAG 可在明确“只排版”时降至 0。
4. **PPTX 工具路径和策略边界：** 提醒 Agent 使用 `read_skill` 返回的实际技能路径和文档化入口，不将 `@app/...` 虚拟路径交给 `realpath`，也不通过 `grep` 源脚本取代技能说明；回归要记录中途错误、重试次数、页数与最终产物，而非只判是否出现 `.pptx`。
5. **检验科泛问句：** 本次与具体数值均加载成功，旧 macOS 回归有漏选；保留观察项，按“泛问句是否应强制进入此角色”确定预期，再以重复运行统计稳定性。

Task 12 完成标准、Task 9 浏览器路径检查尚未据此勾选；本次为真实 Gateway/bwrap 多案例诊断，不是所有技能、所有环境或医学内容准确性的完整验收。
