# DeepChest 远程接入：验证记录与服务设计草案

状态：用户已继续授权实现。环境已迁至 node12，单例 GPU 推理验证完成；上传病例适配、中文证据分析、HTTPS 服务和本地客户端已实现。最新部署、验证及剩余边界见 `docs/deepchest-service.md`。以下保留原设计背景，实际接口以实现文档为准。

## 目标与边界

让 Mac 和 node12 上的 med-pilotdeck 调用 node36 的 DeepChest 工作区，计算留在 node36。保留 G9 提示词和 RADAR 的现有行为。当前用户已同意先验证再封装 HTTP 服务，但外部程序的选择题输出与系统的开放式对话存在差异，需要确认此次是否一并适配真实上传病例和中文分析。

## 已验证的事实

- SSH：Mac 可使用现有 node36 主机配置访问 `/data1/chenchi/3D-MLLM`。
- node36 的内网地址包括 `10.31.112.47`。node12 到该地址的 TCP/22 可以连接；node12 直接 `ssh node36` 停在主机密钥校验，尚未验证 SSH 用户鉴权。没有关闭主机校验或修改 known_hosts。
- 外部 Python 可启动，版本为 3.12.13。FastAPI、Uvicorn、multipart、SimpleITK、nibabel、torch、TotalSegmentator 模块可被定位；这不等于 GPU 推理验证通过。
- CT-CLIP 权重、BiomedVLP 配置、分割程序、CT-CLIP 预计算程序和 3DMedAgent 主程序存在。
- 运行了一个 smoke20 示例问题的 `--dry-run --save-dry-run`，退出码为 0。输出保存在 node36 的 `/tmp/deepchest-probe.5S58VT`，未覆盖原有实验产物。
- JSON 是包含 1 条记录的数组，`GPT_raw_result=DRY_RUN`，`memory_schema_warnings=[]`，`t1s_included=false`。
- `facts_memory.lesion_memory.clip_global.available=true`；`clip_detail_by_target` 和 `clip_detail_slice_by_target` 的目标证据也均为 available。不能按旧文档中的固定 `clip_detail.available` 字段判断缺失。
- `report_fallback_used=true`：本例没有结构化报告，程序允许缺失报告继续。它不是所有证据齐全的完整复现。
- CT-CLIP 预计算脚本的 dry-run 返回“可运行”、输入问题为空，示例集合包含 19 个不同影像病例。此检查没有重新提取 CT 特征。
- 查询时 8 张 A800 每张剩余显存约 9–10 GB；未加载推理模型，也未停止或调整其他用户进程。

## 外部代码的关键约束

`experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh` 默认读取 smoke20 数据及产物。其主程序 `third_party/3DMedAgent-official/Final_Test/GPT_memory_t1s.py` 调用的回答提示词明确要求 multiple-choice 和一个选项字母，不能直接作为开放式中文影像报告接口。

脚本的默认答案模型配置是 Qwen3.8-27B，默认服务为 `http://10.31.112.13:8040/v1`，可以通过 `FINAL_TEST_OPENAI_BASE_URL`、`FINAL_TEST_OPENAI_MODEL` 和 `OPENAI_API_KEY` 覆盖。部署时读取环境配置，不把真实地址和密钥加入客户端代码。

现有分割和 CT-CLIP 脚本支持显式 CSV、影像根目录、mask 根目录和输出目录参数，因此具备逐病例隔离运行的基础；仍需要实现并验证上传文件到这些输入的适配。

## 推荐方案：真实上传病例服务

### 调用链

med-pilotdeck 上传文件并创建任务 → node36 校验和准备单个胸部 CT → 分割 → CT-CLIP 特征及评分 → 构造该病例的影像证据 → 开放式中文回答适配 → 客户端取回结果和附件。

服务代码放在当前仓库的 `plugins/med-tools/deepchest-service/`，外部模型工作区保持独立。现有评测程序继续用于实验验证，不直接修改它的选择题提示词。另设开放式问答适配器，复用已经验证的证据读取逻辑，不能把选项字母或评测标签改写成临床报告。

### HTTP 接口

- `GET /health`：返回服务状态、依赖检查和运行容量；把“依赖齐全”和“完整推理已验证”分别表示。
- `POST /v1/jobs`：接收单个胸部 CT 输入及用户问题，校验后返回 `202` 和任务 ID。
- `GET /v1/jobs/{id}`：返回 waiting/running/succeeded/failed 状态及 prepare/segment/ctclip/answer 当前阶段。
- `GET /v1/jobs/{id}/result`：仅在成功后返回本次病例结果、证据来源、缺失项、输入摘要和固定产物链接。
- 产物下载仅允许任务登记的文件；拒绝任意服务器路径。

接口采用独立 Bearer 密钥；部署使用 HTTPS 或受控隧道。不得关闭证书验证作为客户端默认行为。Mac 和 node12 各自配置地址、密钥文件、CA 文件，无需各自安装模型。

### 病例输入

第一版只接受单个完整胸部 CT：NIfTI 或单序列 DICOM 压缩包。DICOM 必须校验序列唯一性、CT 模态、体素几何和层面完整性；多序列、非胸部、未知部位、单张截图应明确返回不支持或要求选择，不能随意拼接。

每次创建随机任务 ID，保存上传文件哈希；影像、CSV、mask、特征、报告和输出都在该任务独立目录。生成的 CSV 仅用作外部脚本索引，不包含参考答案、疾病真值或示例患者标签。缺失报告明确标记；绝不读取 smoke20 作为生产任务回退。

开放式回答使用真实证据，保留缺失项和近似气道/胸膜 mask 的限制。第一版不启用向外部模型发送切片图像的 T1S 分支。服务内部仅生成一次中文分析，客户端将其作为工具材料使用，不同时向聊天框流式追加一份再重复总结。

### 运行与隔离

默认一个任务运行，队列有容量上限，单任务有超时；子进程超时后终止整个任务进程组。服务重启时把中断任务标记失败，不能永久显示运行中。上传大小、解压总量、解压文件数、输出保留时间均受限；拒绝路径穿越和符号链接。

GPU 由部署配置显式指定，单病例先验证显存占用，再确定可用容量。不能因内存不足自动抢占其他卡或终止已有工作负载。实际主机路径只放在部署配置中。

## 客户端改动范围

- 新增 `plugins/med-tools/server/deepchest.py`，负责健康检查、提交任务、查询状态和取回产物。
- `plugins/med-tools/server/app.py` 注册对应工具；`plugin.json` 增加环境变量占位符。
- `config/deploy.env.example` 增加 `MED_DEEPCHEST_API_BASE`、`MED_DEEPCHEST_API_KEY_FILE`、`MED_DEEPCHEST_CA_BUNDLE`；真实值放在忽略的 `config/deploy.env`。
- 更新 DeepChest 技能优先使用 HTTP 工具；外部 shell 命令仅保留为明确要求的实验验证入口。
- 根据现有 bridge 的路径处理和活动事件机制接入进度及产物，防止工具完成与最终回答重复。
- 长任务采用提交与查询接口，避免依赖一次 MCP 调用跨越完整分割和特征提取时间。

## 分阶段验收

1. 已完成：SSH、依赖位置、示例 dry-run 和证据字段验证。未调用答案模型或运行新 CT 的 GPU 推理。
2. 纯逻辑测试：上传校验、任务隔离、状态转换、超时、重启恢复、鉴权和非法产物路径；覆盖示例结果绝不用于上传病例。
3. 单病例 GPU 验证：使用明确标记的示例 CT 验证从准备、分割、特征到回答的全链路；记录用时、显存、产物哈希和证据完整性。这不等于临床有效性验证。
4. 服务部署：node36 独立服务及配置；Mac 和 node12 分别验证健康接口、任务查询和结果下载。
5. 系统验收：从新对话上传 CT，看到阶段进度和最终报告，刷新后答案一致；服务失败时诚实显示失败，不返回示例答案。

## 较小范围的备选方案

如果本次只需远程运行同事原有实验，则提供固定示例任务的 dry-run/实验执行与结果查询，不接收患者上传，不进入临床附件自动路由。这样无需新增开放式回答逻辑，但不能实现“上传自己的 CT 后生成分析”。
