# 专用 CT 能力开关

在 `config/deploy.env` 配置 `MED_SPECIALIZED_CT_ENABLED=0` 后，重启
PilotDeck（包括 gateway 和 med-tools MCP 子进程），刷新浏览器。
使用构建产物启动时，代码更新后需先重新构建。

关闭时：

- 技能库、聊天推荐、agent 技能目录和 `read_skill` 不提供
  `med-radar-ct`、`med-deepchest-3dmedagent`、`med-dicom-router`。
  用户或项目目录中的同名副本同样隐藏，文件不删除。
- MCP 工具发现和 agent 工具列表不提供 `med_radar_*`、`med_deepchest_*`；
  旧会话发出的专用调用仍由执行门禁阻止，健康检查不探测 RADAR。
- 保留 `med-medical`、`med_dicom_route`、`med_parse_medical`。
  DICOM 在通用医学技能下完成元数据预检和附件解析，不依赖隐藏的路由技能。
- G9、主模型回退、战创伤 RAG 和历史报告不受该开关影响。
  通用解析不等同于 RADAR/DeepChest 三维推理，也不代表系统禁止一切网络访问。

恢复时设置 `MED_SPECIALIZED_CT_ENABLED=1`，重启上述服务并刷新页面，
即可恢复三个技能、推荐和专用工具及路由。服务地址、凭据与模型仍需正确配置。
远程 HTTP 服务不因该开关启动或停止。

只有精确值 `1` 开启；未设置、`0`、空值和其他值均关闭。
沿用部署配置规则：Shell 中已导出的同名非空变量优先于配置文件。
已有对话中的文字不会被删除；若旧上下文仍反复提及已关闭技能，可新建会话。
