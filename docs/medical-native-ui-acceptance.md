# 医疗原生 UI 复刻验收基线

## 1. 验收目标

以远端 Dialogue 与 Med-trauma 静态应用为黑盒基线，在 PilotDeck 中使用 React 原生实现两套专题界面，并复用同一套 Gateway、Agent、模型、工具、会话、权限和医疗领域服务。

旧 bundle 仅用于视觉、交互和接口对照，不进入最终运行架构。

## 2. 固定视觉环境

- 浏览器：项目锁定的 Chromium 版本
- 语言：中文
- 主题：分别验证浅色和深色；远端没有对应主题时以原主题为基线
- 缩放：100%
- DPI：96
- 桌面视口：1440 × 900
- 笔记本视口：1280 × 720
- 最小支持视口：1024 × 768
- 动画：截图时关闭或等待稳定
- 时间、随机 ID、模型流内容：使用固定 fixture

验收采用页面截图、区域截图和交互状态截图。DOM 结构无需与旧应用一致，但布局、尺寸、颜色、字体、间距、边框、状态和操作反馈应达到约定视觉差异阈值。

## 3. Dialogue 页面

必须覆盖：

- 页面整体布局
- 会话侧栏
- 新建、选择、重命名和删除会话
- 欢迎空态
- 用户与助手消息
- Thinking 展示
- 停止 Thinking
- 停止生成
- 模型选择
- 采样参数
- System Prompt 开关和配置入口
- 健康问答
- 战创伤诊断
- 报告解读
- 药盒识别
- 深度搜索
- 表格电子化
- 单图和多图上传
- 多源附件上传、解析和预览
- RAG 语料和来源
- 附件缓存
- 表格列表、编辑、删除和 CSV
- 3D Gallery
- Volume 上传、列表、详情和切片
- M3D 可用、不可用和失败状态
- 加载、空数据、成功、警告和错误状态

## 4. Med-trauma 页面

必须覆盖：

- 页面整体布局
- 六个救治阶段
- 五类图像
- 多图添加、删除、标签和顺序
- 场景与描述输入
- 模型选择和探活状态
- 开始、进行中、完成和失败状态
- SSE 流式输出
- 影像判读
- 阶段处置
- 特异处置
- 分类、伤标、后送和交接
- 安全禁忌
- 演示案例和历史静态评测标识
- 空态、加载、成功、警告和错误状态

## 5. PilotDeck 主聊天医疗能力

必须覆盖：

- 医疗通用 Profile
- 健康问答 Skill
- 报告解读 Skill
- 药盒识别 Skill
- 深度搜索 Skill
- 快速战创伤 Skill
- 多模态附件
- RAG 来源卡片
- 附件解析卡片
- DICOM、ECG、PDF 卡片
- 表格 OCR 卡片及工作台深链
- Volume 卡片及工作台深链
- 战创伤摘要卡片及专题页深链
- 所有生成请求经过 PilotDeck Gateway

## 6. 共享数据对象

两套专题页和主聊天必须共享：

- Conversation
- Run
- Artifact
- Case
- Profile

禁止：

- 为专题页建立第二套聊天历史
- 为主聊天和专题页分别保存同一附件
- 绕过 Gateway 直接调用生成模型
- 在浏览器保存 API Key

## 7. 后端与工具

必须覆盖：

- Agent Profile
- 逐 Turn 模型与采样参数
- Thinking
- 工具 allow/deny
- RAG MCP
- Ingestion MCP
- Table MCP
- Imaging/Volume MCP
- Trauma Profile/Skill
- Sidecar 健康检查
- 能力不可用时的明确响应
- Session、Run 和 Artifact 所有权

## 8. 安全

必须验证：

- 未认证请求被拒绝
- 用户不能访问其他用户的 Session 和 Artifact
- 普通用户不能配置任意模型 Endpoint
- 模型连接测试具有 SSRF 防护
- XML 外部实体和网络访问被禁止
- 上传数量、大小、像素、页数、帧数和体素受限
- 错误不泄漏路径、Endpoint、密钥和堆栈
- API Key 不进入客户端响应和日志
- 医疗长期 Memory 默认关闭
- 外部 Telemetry 默认关闭

## 9. 运行与交付

必须验证：

- Node.js 22.13–22.x
- PilotDeck Gateway、UI Server、Medical Sidecar 健康
- 无互联网环境下达到声明的离线等级
- RAG、模型和数据制品具有版本及 Hash
- 缺少 M3D、病例目录或通用医学知识库时不伪造成功
- 客户差异通过 preset、feature flag、Profile 和 Plugin 组合
- 不为客户建立长期源码分支

## 10. 首版完成定义

满足以下条件后，首版方可认定完成：

1. `/medical/dialogue` 与 `/medical/med-trauma` 通过功能和视觉验收。
2. 远端两个界面的全部当前可见功能均有原生等价入口。
3. PilotDeck 主聊天能够调用共享医疗能力。
4. 所有生成请求都经过 Gateway。
5. 专题页与主聊天共享数据和权限模型。
6. 旧 bundle 不再是用户完成任务的必要入口。
7. 类型检查、单元测试、集成测试、浏览器测试和本地运行检查通过。

## 11. 2026-08-07 全量验收记录

- 视觉基线：远端版本 `b507f26`；8 个旧 UI 资产的路径、大小和 SHA-256 记录于 `products/medical-integration/reference-ui/manifest.json`，仅用于对照。
- 固定环境：Chromium、1440 × 900、DPR 1、100% 缩放、浅色主题。Dialogue 与 Med-trauma 均已恢复 248px 米色侧栏、军绿配色、旧版欢迎区、输入卡和流程卡；最终静态复核未发现阻断或高等级差异。
- Dialogue：RAG 使用 `war-trauma` 真实语料，只调用一次 MCP 检索；22.8 秒内显示工具卡、来源和最终回答，不再循环。
- Med-trauma：授权案例可加载；真实 JPEG 像素进入 Gateway，`modelInputAvailable: true`；约 20 秒完成五段 SSE 输出。
- 表格 OCR：合成无 PHI 表格 3.96 秒完成；原图复核、文档创建、单元格编辑、刷新持久化和 CSV 导出通过。
- 影像：Gallery 授权病例与切片通过；Volume 上传、TTL、尺寸、强度范围、切片、刷新和删除契约通过；M3D 未配置时明确禁用。
- 自动化：医疗 UI/Server Vitest 110/110、Python Sidecar unittest 58/58、核心 Agent/Profile/Thinking/Streaming 16/16 通过；Gateway TypeScript 与 UI Vite 生产构建通过。
- 安全：用户所有权、TTL、请求预算、图片安全重编码、DICOM burned-in PHI 门禁、CSV 公式注入、路径遍历、SSRF、错误脱敏和秘密不下发均有定向测试覆盖。
- 离线交付：`docker-compose.medical.yml` 通过 Compose 配置校验；Sidecar 镜像构建未在本机执行，因为 Docker Desktop daemon 未启动。该项属于运行环境限制，不影响本地 Node/Python 运行验收。
- 声明边界：embedding 服务未部署时明确使用 `lexical-fallback`；M3D 服务和模型权重不随本项目伪造或内置。
