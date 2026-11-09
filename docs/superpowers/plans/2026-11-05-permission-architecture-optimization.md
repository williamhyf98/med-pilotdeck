# 权限架构优化实施计划

> **给执行 Agent 的说明：** 必须使用 `superpowers:executing-plans` 技能，严格按照任务顺序执行。每个任务完成并通过验证后，才能开始下一个任务。

**目标：** 将 PilotDeck 的权限体系从“拦截危险操作”升级为“明确能力白名单 + 任务目录隔离 + 普通操作自动执行 + 管理员可配置命令和内网策略”，同时统一 Skill、MCP 和内置工具的文件产物管理。

**总体方案：** 保留自动化策略、工具权限、路径安全和操作系统沙箱四层，但重新划分职责。普通安全工具默认自动执行；不符合安全策略的操作直接拒绝；工具只能获得声明过的能力；Agent 只能访问当前任务的 `inbox`、`scratch`、`exports` 三个目录。管理员通过前端维护系统级命令策略和已登记服务地址，后端负责校验、保存、加载、热更新、连通性测试和审计。

**技术栈：** TypeScript、Node.js、Express、React、Vitest、YAML/JSON、现有 bubblewrap/macOS sandbox-exec、PilotDeck Tool/MCP/Artifact 架构。

**使用方式：** 本文件既是设计说明，也是后续任务清单。实现过程中直接勾选任务步骤，并在“当前进度”表中记录完成情况、测试结果和遗留问题。

## 全局约束

- 本轮不开放 Agent 自由撰写和执行 Python、Node、R、Shell 等代码。
- 本轮不支持用户自创 Skill 的自由代码执行。
- Agent、普通用户和用户 Skill 不能修改系统安全策略。
- 普通安全工具默认自动执行，不再通过权限弹窗询问用户。
- `ask_user_question` 只用于确认业务需求、输入参数和实现细节，不用于询问工具权限。
- Plan 模式只用于确认计划和目标，不作为权限询问模式。
- 网络默认拒绝；只允许系统服务注册表中的本机回环和远程功能服务地址。
- 管理员可以编辑已登记服务的地址和端口，但不能通过前端新增任意网络出口或自由填写网络白名单。
- Agent 只能访问当前任务的 `inbox`、`scratch`、`exports`。
- 最终用户产物必须位于当前任务的 `exports`。
- 安全配置文件位于 `$PILOT_HOME/system/security/`，不位于用户 workspace。
- 管理员配置只能通过服务端管理员 API 修改。
- 配置修改必须经过 schema 校验、原子写入、版本校验和审计。
- 不恢复、覆盖或删除与本任务无关的现有用户修改。

## 当前进度

| 任务 | 状态 | 说明 |
|---|---|---|
| 任务 1：权限模型和职责边界 | 已完成 | 首批工作区检查和文档 Skill 子命令范围已确认；医学 MCP 入口在任务 8 逐项登记 |
| 任务 2：安全策略配置和加载 | 已完成 | 命令仅默认启用受限工作区检查和内置文档业务子命令；网络默认拒绝。严格解析、共享路径、原子保存和 revision 校验 |
| 任务 3：Bash 允许命令执行 | 已完成 | Agent Bash 接入注册能力、逐项参数表和结构化 argv；受限检查不启动 shell；全量 TS 测试 795 通过、2 跳过 |
| 任务 4：任务目录访问隔离 | 已完成（Agent/注册文档命令） | 文件工具、搜索、计划和长结果收敛到三目录；注册命令无 OS 沙箱时拒绝执行；全量 TS 测试 806 通过、2 跳过 |
| 任务 5：默认自动执行和模式语义 | 已完成（内置工具） | Agent 任务内已登记普通内置工具自动执行；管理员 deny、工具安全检查和 Plan 限制仍生效；MCP 登记留待任务 8 |
| 任务 6：网络策略执行 | 已完成（审计留任务 12） | 已完成系统服务注册、统一 HTTP/MCP/Office/模型请求校验、重定向复核和私有地址检查；结构化审计留待任务 12 |
| 任务 7：统一文件产物契约 | 已完成（基础契约） | 工具结构化 artifacts 已校验、规范化并进入结果与会话产物链路；既有 Skill/MCP 的逐项声明迁移留待任务 8/11 |
| 任务 8：MCP 能力和文件边界接入 | 已完成 | 现有医学 MCP 已逐项登记能力；输入路径、输出产物和未登记工具均受统一边界约束 |
| 任务 9：管理员安全设置页面 | 已完成 | 增加“内网服务”与“允许命令配置”页面，并让地址修改进入真实配置来源和网关热加载 |
| 任务 10：简化资源配额 | 已完成 | 集中实现前台超时、实时输出上限、scratch 配额和任务级子进程并发限制；全量测试 842 项中 840 通过、2 跳过 |
| 任务 11：既有 Skill/MCP 迁移 | 已完成 | 文档 Skill 的 JSON 路径输出和医学 MCP 结构化产物统一进入任务级 artifact 契约，保留旧版兼容回退；专项 27/27，通过全量回归 |
| 任务 12：集成验收和离线部署文档 | 已完成 | 增加离线部署验收测试和备份、恢复、平台沙箱运维说明；专项 5/5，最终全量回归结果已记录在进度台账 |

## 允许命令的待确认建议

> 首批范围已确认：工作区受限检查、列出的文档 Skill 业务子命令，以及后续逐项审核的医学 MCP 入口；不开放任意 Bash。任务 2/3 已使缺省配置启用内置受限检查和文档业务子命令，管理员配置只可缩小范围；网络策略仍默认拒绝，但其运行时执行留待任务 6。医学 MCP 的具体能力映射在任务 8 登记，不能作为任意 Bash 命令启用。

这一部分是本轮必须先确定的关键决策。

### 1. 核心原则

不建议把管理员配置做成“任意填写可执行文件路径和 shell 字符串”。即使管理员可信，也会导致：

- 配置难以审计；
- `bash -c`、`python -c`、`node -e` 等间接执行容易被放入配置；
- 一个宽泛命令配置可能重新获得整个用户目录权限；
- 配置文件本身变成新的任意代码执行入口。

因此，允许命令配置应当是“注册能力配置”，而不是“任意命令配置”：

```text
系统预注册命令能力
    ↓
管理员在前端启用或配置安全参数
    ↓
Agent 只能调用已启用的命令能力
```

管理员可以增加“安全命令配置”，但不能关闭系统硬性禁止规则，也不能把普通命令变成任意 shell。

### 2. 第一阶段建议允许的 Bash 操作

#### A. 工作区只读检查

这些操作只允许访问当前任务目录，不能访问绝对路径、其他 workspace 或 `$PILOT_HOME`：

| 命令能力 | 用途 | 约束 |
|---|---|---|
| `workspace.pwd` | 查看当前任务根目录 | 不接受路径参数 |
| `workspace.list` | 列出任务目录内容 | 只能列出 `inbox`、`scratch`、`exports` |
| `workspace.stat` | 查看文件大小、时间和类型 | 路径必须位于三个任务目录 |
| `workspace.find` | 查找任务目录内的文件 | 禁止跟随符号链接，限制深度和结果数量 |

实际实现中，`read_file`、`glob`、`grep` 等已有内置工具应优先承担读取和搜索职责。Bash 只保留确实需要 shell 的检查能力，避免重复暴露。也就是说，`cat`、`grep`、`find` 等原始命令不应成为管理员任意开启的通用能力，而应由受限的工作区检查能力承载。

#### B. 已注册的文档和图表入口

当前仓库已经存在专用入口脚本。这些入口可以保留，但必须作为“注册工具能力”处理，而不是开放通用 `bash`：

| 能力 | 当前入口 | 第一阶段允许的操作 |
|---|---|---|
| PDF | `skills/pdf/scripts/pdf.sh` | `make`、`inspect`、`audit`、`render`、`merge`、`split`、`rotate`、`forms-inspect`、`forms-fill` |
| DOCX | `skills/docx/scripts/docx.sh` | `make`、`inspect`、`edit`、`review`、`finalize`、`compare`、`sanitize`、`render`、`convert-pdf`、`refresh-toc`、`validate`、`audit`、`preflight`、`deliver`、`resolve-latest` |
| PPTX | `skills/pptx/scripts/pptx.sh` | `make`、`themes`、`convert`、`inspect`、`audit`、`render`、`validate-map`、`prepare-starter`、`apply-template`、`fidelity`、`deliver` |
| 表格 | `skills/spreadsheets/scripts/spreadsheet.sh` | `make`、`inspect`、`audit`、`render`、`convert-legacy`、`recalculate`、`deliver` |
| 图示 | `skills/diagram-maker/scripts/diagram.sh` | `make` |

这些入口内部调用预装的 Python 或 Node 运行时，但外部只允许调用已注册的入口和已注册的子命令。入口脚本内部使用解释器是系统实现细节，不等于向 Agent 开放 Python 或 Node。

建议将以下操作划为“系统维护或管理员专用”，不作为普通 Agent 命令：

- `check`：检查部署环境和依赖是否完整；
- `self-test`：运行 Skill 自测；
- `bootstrap-runtime`：创建虚拟环境或准备依赖；
- `fix`：修复或安装运行时。

普通 Agent 只调用面向业务的生成、检查、转换、渲染和交付操作；部署维护操作由安装流程或管理员工具执行。

以下入口操作不应开放给 Agent：

- `bootstrap-runtime`；
- `fix`；
- `pip install`、`npm install`、`npm ci`；
- 修改运行时依赖；
- 修改技能源代码；
- 直接调用入口脚本内部使用的 Python/Node；
- 任意未登记的脚本参数或输出路径。

#### C. 医学专用入口

医学 MCP 或现有医学流程中的命令，需要逐个登记为专用能力，例如：

```text
medical.parse
medical.deepchest
medical.preview
medical.export
```

不能因为它们是医学工具，就自动获得任意 shell、任意路径或任意网络访问。

### 3. 第一阶段明确禁止的命令

以下内容继续作为系统硬禁止，不允许管理员通过前端配置打开：

- `python`、`python3`、虚拟环境中的任意 Python 解释器；
- `node`、`nodejs`、`bun`、`deno`、`tsx` 等 JavaScript 运行时；
- `Rscript`、`ruby`、`perl`、`julia`、`php`、`java` 等通用解释器；
- `bash -c`、`sh -c`、`zsh -c`、`eval`、`source`；
- heredoc、命令替换、反引号、管道、重定向和后台执行；
- `npm`、`npx`、`pnpm`、`yarn`、`pip`、`uv`、`poetry`；
- `curl`、`wget` 和其他未经过统一网络策略的下载工具；
- 任意绝对路径可执行文件；
- `chmod`、`chown`、`sudo`、`systemctl`；
- 删除系统目录、用户目录或其他项目的命令；
- 修改 Skill、MCP、系统配置和权限配置的命令。

后续如果实现受控数据分析执行器，可以在专用工具内部使用预装 Python，但不改变上述 Bash 规则。

### 4. 管理员“允许命令配置”页面的实际含义

页面第一阶段建议提供：

- 系统预注册命令能力的启用/禁用；
- 每个命令的参数范围；
- 输入路径类型；
- 输出路径类型；
- 是否只读；
- 是否允许写入 `scratch` 或 `exports`；
- 超时时间；
- 是否允许访问已配置的内网服务。

页面不提供：

- 任意可执行文件路径输入；
- 任意 shell 字符串输入；
- `bash -c`、`python -c` 等命令组合；
- 依赖安装；
- 关闭硬禁止规则的开关。

这样既能让管理员可视化管理允许能力，也不会把配置文件变成新的自由代码执行入口。

## 四层权限职责

### 第一层：自动化安全策略

负责判断操作是否属于系统明确允许的能力：

- 命令必须匹配注册命令；
- 路径必须匹配任务目录；
- 网络必须匹配网络策略；
- 硬禁止规则永远优先；
- 不符合规则时直接拒绝，不请求用户确认。

### 第二层：工具执行决策

负责决定已通过安全策略的工具是否可以执行：

- 普通注册工具自动执行；
- 不安全工具直接拒绝；
- `ask_user_question` 只收集业务信息；
- `plan` 只确认任务目标和计划；
- 不再把“是否允许工具执行”交给用户逐次确认。

### 第三层：路径安全

负责限制工具可以看到和修改的文件：

```text
inbox/       用户输入，只读
scratch/     中间过程，可写
exports/     最终结果，可写
```

禁止访问：

```text
其他 workspace
其他用户目录
memory/
projects/
logs/
plugins/
skills/
.pilotdeck/
系统配置目录
```

必须防止绝对路径、`..`、符号链接和路径大小写变化造成越界。

### 第四层：操作系统沙箱

负责在进程层面提供最后边界：

- 任务目录之外不可写；
- 默认无网络；
- 应用代码和系统运行时只读；
- 进程随任务结束退出；
- 限制超时、输出、磁盘和子进程数量。

当前 bubblewrap 的用户 home 可写范围需要收紧到当前任务目录。macOS `sandbox-exec` 需要保留平台限制说明，并进行实际验收。

## 文件结构和涉及模块

### 运行时安全模块

- 创建 `src/security/policy/types.ts`：命令、网络、任务根目录和资源限制类型。
- 创建 `src/security/policy/paths.ts`：系统安全配置文件路径。
- 创建 `src/security/policy/PolicyStore.ts`：读取、缓存、校验、版本和原子更新。
- 创建 `src/security/policy/parseCommandPolicy.ts`：命令策略校验。
- 创建 `src/security/policy/parseNetworkPolicy.ts`：网络策略校验。
- 修改 `src/tool/protocol/types.ts`：增加任务根目录、能力和结构化产物上下文。
- 修改 `src/tool/automationPolicyConstraints.ts`：接入统一命令策略。
- 修改 `src/tool/builtin/bash.ts`、`src/tool/builtin/bash/permissions.ts`、`src/tool/builtin/bash/commandRunner.ts`：执行注册命令和任务限制。
- 修改 `src/tool/builtin/filesystem/pathSafety.ts`、`src/tool/builtin/filesystem/writePermissions.ts`：强制三个任务目录。
- 修改 `src/tool/builtin/bash/sandbox/bwrap.ts`、`src/tool/builtin/bash/sandbox/sandboxExec.ts`：收紧沙箱挂载。
- 修改 `src/mcp/runtime/PluginToToolBridge.ts`：接入 MCP 能力、路径和产物契约。
- 修改 `src/session/artifacts/FileArtifactCollector.ts`、`src/session/artifacts/FileArtifact.ts`：支持结构化产物。

### 服务端和管理员 API

- 创建 `ui/server/services/securityPolicy.js`：读写系统安全策略。
- 创建 `ui/server/routes/securityPolicy.js`：管理员专属策略 API。
- 修改 `ui/server/apiRouter.js`：挂载 `/api/security-policy`。
- 增加策略热加载或独立 watcher。
- 增加服务端权限、版本冲突、配置校验和回滚测试。

### 管理员前端

- 修改 `ui/src/components/settings/types.ts`。
- 修改 `ui/src/components/settings/view/SettingsSidebar.tsx`。
- 修改 `ui/src/components/settings/view/SettingsContent.tsx`。
- 创建内网白名单页面。
- 创建允许命令配置页面。
- 修改中英文设置翻译。
- 增加管理员页面测试。

## 任务 1：确定权限模型和能力边界

**文件：**

- 创建 `src/security/policy/types.ts`。
- 修改 `src/tool/protocol/types.ts`。
- 必要时修改 `src/permission/protocol/types.ts`。
- 测试 `tests/security/policy-types.spec.ts`。

**实现内容：**

- 定义 `PilotDeckTaskRoots`。
- 定义 `PilotDeckCapability`。
- 定义 `PilotDeckToolArtifact`。
- 定义 `PilotDeckPolicyDecision`。
- 明确普通工具自动执行、策略违规直接拒绝。
- 明确用户 allow 规则不能授予系统未声明的能力。
- 保持 `permissions.json` 的兼容性，但不让它定义命令执行和网络出口。

**实施边界：** 本任务只为主动声明 `capabilityPolicy` 的工具接入强制能力门槛；现有工具尚未迁移，保持原来的权限行为。命令/网络能力只有被系统注册后才可执行；任务 2 接入管理员配置，任务 3/4/5/8/11 迁移 Bash、文件工具、MCP 和模式语义。在完成这些迁移前，不能声称全系统已实现能力白名单或任务目录隔离。

**任务 1 记录：** 增加 `PilotDeckTaskRoots`、`PilotDeckCapability`、`PilotDeckToolArtifact`、`PilotDeckPolicyDecision`；工具可声明所需能力，`PermissionRuntime` 在用户规则和 bypass 模式之前校验声明与系统注册。普通已声明能力自动执行，管理员 deny 和 Plan 限制仍生效。现有 `PermissionRuntime` 启动时尚未接入系统策略；本任务没有启用新命令。验证：`npm test` 755 通过、2 跳过、0 失败；`tsc --noEmit` 通过。

- [x] 编写类型和能力范围测试。
- [x] 编写非法能力值和未声明能力测试。
- [x] 确认能力模型本身没有开放任意代码执行；旧工具的执行边界留待后续任务收紧。
- [x] 确认首批工作区检查和文档 Skill 子命令范围，以及医学入口必须逐项登记；具体医学 MCP 映射在任务 8 完成。

## 任务 2：新增系统级安全策略文件

**文件：**

- 创建 `src/security/policy/paths.ts`。
- 创建 `src/security/policy/PolicyStore.ts`。
- 创建 `src/security/policy/parseCommandPolicy.ts`。
- 创建 `src/security/policy/parseNetworkPolicy.ts`。
- 测试 `tests/security/policy-store.spec.ts`。
- 测试 `tests/security/command-policy.spec.ts`。
- 测试 `tests/security/network-policy.spec.ts`。

**配置文件：**

```text
$PILOT_HOME/system/security/command-policy.yaml
$PILOT_HOME/system/security/network-policy.yaml
```

**命令策略要求：**

- 默认模式为 `registered_only`。
- 配置项引用系统注册的命令能力。
- 不允许通过配置关闭硬禁止规则。
- 每条命令声明可用参数、输入目录、输出目录、写入能力、网络能力和超时时间。
- 运行时优先使用结构化 argv，不把配置拼成任意 shell 字符串。

**网络策略要求：**

- 默认模式为 `deny`。
- 每条规则包含 host 或 CIDR、端口、协议、用途和启用状态。
- 拒绝无效 CIDR、公共网络全开放、空 host 和非法端口。
- 模型服务、内网 MCP 和其他服务必须显式登记。

**本阶段实现记录：** 命令配置只能引用系统内置能力 ID，不能填可执行路径或任意 shell；缺省启用受限工作区检查和内置文档业务子命令，管理员可以禁用或收紧；网络策略基础配置默认不开放任何规则。任务 3 已登记并校验各子命令的参数类型和部分枚举值；自由文本仍交给受控 Skill 的声明式输入解析。医学 MCP 不映射为通用 Bash，在任务 8 独立登记。任务 6 将把模型、RAG、RADAR、DeepChest、MCP、Office Renderer 等系统配置中的服务地址汇总为已登记服务，而不是让管理员自由新增网络规则；运行时必须校验实际目标和重定向目标。尚未实现运行时网络拦截。

- [x] 实现严格解析和默认值。
- [x] 实现临时文件加 rename 的原子写入。
- [x] 无效配置不能替换上一份有效配置。
- [x] 增加 revision/hash，防止管理员页面覆盖外部修改；跨进程的极短竞态仍需在任务 9 的管理员写入通道统一处理。
- [x] 测试无效 YAML、过宽网络规则和配置回滚。

## 任务 3：将 Bash 改为注册命令模式

**文件：**

- 修改 `src/tool/automationPolicyConstraints.ts`。
- 修改 `src/tool/builtin/bash/permissions.ts`。
- 修改 `src/tool/builtin/bash.ts`。
- 修改 `src/tool/builtin/bash/commandRunner.ts`。
- 修改文档 Skill 入口注册代码。
- 测试 `tests/tool/builtin/bash/command-policy.spec.ts`。
- 测试 `tests/tool/builtin/bash/commandRunner.spec.ts`。

**实现思路：**

- 保留 `bash` 工具名，避免破坏现有协议。
- 增加命令策略评估，返回允许、拒绝、规范化 argv 和匹配的命令能力。
- 对普通 Bash 只接受受限的单命令语法。
- 拒绝管道、重定向、命令替换、环境变量注入、嵌套 shell 和后台执行。
- 对 PDF、DOCX、PPTX、表格、图示入口使用专用注册能力。
- 保留硬禁止规则作为第二道防线。

- [x] 注册工作区检查命令（Node API 限定任务根目录、深度、结果数，不执行原始 `find`）。
- [x] 注册现有 PDF、DOCX、PPTX、电子表格和图示业务入口；维护子命令不开放。
- [x] 为业务子命令登记可用参数、输入输出路径类型及可枚举的值域；拒绝未登记或重复选项、解释器源文件输入和原地替换源文件开关。
- [x] 未注册命令直接拒绝；用户 allow、bypass、PreToolUse 改写不能绕过注册表；执行前再次校验配置。
- [x] 测试 `;`、`&&`、`|`、`>`、`$()`、反引号、`env`、`source`、`bash -c`、路径与符号链接越界。
- [x] 更新文档 Skill 指引；真实图示生成和全量 TypeScript 测试通过。

**任务 3 记录：** Agent 的 `bash` 保留工具名，但只运行系统注册的单命令能力。文档脚本使用固定安装路径、结构化 argv 和受限子进程环境；工作区检查不启动进程；管理员策略每次调用读取并在实际执行前复核。PreToolUse 和 PermissionRequest 修改输入后还会复核模式、schema 和自动化限制。全量 TypeScript 测试 797 项中 795 通过、2 跳过，类型检查通过；真实 `diagram.sh make` 已生成 SVG。本机 PDF、DOCX、PPTX、电子表格的 `check` 返回依赖未就绪，无法在此环境做真实产物验收；完整离线交付包需另行验证。`NodeShellCommandRunner.run` 仍为供内部代码使用的旧 API，Agent Bash 不再调用；尚不能认为整个系统已实现任务目录隔离：其他文件工具、OS 沙箱授权范围、文档 spec 内嵌路径、运行时网络与产物契约分别留待任务 4/6/7/11。

## 任务 4：限制 Agent 只能访问任务目录

**文件：**

- 修改 `src/tool/protocol/types.ts`。
- 修改 `src/tool/builtin/filesystem/pathSafety.ts`。
- 修改 `src/tool/builtin/filesystem/writePermissions.ts`。
- 必要时修改 `src/pilot/paths.ts`。
- 修改 `src/tool/builtin/bash/commandRunner.ts`。
- 修改 `src/tool/builtin/bash/sandbox/bwrap.ts`。
- 修改 `src/tool/builtin/bash/sandbox/sandboxExec.ts`。
- 测试文件工具、Bash 沙箱和多用户隔离。

**任务目录：**

```text
task.inbox       workspace/inbox       只读
task.scratch     workspace/scratch     可写，中间文件
task.exports     workspace/exports     可写，最终文件
```

- [x] 统一解析三个任务根目录。
- [x] Agent 文件工具使用同一个路径解析器；系统内部直接调用保留原边界。
- [x] Agent 普通文件路径拒绝绝对路径、`..`、符号链接和跨 workspace；已登记附件仅精确只读。
- [x] 注册文档 Bash cwd 和 OS 沙箱只暴露当前任务三目录；无 OS 沙箱时拒绝注册文档执行。
- [x] 医学服务的受控派生文件写入保留为系统服务能力，不开放给 Agent 任意编辑。
- [x] 验证附件只读、文档图示真实输出、搜索和多任务隔离的本机回归；医学 MCP 写入与完整离线包验收留待任务 8/11/12。

**任务 4 记录：** Agent 上下文强制携带 `taskRoot`，文件读写和搜索限于当前任务 `inbox`、`scratch`、`exports`；计划和长结果迁入 `scratch`。macOS `sandbox-exec` 实际运行图示并验证不能读取同一 home 的其他任务；Linux bwrap 的任务授权有单元测试，生产多用户验收仍待任务 12。缺失 OS 沙箱时注册文档命令拒绝执行，旧内部 `run()` 未迁移。医学 MCP 与其他内部子进程尚未应用此边界，按任务 8/11 处理。旧 `.pilotdeck/plans` 和 `.pilotdeck/tool-results` 未自动迁移，已有会话历史兼容性需在任务 11 验证。全量 TypeScript 测试 808 项中 806 通过、2 跳过；`git diff --check` 通过。

## 任务 5：调整权限和模式语义

**文件：**

- 修改 `src/permission/decision/PermissionRuntime.ts`。
- 修改 `src/permission/settings.ts`。
- 修改 `ui/server/services/permissionSettings.js`。
- 必要时修改 `src/tool/execution/ToolRuntime.ts`。
- 增加权限运行时测试。

- [x] 任务内已登记的普通内置工具自动执行，不产生权限弹窗。
- [x] 策略违规仍然直接拒绝；工具显式 `ask` 不自动升级为许可。
- [x] `ask_user_question` 使用业务 elicitation，不依赖权限批准。
- [x] Plan 模式维持计划语义与文件写入边界，不显示内置工具权限询问。
- [x] 保留管理员级别 deny 规则。
- [x] 更新前端中英文权限说明，移除“无限制系统访问”的错误表述。

**任务 5 记录：** 自动执行仅覆盖明确登记的 Agent 内置工具；不带 Agent `taskRoot` 的内部调用维持既有行为，MCP 等动态工具尚未迁入自动执行，待任务 8 逐项登记。旧 `skipPermissions` 字段保持兼容，缺省值在 TypeScript 和 Web 服务端统一。全量 TypeScript 测试 811 项中 809 通过、2 跳过；前端类型检查通过。管理员页面中的旧“允许 Shell 命令”列表仍需在任务 9 整理为注册能力配置；网络限制待任务 6。

## 任务 6：系统服务地址注册与外网隔离

**文件：**

- 创建或修改 `src/network/` 下的网络策略和系统服务注册模块。
- 修改 `src/tool/builtin/bash/commandRunner.ts`。
- 修改 `src/mcp/client/McpClient.ts`。
- 必要时修改 `src/mcp/runtime/McpRuntime.ts`。
- 修改其他具备网络能力的内置工具。
- 增加网络策略测试。

**实现思路：**

- 系统启动时从规范化系统配置中收集当前依赖的服务地址，建立稳定的服务 ID、名称、用途、协议、主机和端口。
- 首批服务包括模型服务、RAG、RADAR、DeepChest、远程 MCP、Office Renderer 及其他已经存在于系统配置中的功能服务。
- 已登记的本机回环服务和远程功能服务可以访问；未登记的地址默认拒绝。
- 不允许 Agent、Skill、MCP 或工具输入动态增加可信地址。
- HTTP、MCP 和其他网络客户端连接前检查服务 ID、host、port 和 protocol。
- HTTP 重定向后的目标必须重新匹配已登记服务；不能借重定向访问其他公网地址。
- 子进程默认不联网；只有明确属于已登记网络服务的受控能力才允许网络访问。
- 不把“禁止 curl”当成网络安全边界；网络边界必须由客户端检查和运行环境共同保证。
- 不向任务进程传递无关环境变量和密钥。

- [x] 启动时从模型、医学服务环境变量、Office Renderer 和 HTTP MCP 配置加载系统服务注册表；请求阶段区分并校验本机回环和私有远程服务。
- [ ] 管理员编辑已登记服务地址后安全保存、热更新，并让后续请求使用新配置。
- [ ] 实现服务级连通性测试和最小健康检查。
- [ ] 测试允许的本地模型、RAG、RADAR、DeepChest 和远程 MCP 服务。
- [x] 测试禁止未知公网地址、未知端口、禁用服务、公共 DNS 解析结果和重定向地址。
- [ ] 记录网络拒绝、服务测试和配置变更审计信息。

**任务 6 当前记录：**

- `src/network/serviceRegistry.ts` 已建立稳定服务 ID，并从模型配置、医学服务环境变量、Office Renderer 和 `streamable_http` MCP 配置收集可信服务。
- `NetworkAccessController` 默认拒绝未登记目标；仅允许登记服务的协议、主机和端口，且域名解析结果必须全部落在本机回环或私有地址范围内。
- `networkFetch` 已在请求前和每次 HTTP 重定向后重新执行策略检查，并返回结构化的 `network_policy_denied` 错误。
- 模型 HTTP 请求、Google 模型请求、HTTP MCP 和 `office_to_pdf` 已接入统一网络入口；MCP 服务在运行时登记后才能访问。
- 验证结果：`npm test` 构建成功，817 项测试中 815 项通过、2 项跳过、0 项失败。此前 `office_to_pdf` 测试因测试替换的 `fetch` 未传入统一入口而失败，已修复并通过回归。
- 当前边界：stdio MCP 和医学 Python 子进程属于受信任的内部插件，尚未实现操作系统级的细粒度外联控制；任务 8/11 继续登记其能力并在任务 12 做离线部署验收。管理员服务编辑、连接测试和配置变更审计由任务 9/12 实现。

## 任务 7：建立统一文件产物契约

**文件：**

- 修改 `src/tool/protocol/types.ts`。
- 修改 `src/session/artifacts/FileArtifact.ts`。
- 修改 `src/session/artifacts/FileArtifactCollector.ts`。
- 修改工具结果规范化逻辑。
- 测试文件产物收集和对话附件展示。

**契约：**

```ts
type PilotDeckToolArtifact = {
  path: string;
  role: "final" | "intermediate";
  mimeType?: string;
  description?: string;
};
```

**规则：**

- `final` 只能位于 `exports/`。
- `intermediate` 可以位于 `scratch/`，不作为最终附件。
- `inbox/` 是输入目录，不能声明为新建最终产物。
- 绝对路径和 workspace 外路径拒绝。
- 优先使用工具显式返回的产物，工作区扫描只作为兼容兜底。

- [x] 在工具执行结果中加入结构化 `artifacts`，并由 `ToolRuntime` 统一传递。
- [x] 统一校验和规范化产物路径：只接受相对任务路径，要求文件已存在且为普通文件。
- [x] 明确最终产物和中间产物：`final` 只能位于 `exports/`，`intermediate` 只能位于 `scratch/`。
- [x] 确保 scratch、QA、`.pilotdeck`、derived 等内部文件不被展示为最终文件。
- [x] 测试重复路径、缺失文件、绝对路径、输入目录和非法输出位置。

**任务 7 当前记录：**

- 新增 `normalizeToolArtifacts`，在工具结果离开执行边界前完成路径、角色、文件存在性、重复声明和描述字段校验。
- `FileArtifactCollector` 优先读取结构化 `artifacts`；只有旧工具未声明时，才继续使用 `content.file`、文档脚本 JSON 和工作区扫描兼容兜底。
- `FileArtifact` 增加可选 `description`，最终产物可携带稳定的 MIME 类型和说明；中间文件不会进入用户最终文件卡片。
- `office_to_pdf` 已声明 PDF 为 `final` 产物，保留旧 `content.file` 以兼容已有调用方。
- 验证结果：任务专项测试 26/26 通过；`npm --prefix ui run typecheck` 通过；全量 `npm test` 构建成功，823 项测试中 821 项通过、2 项跳过、0 项失败。
- 当前边界：PDF、DOCX、PPTX、表格、图示脚本以及医学 MCP 的逐项结构化产物声明仍需要在任务 8/11 迁移；它们暂时由兼容解析和工作区扫描承接。

## 任务 8：让内部 MCP 接入统一能力和产物契约

**文件：**

- 修改 `src/mcp/runtime/PluginToToolBridge.ts`。
- 修改 `src/mcp/protocol/types.ts`。
- 修改 `src/mcp/runtime/McpRuntime.ts`。
- 必要时修改 `ui/server/services/mcpConfig.js`。
- 增加 MCP 作用域和产物测试。

**本轮处理原则：**

- 当前一方 MCP 视为可信内部插件。
- 本轮不专门阻止内部 MCP 启动子进程。
- MCP 仍必须声明只读、写入、网络和产物能力。
- MCP 返回的文件路径必须经过任务根目录校验。
- MCP 不能通过内部子进程绕过统一路径、网络和产物契约。

- [x] 为现有 MCP 工具补充能力默认值。
- [x] 为医学解析的 managed derived 数据增加明确例外。
- [x] 拒绝 workspace 外 MCP 输出。
- [x] 测试 MCP 生成中间文件、最终文件和越界文件。

**任务 8 记录：** 系统侧逐项登记了 `med-tools` 和 `mineru-ingest-tools` 的只读、任务目录读写、可信服务和产物能力；未登记的 MCP 工具在权限检查和直接执行边界均拒绝。MCP 输入中的常见路径字段（包括路径数组和嵌套文档项）统一限制在当前任务允许的 `inbox`、`scratch`、`exports` 根目录，并拒绝越界、缺失输入和符号链接路径。最终产物只能从 `exports/` 进入结构化 `final`，中间产物只能从 `scratch/` 进入结构化 `intermediate`；医学插件的受控派生目录仅作为 `managed_derived` 内部材料，不直接暴露为用户最终附件。项目级 MCP 配置不能覆盖同名的系统登记医学服务器，未登记的动态 MCP（例如可选 `browser-use`）仍保持拒绝。内部 stdio MCP 继续视为可信插件，其子进程网络隔离留待离线部署验收进一步确认。MCP 专项 46 项通过；全量测试 833 项中 831 项通过、2 项跳过、0 项失败；构建通过。

## 任务 9：增加管理员安全设置页面

**文件：**

- 创建 `ui/server/services/securityPolicy.js`。
- 创建 `ui/server/routes/securityPolicy.js`。
- 修改 `ui/server/apiRouter.js`。
- 修改 `ui/src/components/settings/types.ts`。
- 修改 `ui/src/components/settings/view/SettingsSidebar.tsx`。
- 修改 `ui/src/components/settings/view/SettingsContent.tsx`。
- 创建“内网服务”页面。
- 创建允许命令配置页面。
- 修改中英文设置翻译。
- 增加服务端和前端测试。

**API：**

```text
GET  /api/security-policy/services
PUT  /api/security-policy/services/:serviceId
POST /api/security-policy/services/:serviceId/test
GET  /api/security-policy/commands
PUT  /api/security-policy/commands
POST /api/security-policy/reload
```

所有接口使用现有管理员认证链。

**页面功能：**

- 内网服务：展示当前系统依赖的全部已登记服务，包括服务名称、用途、协议、主机、端口、来源和当前状态。
- 内网服务：提供“测试连接”按钮；后端按服务类型执行 TCP、HTTP 健康检查或最小功能检查，并返回耗时和失败原因。
- 内网服务：提供“编辑”按钮，允许管理员修改已登记服务的主机、端口和协议；不允许通过页面新增任意服务或任意网络出口。
- 内网服务：显示最近测试时间、测试结果、当前生效 revision 和 reload 状态。
- 允许命令：启用/禁用系统注册命令、配置参数范围、输入输出目录、网络能力和超时时间。
- 保存前显示校验错误。
- 显示当前生效 revision 和 reload 状态。
- 不显示 API Key、Token 和无关服务器环境变量；服务测试不得把密钥返回前端。
- 普通用户和 Agent 不能调用这些接口。

- [x] 实现后端读写和管理员权限校验。
- [x] 实现原子保存、版本冲突和无效配置回滚。
- [x] 接入设置侧栏和内容页面。
- [x] 增加中英文翻译。
- [x] 增加管理员访问、非管理员拒绝、服务测试和并发编辑测试。
- [x] 验证编辑服务地址后下一次策略判断即可使用新配置。
- [x] 验证服务测试不能访问页面提交的任意未登记地址，避免形成 SSRF。

**任务 9 记录：** 管理员安全设置 API 已接入现有管理员认证链。内网服务只能从系统登记表读取，不能新增任意服务或提交任意 URL；编辑模型服务会修改 `pilotdeck.yaml`，环境变量服务会修改 `customEnv`，全局 HTTP MCP 会修改系统级 `mcp.json`，并同步更新 `network-policy.yaml`。配置文件使用临时文件和原子替换，策略更新使用 schema 校验、revision 冲突检测；来源写入失败会回滚策略。保存后触发 UI 配置重载、用户网关重载和系统级 MCP 监听，后续模型、医学服务、Office Renderer 和 HTTP MCP 请求读取新地址。多用户网关明确从系统目录读取全局 MCP，项目级和插件级 MCP 不被管理员服务页面覆盖。命令页面只能启用或收窄系统注册命令，不能配置任意 shell、Python、Node、R 或可执行路径。专项测试 9/9、前端全量 1233/1233、根目录全量 835 项中 833 通过、2 跳过、0 失败；前端类型检查和构建通过。剩余结构化审计与离线部署验收留待任务 12。

## 任务 10：实现简化资源限制

**文件：**

- 创建 `src/security/policy/resourceLimits.ts`。
- 修改 `src/tool/builtin/bash.ts`。
- 修改 `src/tool/builtin/bash/commandRunner.ts`。
- 修改 `src/mcp/client/McpClient.ts`。
- 增加资源限制测试。

第一阶段只实现四项：

1. 单次前台执行超时，沿用现有最大值 `600000ms`。
2. 单次工具 stdout/stderr 最大输出，沿用现有结果大小限制。
3. 单个任务 `scratch` 最大磁盘占用。
4. 单个任务允许的子进程并发数，默认先限制为 1。

- [x] 集中定义限制，避免各工具重复写常量。
- [x] 执行前后检查 scratch 占用。
- [x] 限制同一任务的子进程并发。
- [x] 测试超时、输出超限、磁盘超限和并发执行。

本轮不增加单独的资源设置页面。CPU、内存和 cgroup 级限制留到有实际运行数据后再做。

## 任务 11：迁移既有 Skill 和 MCP 输出

**文件：**

- 修改现有 PDF、DOCX、PPTX、表格、图示 Skill 的入口和输出处理。
- 修改医学 MCP 的文件输出适配。
- 修改相关回归测试。
- 新增 `docs/security-policy-and-artifact-contract.md`。
- 新增兼容性测试。

- [x] 盘点所有现有 Bash 入口并分配注册命令能力。
- [x] 盘点所有 Skill/MCP 的文件输出位置。
- [x] 最终输出统一写入 `exports/`。
- [x] 中间文件统一写入 `scratch/`。
- [x] 原始输入保持在 `inbox/`。
- [x] 为只打印路径但未返回结构化产物的工具补充 artifact。
- [x] 运行 PDF、DOCX、PPTX、表格、医学解析和附件回归测试。

**任务 11 记录：** 文档 Skill 的注册入口继续通过结构化 argv 执行；其 JSON 输出中的 `output`、`report`、`audit`、`pages`、`outputs`、`montage` 等路径由 Bash 适配层转换为统一 `final`/`intermediate` artifacts，并再次经过任务目录和文件类型校验。医学 MCP 已通过能力登记和桥接层返回结构化 artifacts；旧版文本、文件内容和工作区差异发现逻辑保留为兼容回退。任务 11 专项测试 `27/27`，最终全量测试 `843` 项中 `841` 通过、`2` 跳过、`0` 失败。

## 任务 12：集成验收和离线部署文档

**文件：**

- 修改 `docs/offline-deployment-plan.md` 或新增安全策略章节。
- 新增离线部署验收测试。
- 新增管理员策略流程测试。
- 完善 `docs/security-policy-and-artifact-contract.md`。

- [x] 运行 TypeScript、服务端、前端和安全测试。
- [x] 使用至少两个应用用户验证多用户隔离。
- [x] 验证管理员保存、无效保存、外部修改、reload 和回滚。
- [x] 验证未知外网默认拒绝，已登记的本机和远程功能服务可以正常使用。
- [x] 验证命令策略无法被 shell 元字符绕过。
- [x] 验证最终产物可见、scratch 和内部文件不可见。
- [x] 记录 Linux bubblewrap 和 macOS sandbox-exec 的平台差异。
- [x] 完成离线部署、策略备份、恢复和故障处理说明。

**任务 12 记录：** 新增 `tests/security/offline-deployment.spec.ts`，覆盖已登记回环/私网服务放行、未知外网拒绝、解释器和 shell 组合拒绝、双用户任务隔离以及 `exports`/`scratch` 产物边界。`docs/security-policy-and-artifact-contract.md` 已补充离线部署前提、发布验收、系统策略备份恢复、revision 冲突处理和 Linux `bubblewrap`/macOS `sandbox-exec` 差异。管理员策略 API 的保存、无效保存、外部修改、reload、回滚和前端服务连通性测试由任务 9/现有安全测试覆盖。

## 本轮明确不做

- Agent 或普通用户自由执行 Python、Node、R、Shell。
- 用户自创 Skill 的代码执行。
- 第三方 MCP 插件独立沙箱。
- 允许用户或 Agent 自由新增公网地址白名单。
- 完整 CPU、内存 cgroup 管理。
- 一次性重写所有现有 Skill。

## 完成标准

本计划完成后，应满足：

- 普通安全操作自动执行，不再弹出权限确认。
- 未注册命令和不安全路径在执行前直接拒绝。
- Agent 只能访问当前任务的 `inbox`、`scratch`、`exports`。
- Bash 以注册命令能力为主，不再依赖覆盖不全的危险命令黑名单。
- 未登记网络默认拒绝，已登记的本机和远程功能服务可以正常使用。
- 最终文件统一位于 `exports/`，并由工具显式返回产物信息。
- 现有一方 Skill 和 MCP 工作流继续通过回归测试。
- 管理员可以在前端查看、测试和编辑已登记的内网服务，并维护允许命令配置。
- 无效管理员配置不能替换上一份有效配置。
- 多用户离线部署验收通过。
