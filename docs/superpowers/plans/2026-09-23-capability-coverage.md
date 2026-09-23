# 受控业务能力覆盖与合并检查点 A

日期：2026-09-23。对应唯一执行计划 `2026-09-23-multi-user-sandbox-implementation.md`。

## 当前边界

本表是 Task 3 的迁移清单，不代表新能力已经实现。医学/文档原入口目前仍保留，直到 Task 8—12 的替代工具逐项验收后才删除通用执行工具。下列“目标测试”均是后续待实现的测试场景，不是本批通过记录。

已阅读现有六个技能的用户操作说明及主要工作流入口。内部 prepare/schema/QA/deliver 等步骤交给后端固定编排；不得把“命令名 + 任意参数”开放给模型。

## 文档与图示操作覆盖

| 用户操作 | 旧入口 | 新能力与后端工作 | 目标测试 / 支持差异 |
|---|---|---|---|
| 查找项目资料 | glob/目录读取 | project_files_list：授权项目分页、类型筛选 | 同名文件、跨用户资源拒绝 |
| Word 读取/摘要/检索/定位 | docx.sh inspect | document_read/search，返回受控正文和位置 | 中文段落、表格、定位与全文分页 |
| Word 新建/对话报告导出 | docx.sh make | document_create/export，支持 reportId 原文 | 报告原文不缩减、标题/表格/图片 |
| Word 定向编辑 | prepare/resolve-latest/edit | document_update，版本检查后固定编辑流程 | 定向段落修改、源文件哈希不变 |
| Word 批注/修订替换 | review | document_update.review | 批注位置及修订作者保留 |
| Word 接受/拒绝修订、移除批注 | finalize | document_update.finalize | 各操作独立测试；不默认接受修订 |
| Word 版本比较 | compare | document_read.compare（两个资源均授权） | 跨用户任一输入拒绝、差异输出 |
| Word 净化 | sanitize | document_update.sanitize | 新版本，原文件不覆盖 |
| Word 刷新目录 | refresh-toc | document_update.refresh_toc | 缺渲染后端明确受限 |
| Word 结构/无障碍检查及渲染 | validate/audit/render | 固定后处理；用户主动检查走 document_read | 无渲染器时不自动安装；结构结果仍可用 |
| PDF 读取/提取 | pdf.sh inspect | document_read/search | 页码/表格/扫描件能力界限 |
| PDF 新建/全文报告导出/插图 | make | document_create/export | 中文字体、原报告全文、授权图片 |
| PDF 合并 | merge | document_update.merge | 所有输入归属、页数/顺序 |
| PDF 拆分 | split | document_update.split | 页范围校验、每份产物注册 |
| PDF 旋转 | rotate | document_update.rotate | 指定页角度、未选页不变 |
| PDF 表单读取/填写 | forms-inspect/forms-fill | document_read.forms / document_update.forms | 字段类型、只修改授权副本 |
| PDF 审计/页面预览 | audit/render | 固定审计、受控预览资源 | 渲染失败透明报告，不交付内部路径 |
| PPT 新建/报告转演示/图片和主题 | pptx.sh make/themes | document_create/export，主题枚举 | 中文文本/表格/图片与主题；无 JS builder |
| PPT 读取/审计/可选渲染 | inspect/audit/render | document_read、后处理 | 页/对象定位、布局越界、字体 |
| PPT 按模板/指定页修改 | validate-map/prepare-starter/apply-template/fidelity/deliver | document_update，固定模板映射和封印 | 只改指定页，保留其余对象；无法映射返回 unsupported |
| 旧 PPT 转换 | convert | document_export，固定转换器 | 仅环境已有 LibreOffice 时支持 |
| 表格读取/按工作表区域审计 | spreadsheet.sh inspect/audit | document_read/search | 工作表/区域/样式/公式/兼容性 |
| 表格新建/多工作表/图表/插图 | make body/markdown/csv/spec | document_create | 图表、验证、条件格式、授权图片 |
| 修改既有 XLSX | inspect + make --input | document_update，受限单元格/公式/格式 schema | 保留源文件；宏/签名/外链等风险不静默降级 |
| CSV/TSV 导入导出 | make 与分隔格式选项 | document_create/export | 前导零、长数字、GBK/GB18030、公式注入 |
| 旧 XLS 转换/公式重算 | convert-legacy/recalculate | document_export / 固定后处理 | 依赖已有 LibreOffice；缺失提示 Excel 打开重算 |
| 表格可选渲染/封印 | render/deliver | 固定后处理 | 不把 PNG 当交付硬门槛 |
| 流程图/概念图/架构图 | diagram.sh make body/markdown/spec | document_create(format=svg)，声明式图 schema | LR/RL/TB、分组/边标签/节点类型、clean/architecture |
| 图示网页导出 | diagram.sh make --format html | document_export(format=html) | 仅用户主动要求；SVG/HTML 安全审计 |
| 医学 HTML 展示新建/修改 | write_file/edit_file | document_create/update(format=html)，受控模板与内容 | 单页/多屏、Tab/折叠/目录；图片必须资源引用 |
| HTML 风格预览 | 生成一份三段预览 | document_create.preview | 一份预览产物，不污染最终报告 |
| PPT 转 HTML | extract-pptx.py 后生成 HTML | document_read + document_create | 不覆盖 PPT；受控资源引用 |
| HTML 本机编辑/交互 | 原技能可选 localStorage 与内联 JS | 沙箱 Origin、固定交互模板；暂不直接保留任意脚本 | 共享电脑串数据风险；用户隔离持久化设计待 Task 9/14 |

### 不能静默丢失或直接沿用的边界

- Word 的审阅/修订/比较不等同于“生成一个新 Word”，必须分别验收。
- PPT 模板修改不能用整体重建替代；表格存在高风险对象时不能自动 roundtrip。
- 不保留模型任意输出路径、任意 flags、源码 builder、外部 Excel/DDE 引用、可执行模板。危险输入返回明确 unsupported/拒绝，不能转回 Shell。
- 图示维持当前子集：不支持时序/类图/ER/状态图、Excalidraw、用户照片直接嵌入节点图；可组合到 Word/PPT。
- `frontend-slides` 是没有固定生成器的例外，需要新建受控 HTML 渲染适配器；不能仅删除 write_file 就声称迁移完成。
- 每一项可安全包装的现有操作都需要 Task 9 的测试；无法安全保持的差异先向用户说明，不自行砍功能。

## 医学与长任务

| 现有路径 | 目标能力 | 验收重点 |
|---|---|---|
| med-tools 文档/影像解析 | medical_parse / dicom_route | 附件资源归属、单/多帧、系列完整性、多附件与历史附件 |
| RADAR G9 | radar_analyze | 纯判读 terminal 原报告展示/保存一致；复合 material 可后续导出 |
| DeepChest | deepchest_analyze | 固定适配器、远端任务 ID、排队/恢复；不向用户暴露部署内部信息 |
| 战创伤专属 Runner/RAG | trauma_rag_query / stage_plan | 连续来源编号、专属提示词、流程叶子和状态快照；不重写为通用 Agent |
| 文件/报告/长结果 | result_read / document_export | reportId 全文分页/原文导出，不引导模型读服务器路径 |
| 长任务轮询/取消 | job_status / job_cancel | owner 校验、幂等、公平排队、超时不重提 GPU；取消报告真实状态 |

真实模型/GPU调用留待获准的服务实测。本批不连接 RADAR、DeepChest 或远程机器。

## 检查点 A 的验证范围

- `userHomes.safety.spec.js`：注册保护、并发初始化、旧文件不移动、启动维护阻断、默认私有技能不复制、只显式选用公共模板、禁止作用域代入、重启不提升普通账号。
- `db.safety.spec.js`：用复制的生产数据库模块和合成旧账号库验证新 DATABASE_PATH 不继承旧数据，未打开真实账号库。
- `SetupForm.test.tsx`：初始化令牌输入与账号提交。
- `multiUser.baseline.spec.js`：真实 SQLite/bcrypt/JWT、管理员创建普通账号、双账号登录/列项目/新项目/退出；Gateway 只替换进程与传输，项目列表仍读真实临时文件。
- `tests/security/merge-baseline.spec.ts`：真实项目/历史读取和新会话 transcript 写入；同名附件、重复业务 ID、两种 session slug 保留。
- 不把模拟 Gateway 进程等同于实际 Gateway 启动、模型回答或 OS 沙箱验收；不把退出接口成功等同于令牌已撤销。

## 后续发布阻断（尚未解决）

1. JWT/WS 撤销、登录限速、最后管理员及完整账号恢复：Task 4。
2. 配置 GET/raw YAML、Shell、任意目录/API、资源票据和 WS 订阅授权：Task 4—7。
3. 用户作用域缺失仍有共享回退；Gateway 池 starting 淘汰、租约、关停及孤儿进程问题：Task 6。
4. 共享 UI 服务中的 sessionState、事件、标题、项目目录缓存仍需 owner 维度审计：Task 5—7/14。
5. 记忆维护定时器、清空缓存、跨用户 capture/Index/Dream 和自定义根：Task 13。
6. 通用模型工具、原始 MCP、共享插件/含密钥配置及 worker 文件/网络沙箱：Task 8—15。
7. 用户切换前端缓存清理、个人技能/声明式技能权限：Task 14。
8. 旧存储存在时多用户服务明确拒绝监听；要继续使用原数据，必须等待显式迁移工具和授权，不删除旧目录来绕过门禁。
9. 多人生产使用必须等 Task 15 完成；本批不迁移、不部署、不推送。
