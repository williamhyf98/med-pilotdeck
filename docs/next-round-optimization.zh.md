# med-pilotdeck 下一轮优化：方案概览与两人分工

> 文档版本：2026-09-10
> 适用分支：各自开 `feat/*`，合入 `develop` 前跑通冒烟
> 关联文档：[`work-split-med-pilotdeck.zh.md`](./work-split-med-pilotdeck.zh.md)（分工格式）、[`workspace-project-types-phased.zh.md`](./workspace-project-types-phased.zh.md)（类型改造现状）、[`cross-case-long-term-memory-design.zh.md`](./cross-case-long-term-memory-design.zh.md)（记忆设计稿，未实现）、[`offline-deployment-plan.md`](./offline-deployment-plan.md)（离线化步骤 3–7 未开始）

本文用于**对齐 8 项待优化点的实现方式、工作量与依赖顺序**，并给出按「文件归属」切分的两人分工建议——核心目标是让两人不争抢同一批中枢文件。

---

## 1. 先纠正三条与实际代码不符的前提

这三条直接改变工作量估算，动手前需知晓：

| 原始描述 | 代码实际情况 | 影响 |
|---|---|---|
| 「增添自创 skill 的功能，需要调研如何实现」 | **已完整实现**。`src/extension/skills/SkillManager.ts`（1036 行）含 list/read/write/create/delete/validate/import/setAvailability 全套 CRUD，前端 `SkillsV2.tsx` 已有三栏 + 拖拽改归属。只是离线化步骤 2 把「New skill / ClawHub 导入」入口**隐藏**了（见 `offline-deployment-plan.md` §2.5） | 从 XL 降到 S。真正的缺口是入口恢复 + 多用户下的归属决策 |
| 「把战创伤 workspace 和 meta 分析 workspace 分开管理」 | **meta 分析类型完全不存在**，全库零代码（`meta-analysis` 仅出现在战创伤 RAG 语料正文里）。现有仅 `general_medicine` / `war_trauma` 两类 | 这一项 = 重构类型注册表 + **从零新建**第三种类型竖切 |
| 「多用户登录（看是否能直接 merge 嵌入）」 | 登录本身已有（JWT + bcrypt + `users` 表），但 `DISABLE_LOCAL_AUTH` 默认 true 直接跳过登录，`/register` 硬性 403 拒绝第二个用户。**真正的障碍不是登录，是数据隔离**：`PILOT_HOME` 在 `src/pilot/paths.ts:166` 由进程级环境变量一次性解析，gateway 在 `ui/server/pilotdeck-bridge.js:184` 是进程内单例 | 登录开关是 S，数据隔离是 L～XL。上游若有 platform 版可省掉前者，省不掉后者 |

补充事实：SQLite 侧 `api_keys` / `user_credentials` 表**已带 `user_id` 外键 + `ON DELETE CASCADE`**（`ui/server/database/init.sql`），数据库层本就是按用户分区的。缺口只在文件系统（`$PILOT_HOME`）和 gateway 这一层。

---

## 2. 8 项优化的实现方案

### 2.1 多用户登录（数据完全隔离）— L～XL

**方案（推荐 B 方案）：** 解除 `/register` 单用户限制并把 `DISABLE_LOCAL_AUTH` 默认转为 false（`ui/server/routes/auth.js`、`ui/server/constants/config.js`）；数据隔离**不改 `paths.ts`**，改为**每个登录用户一个独立 gateway 子进程**，各自带自己的 `PILOT_HOME=<root>/users/<userId>`，Express 侧把 `gatewayPromise` 单例换成按 JWT userId 索引的进程池（`ui/server/pilotdeck-bridge.js`）。

**为什么不选 A 方案（进程内多租户）：** 把 userId 穿透进 `paths.ts` 全部 `resolve*` 函数，需同步改手工维护的 JS 副本 `ui/server/utils/pilotPaths.js`、全部 REST 路由和 gateway 协议，且会与 §2.3、§2.4 争抢同一批文件。B 方案复用现有单租户引擎原样不动，代价是每活跃用户一个常驻进程（科室内 <20 人的场景完全可接受）。

**依赖：** 无。应最先做——它决定 §2.5 的 skill 存放位置和 §2.3 的记忆根目录。

---

### 2.2 PPT 更多风格主题（扩展现有 skill，不引入新工具）— S～M

**方案：** `skills/pptx/assets/layout-library/design-tokens.json` 目前只有一套 `colors` 调色板 + 一个 `canvas`（而 `typography` 里已有 6 套字体 profile 和 2 套密度 profile 的多变体先例）——把 `colors`/`canvas` 按同样方式扩成具名主题组，`scripts/pptx.sh` 增加 `--theme` 参数选择；同时把已有但未产品化的 `apply-template`（从用户 `.pptx` 继承样式，流程 inspect → validate-map → prepare-starter → apply-template → audit）做成前端可见入口，让医生上传本院模板。

**注意：** `skills/pptx/SKILL.md` 明确禁止改写 `assets/layout-library` 或自写 `.mjs` builder——扩主题要走 design-tokens 数据扩展，不是改 `layouts/core.mjs`。`skills/frontend-slides/` 的 3 套 HTML 预设（A 信息密 / B 高对比 / C 深色）在 `references/med-visual.md`，可同步补齐。

**依赖：** 无，完全独立，可随时开工。

---

### 2.3 病人专属项目目录 + 记忆提取逻辑 — L

**方案：** 分三块。

- **(a) 项目元数据加病人字段**——`meta.json` 增加 `patientId`/`patientName`，改 `ui/server/projects.js` 的 `createSystemProject()` 与前端 `SystemProjectCreateDialog.tsx` 表单。
- **(b) 记忆分类医疗化**——`edgeclaw-memory-core` 现有 4 种 record type（`user`/`feedback`/`project`/`general_project_meta`）扩为病例内分类（病史、过敏史、处置决策、时间线、待确认），改动集中在 `src/context/memory/edgeclaw-memory-core/src/core/types.ts` 的枚举，以及 `core/skills/llm-extraction.ts` 里那批硬编码 prompt 常量（`EXTRACTION_SYSTEM_PROMPT`、`PROJECT_NOTE_CREATE_SYSTEM_PROMPT` 等）。
- **(c) PHI 隔离**——在写 `memory/global/UserIdentity/` 的路径上加患者信息拦截，确保全局画像只沉淀「医生对系统的操作偏好」，患者事实绝不跨病例召回。

**范围控制：** 只做 `cross-case-long-term-memory-design.zh.md` 的 **Phase 0–1**（病例内隔离 + 病例内长期记忆）。Phase 2–4（跨病例经验卡、去标识化审核发布、clinical-memory MCP）本轮不做，否则单项会膨胀到 XL。

**依赖：** §2.1（记忆根目录要先确定是否落在 `users/<userId>/` 下）。

---

### 2.4 可插拔的 workspace 工作区类型 — L（框架）+ M（每新增一种类型）

**方案：** 把散落在 **7 处**的两值硬编码枚举收拢成单一类型注册表，改成注册表后侧栏 Tab 与主区组件按注册项动态渲染；然后**以 `src/trauma/` 那条竖切为范本**新建 `meta_analysis` 类型。

7 处枚举位置：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `src/pilot/paths.ts` + `ui/server/utils/pilotPaths.js` | `PROJECT_TYPE_KEYS` 权威定义 + 手工同步的 JS 副本 |
| 2 | `ui/server/projects.js` | `PROJECT_TYPES` / `PROJECT_TYPE_LABELS` / `CREATABLE_PROJECT_TYPES` / `ALLOWED_PROJECT_TYPES` |
| 3 | `ui/src/components/project-creation/SystemProjectCreateDialog.tsx` | `SYSTEM_PROJECT_TYPES` |
| 4 | `ui/src/components/app-shell/appShellSelection.ts` | `resolveProjectType` / `filterProjectsByType` |
| 5 | `ui/src/components/app-shell/SidebarV2.tsx` | 写死正好两个 Tab（i18n 在 `ui/src/i18n/locales/{zh-CN,en}/sidebar.json`） |
| 6 | `ui/src/components/main-content/view/MainContent.tsx` | `isWarTraumaProject` 二分路由 |
| 7 | `src/pilot/skillAvailability.ts` | 两个字面量的校验 |

**范本很完整，照抄即可：** 战创伤已经是「独立引擎目录 `src/trauma/` + 工厂注入（组合根 `src/cli/createLocalGateway.ts`）+ gateway 分派（`InProcessGateway.ts` 的 `isTraumaProject` → `traumaRunnerFactory`）+ 独立前端工作台 `ui/src/components/trauma-workspace/`」，本身就是可插拔的正确形态，缺的只是把「二分判断」换成「注册表查表」。

**依赖：** 建议在 §2.3 之后、或与之由同一人串行（两者都改 `projects.js` + `meta.json` 结构）。

---

### 2.5 自创 skill 功能（独立于用户账号）— S

**方案：** 恢复被离线化改造隐藏的入口即可（`SkillsV2.tsx` 的 New 按钮 + 后端 `SkillManager.create` 路由），CRUD 逻辑无需重写。**真正需要决策的是多用户下的存放位置**：现有用户级 skill 在 `$PILOT_HOME/skills/`，§2.1 按用户隔离 `PILOT_HOME` 后它会自动变成「每人一份」——而需求是「独立于用户账号」，所以需要新增一个不随用户走的系统级共享 skill 目录，并在 `PluginRuntime.collectSkillContributions()` 的去重优先级（现为 project > global > builtin）里插入这一层。

**依赖：** §2.1（共享目录的位置取决于多用户目录结构）。

---

### 2.6 国产化适配（信创系统 + 国产 CPU）— L

**方案：** 模型层基本无需改动——`src/model/catalog/providers.ts` 已内置 dashscope / deepseek / moonshot / zhipu / volc_ark / minimax，anthropic 与 openai 适配器基于 undici 手写 HTTP、不依赖厂商 SDK，接任何 OpenAI 兼容的国产 vLLM 只需加一段 yaml。真正的工作是**把 `offline-deployment-plan.md` 的步骤 3–7 做完，并把目标架构从 x86_64 扩到 ARM64**：

1. 去掉硬编码 IP `10.31.112.13`——目前仅存于 `plugins/med-tools/plugin.json`（`MED_VLM_API_BASE` / `MED_EMBEDDING_API_BASE` / `MED_EMBEDDING_ENDPOINT`）和 `scripts/dev-launcher.mjs`（`localNoProxyHosts`）两处
2. 统一现场配置入口 `config/deploy.env`
3. 生产启动脚本走预构建 `dist/` + `ui/dist/`，不起 Vite
4. 在麒麟/统信 + 鲲鹏/飞腾机器上重编译全部原生依赖并打包

需按架构重编译的原生依赖（见 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies`）：`better-sqlite3`、`node-pty`、`sharp`、`bcrypt`、`esbuild`、`protobufjs`、`unrs-resolver`，另加 `@vscode/ripgrep`、`mupdf`。

**好消息：** 代码跨平台性良好——`src/tool/builtin/bash`、`paths.ts`、`src/session/*` 都有完整 win32 处理，darwin 只在 `SnapshotCopyProvider.ts` 做 clonefile 优化且有 fallback，**无阻塞性平台依赖**。`offline-deployment-plan.md` 里写的「当前只保证 linux x86_64」是交付决策，不是代码限制。

**依赖：** 无（独立赛道），但最终打包验收建议放在功能改造收敛之后。

---

### 2.7 丰富 skills 池（科室医生角色 + 已有 skills 分类改装）— M

**方案：** 用 `SkillManager.buildInitialSkillContent()` 的脚手架 + 一份科室角色模板，按科室（心内 / 骨科 / 急诊 / 影像…）批量生成 skill 目录，通过 `SKILL.md` frontmatter 的 `availability` 字段绑定到对应 workspace 类型；同时给 frontmatter 增加 `category`/`department` 字段，让 `SkillsV2.tsx` 能按科室分组展示。

**⚠️ 这一项定义最模糊**：「以数据库类型来生成对应科室的医生角色」中的「数据库类型」需要先明确——是院内 HIS/LIS/PACS 的数据源类型，还是 RAG 语料的分科？动手前建议先写半页 spec，否则容易返工。

**依赖：** §2.4（若要绑定到新类型）。

---

### 2.8 根据 query 推荐 skill — M

**方案：** 仓库里已有现成范式可抄——`src/router/scenario/decideScenario.ts` 就是「按 query 分类选模型」，同一套思路改成「按 query 选 skill」。数据源现成：`PromptAssembler.formatSkills()` 已经在系统提示词里维护了全部 skill 的 name + description 摘要清单。建议分两档：先做**廉价版**（基于 description 的关键词匹配，前端在输入框下方给出推荐 chip，零额外 LLM 调用）；效果不足再升级为小模型分类调用。

**另可参考：** `src/tool/medToolsSkillGate.ts` 已实现「强制先 `read_skill` 再调 MCP 工具」的拦截式引导（`MED_TOOLS_SKILL_REQUIREMENTS` 硬编码映射），是推荐机制的反向补充。

**依赖：** 无。

---

## 3. 依赖关系与执行顺序

```text
§2.1 多用户隔离  ──┬──→ §2.3 病人目录+记忆 ──→ §2.4 可插拔类型 ──→ 新建 meta_analysis
（决定目录根结构） └──→ §2.5 自创 skill 归属

独立赛道（随时可开工，互不冲突）：
  §2.2 PPT 主题    §2.6 国产化打包    §2.8 skill 推荐
  §2.7 skills 池（若需绑定新类型则等 §2.4）
```

**必须串行的原因：** §2.1、§2.3、§2.4 都要动 `src/pilot/paths.ts` + `ui/server/utils/pilotPaths.js`（两份必须手工同步的副本）+ `ui/server/projects.js` + `meta.json` 结构。**这三项必须由同一人拥有**，否则合并冲突和「两份副本不同步」会持续踩坑。

---

## 4. 两人分工（按文件归属切分）

### 4.1 A 岗：中枢层（身份 · 路径 · 类型 · 记忆）

| 项 | 工作量 |
|---|---|
| §2.1 多用户登录 + 数据隔离 | L～XL |
| §2.3 病人专属目录 + 记忆改造（Phase 0–1） | L |
| §2.4 可插拔类型注册表 + 新建 meta_analysis 竖切 | L + M |

**独占文件：** `src/pilot/paths.ts`、`ui/server/utils/pilotPaths.js`、`ui/server/projects.js`、`ui/server/pilotdeck-bridge.js`、`ui/server/routes/auth.js`、`ui/server/constants/config.js`、`src/context/memory/**`、`src/cli/createLocalGateway.ts`、`src/gateway/client/InProcessGateway.ts`、`ui/src/components/app-shell/`、`ui/src/components/project-creation/`

### 4.2 B 岗：能力层与交付（skill · PPT · 信创）

| 项 | 工作量 |
|---|---|
| §2.6 国产化适配（信创 + ARM64 打包） | L |
| §2.2 PPT 主题扩展 | S～M |
| §2.5 自创 skill 入口恢复 | S |
| §2.7 skills 池扩充 | M |
| §2.8 query 推荐 skill | M |

**独占文件：** `skills/**`、`plugins/med-tools/**`、`src/extension/skills/`、`ui/src/components/main-content-v2/SkillsV2.tsx`、`src/context/prompt/PromptAssembler.ts`、`src/router/scenario/`、`scripts/`（打包）、`Dockerfile`、`config/deploy.env`

### 4.3 唯一的跨界接口：`src/pilot/skillAvailability.ts`

A 岗改类型注册表时会动这个文件的 `ProjectMetaType` 字面量校验，B 岗的 §2.5、§2.7 要消费它。**约定：A 岗先落地注册表并通知，B 岗在其之上开发**；在此之前 B 岗按现有两值枚举开发，不提前适配。

顺带说明：`src/pilot/projectTypePolicy.ts` 这个「按项目类型过滤 skill/tool」的扩展点**已存在但当前是空壳**——`isToolAvailableForProjectType()` 直接 `return true`，`isSkillAvailableForProjectType()` 对 med-tools skill 也直接放行。要做类型级能力隔离时从这里改，不用另起炉灶。

### 4.4 分支约定

各自开 `feat/*` 分支，合入 `develop` 前跑通冒烟；A 岗 §2.1 → §2.3 → §2.4 建议拆成独立 PR 串行合入，不要在同一提交里同时改身份层和类型层。

---

## 5. 需要提前拍板的点

| # | 待决事项 | 说明 |
|---|---|---|
| 1 | 多用户走 A 还是 B 方案 | 进程内多租户（改 `paths.ts`，工作量大但单进程）vs 每用户独立 gateway 子进程（复用现有引擎，每活跃用户一个常驻进程）。建议 B，需确认预期并发医生数与服务器内存 |
| 2 | 上游是否已有 platform 版多租户实现 | 代码里存在 `IS_PLATFORM` / `VITE_IS_PLATFORM` 的 bypass 分支，提示上游可能有托管版本。若能直接 merge 可大幅省掉 §2.1，值得先问 |
| 3 | §2.7 的「数据库类型」具体指什么 | 定义不清，建议先写半页 spec 再动手 |
| 4 | meta 分析 workspace 的业务流程 | 战创伤是「三站式编排 + 阶段门控」，meta 分析的对应流程（检索 → 筛选 → 提取 → 合并 → 森林图？）需要先有业务设计稿，否则 §2.4 后半段无从下手 |
| 5 | 信创验收机器何时到位 | ARM64 原生依赖重编译必须在目标架构真机或容器上做，这是 §2.6 的硬前置 |

> 沿用 `work-split-med-pilotdeck.zh.md` §3.2 的约定：**禁止把永久密钥写进文档仓库**，模型/embedding 的鉴权信息一律走 `config/deploy.env` 或私有渠道传递。

---

## 6. 验收标准

沿用 `workspace-project-types-phased.zh.md` §4 的最小冒烟模板，每项完成后至少执行：

```bash
npm run build                                    # 引擎 → dist/
cd ui && npm run build                           # 前端 → ui/dist/
./scripts/stop-local.sh && ./scripts/start-local.sh
npm test                                         # node --test dist/tests/**
```

各项专项验收：

| 项 | 验收方式 |
|---|---|
| §2.1 | 注册两个账号 → 各自建项目 → 互相看不到对方的项目 / 会话 / 记忆；登出再登入数据仍在 |
| §2.2 | 同一份内容用不同 `--theme` 生成两份 `.pptx`，视觉可辨且版式不塌；上传本院模板走通 `apply-template` |
| §2.3 | 建带 `patientId` 的项目 → 对话提及病史 / 过敏史 → 手动触发 Index → 检查 `memory/<typeKey>/<projectId>/` 生成对应分类文件，且 `memory/global/UserIdentity/` **不含**任何患者信息 |
| §2.4 | 新增第三种类型后侧栏出现第三个 Tab、可创建、目录落在 `projects/<新 typeKey>/`；原有两类项目回归正常 |
| §2.5 | 新建 skill → 切换用户 → 该 skill 仍可见（验证「独立于用户账号」） |
| §2.6 | ARM64 信创机器上解压 → 改 `deploy.env` 模型 URL → 启动 → 跑通一轮带附件对话；断外网抓包确认除模型 IP 外无出站 |
| §2.7 | 对话中触发科室 skill，`read_skill` 能读到完整内容；Skills 页按科室分组正确 |
| §2.8 | 输入典型 query 看到推荐 chip，点击后确实注入对应 skill |

---

## 7. B 岗实施记录（2026-09-11，分支 `feat/capability-layer`）

分支基于 `develop`，B 岗 5 项共用。**构建与测试需在服务器执行**——开发机无 `node_modules`，`npm run build` / `npm test` / `vitest` 均无法本地运行，本轮所有 TS/TSX 改动只经过人工审查，纯 JS 文件已 `node --check` 并直接跑通断言。

### §2.2 PPT 多主题（已完成）

`skills/pptx/assets/layout-library/design-tokens.json` 新增 `themes` 段，5 套主题：`clinical` / `academic` / `trauma` / `vital` / `mono`；`scripts/pptx_cli.mjs` 接 `--theme`。

按 `skills/pptx/SKILL.md` 的约束，**只做纯数据扩展**——未改 `layout-library` 里的 builder，未新增自定义 `.mjs`。新增主题 = 往 `themes` 加一段 token，版式复用既有布局。

### §2.5 自创 skill 入口恢复（已完成）

`SkillsV2.tsx` 的 New 按钮恢复，按 `availabilityMutable` 分权：`builtin` / `medical` 只读，`user` / `project` 可增删改。ClawHub 保持移除，没有引入公网通道。

顺带修掉一个潜在崩溃：原 `groupedSkills` 直接展开 `...skills.medical` 而没做 `?? []`，服务端字段缺失时白屏。

### §2.6 国产化适配（已完成代码侧去硬编码）

`plugins/med-tools/plugin.json` 的 `MED_VLM_API_BASE` / `MED_EMBEDDING_*` 改读环境变量，新增 `config/deploy.env.example`；`dev-launcher.mjs` 与 `start-local.sh` 在文件缺失时打印醒目警告。

> **部署侧待办：** 默认 host 已改为 `127.0.0.1`，现场必须 `cp config/deploy.env.example config/deploy.env` 并填真实模型地址（济南那台的历史取值见 [`jinan-model-config.zh.md`](./jinan-model-config.zh.md)），否则 med-tools 指向回环。按 `offline-deployment-plan.md` §3 的验收约定，真实 IP 不再写进本文。

ARM64 原生依赖重编译仍需在信创真机或容器上做（§5 待决第 5 条），本轮未覆盖。

### §2.7 丰富 skills 池（已完成）

`plugins/med-tools/skills/` 新增 6 个科室角色技能：`med-role-emergency` / `med-role-critical-care` / `med-role-orthopedics` / `med-role-radiology` / `med-role-laboratory` / `med-role-burn`。`plugin.json` 的 `"skills": "skills"` 是目录扫描，新增文件夹无需改清单。

新增可选 frontmatter 字段 `department` / `category`；`SkillManager.readSkillMeta()` 已透传，`/list` 整包转发，因此**不需要额外管道**。Skills 页据此出科室筛选条与徽标。

6 个 description 全部重写为**纯正向**表述——原先每条都带「不出固定模版病例报告（用 med-case-report）」这类反向交叉引用，会让「写一份病例报告」误召回 `med-role-burn`。反面说明已存在于各技能 body 的「不适用」段，不丢信息。4 个既有 `med-*` 技能未动，避免影响已验收的 agent 路由。

### §2.8 按 query 推荐 skill（已完成）

- `ui/server/utils/skillRecommend.js` — 纯 JS 打分器，零模型调用、零依赖。中文按相邻二字 bigram 索引，拉丁文按整段小写 token；权重走 IDF（在候选池内计算），字段权重 name 3 / department 2.5 / slug 2 / description 1；拉丁前缀匹配（`PPT` → `pptx`）；几何衰减 `0.65^i` 防止散词累积压过命中技能名；最终分 `1 - exp(-raw/5)` 有界饱和。
- `ui/server/utils/skillRecommend.test.js` — vitest，按仓库同目录 `*.test.js` 惯例。
- `POST /api/skills/recommend`（`ui/server/routes/skills.js`）— 沿用 `/list` 的 `isGeneralCwd` / `gatewayProjectKey` 处理，5 秒 TTL 缓存吸收连续击键；任何异常都返回空数组，绝不让推荐功能把错误抛到输入框上。
- `ui/src/components/chat-v2/SkillRecommendBar.tsx` — 350ms 防抖、输入 ≥4 字符才发请求、`AbortController` 取消在途请求；`ComposerV2` 新增三个**可选** props（`ChatInterfaceV2.layout.test.tsx` 会渲染 `ComposerV2`，必须可选）；`ChatInterfaceV2` 复用 `insertAtCursor` 注入，不抢焦点。

实测（对真实 16 技能语料）：胸痛→急诊、骨折→骨科、PEEP/ICU→重症、血气/乳酸→检验、CT/结节→影像、烧伤/补液→烧伤、野战分类场→分级救治；「导出成PPT」→ `pptx` 排第一；「今天天气怎么样」「你好」→ 零推荐。

> 调参过程中发现两处真实缺陷（非代码错误）：① 停用词表缺失时「怎么」在 16 条描述里出现 2 次被 IDF 误判为稀有，「今天天气怎么样」召回烧伤技能；② 散词累积让 `pdf` 压过 `pptx`。分别用停用词表和几何衰减修掉。默认阈值从 0.35 降到 0.25——噪声查询的得分是 **0** 而不是 0.2，高阈值只挡住了合法的单术语临床查询（如「胸痛」0.34）。
