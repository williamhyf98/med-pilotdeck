# RADAR 合入 feat/trauma（2026-09-21）

## 合并约定

- 纯医学附件解读：`med_parse_medical(continuation_mode="terminal")` 直接展示并保存 G9 报告，结束本轮，不经主模型改写。
- 复合任务：使用 `material`，工具只发医疗进度事件；报告保存在工具结果中，主模型保留判读原文并完成用户要求的分析/文件交付。
- 同批多份直接报告等待全部返回后按调用顺序组合；不交错展示流式正文。出现失败或仍有 material 解析结果时，不提前结束。
- 前端只展示正式 assistant 答案，不再从工具 `report` 猜测最终答案，也不按特定 RADAR 文句裁剪正文。
- 处理步骤默认可见，沿用完成后折叠的交互；DICOM 预览接入现有文件工具栏与展开/还原布局。
- G9 的 `plugins/med-tools/prompts/` 与 `server/vlm_client.py` 未修改。

## 部署配置

当前机器的实际地址写入不入库的 `config/deploy.env`，参照 `config/deploy.env.example`。Shell 同名变量优先。`npm run dev`、`npm run server`、`npm run server:built` 和 UI server 均加载现场配置。

RADAR 配置项：`MED_RADAR_API_BASE`、`MED_RADAR_TIMEOUT_SECONDS`、`MED_RADAR_API_KEY` 或 `MED_RADAR_API_KEY_FILE`、`MED_RADAR_CA_BUNDLE`、可选的 `MED_RADAR_OUTPUT_DIR`。

未指定密钥/CA 路径时，RADAR 客户端仍支持 `PILOT_HOME/secrets/med-radar-api-key` 和 `PILOT_HOME/certs/med-radar-ca.crt`。勿将真实密钥提交到 Git。

DeepChest 使用 `MED_DEEPCHEST_ROOT` 指向外部工作区。当前分支没有包含该工作区、权重或本轮上传病例的数据接入脚本；不能将 smoke20 示例结果用于回答上传病例。缺少绑定或运行环境时，技能应说明限制并降级。

## 验证与范围

已验证前后端构建、影像输出模式与批次完成、附件记忆链路、医疗进度事件、技能门禁、文件预览、上传与服务桥接、DICOM 路由及 RADAR 客户端/服务辅助逻辑。RADAR 服务测试使用隔离的临时 Python 依赖，未安装 GPU 模型。

真实 RADAR GPU 推理、node12 的证书/密钥和 DeepChest 外部环境需在部署后核对。本次合并未修改 node12，也未推送远程分支。
