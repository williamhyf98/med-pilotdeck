# DeepChest 上传病例服务

## 实现边界

生产链路：上传 → 独立病例目录 → 影像校验与 LPS 定向 → TotalSegmentator fast 分割 → CT-CLIP 特征及三类评分 → 一次中文证据分析。

这条链路复用外部实验的视觉模型，不调用选择题评测 Agent；中文提示词独立保存在 `deepchest_service/evidence.py`。G9 提示词和 RADAR 推理未修改。没有结构化报告或 T1S 原图观察能力，不生成声称直接看见影像的报告。模型使用中心裁剪/填充 240 层，候选位置属于模型坐标，不能直接当作原始 DICOM 层号。

接受明确说明是完整胸部 CT、HU 单位的 NIfTI，或包含单个规则胸部 CT 序列的 DICOM ZIP/目录。DICOM 单帧文件需组成至少 16 层序列；混合序列、其他模态、缺层/重复层、斜切、多帧 DICOM 当前会拒绝。NIfTI 模态与部位依赖调用者明确确认，不能只凭扩展名判断。

## 服务端

使用经过验证的 Linux GPU 环境，复制 `plugins/med-tools/deepchest_service` 到独立服务目录。复制 `service.env.example` 配置工作区、任务目录、GPU、模型服务地址和密钥文件。用原环境 Python 启动：

```bash
python -m uvicorn deepchest_service.app:configured_app --factory \
  --host 0.0.0.0 --port 18130 --workers 1 \
  --ssl-certfile /deployment/certs/server.crt \
  --ssl-keyfile /deployment/certs/server.key
```

只允许一个 worker；目录锁会拒绝多进程同时管理任务。并发上限 4 个待处理/运行/上传任务，逐一执行。默认每个任务超时 1800 秒，超时或停服务会清理子进程组；重启后未完成任务标记失败，不偷偷重试。任务默认保留 24 小时，每 10 分钟清理已结束且过期的任务。不要把任务目录指向已有患者资料目录。

独立 Bearer 密钥保存在服务器文件中，客户端指定对应 CA，不能关闭 TLS 校验。服务端不得开放调试文档或提供任意路径下载。日志和任务文件使用私有权限。

## 客户端

在忽略的 `config/deploy.env` 设置：

```dotenv
MED_DEEPCHEST_API_BASE=https://your-server:18130
MED_DEEPCHEST_API_KEY_FILE=/deployment/secrets/deepchest-key
MED_DEEPCHEST_CA_BUNDLE=/deployment/certs/deepchest-ca.crt
# 可选，默认 PILOT_HOME/artifacts/deepchest
MED_DEEPCHEST_OUTPUT_DIR=/deployment/artifacts/deepchest
```

真实地址和凭据不提交到 Git；HTTP 仅允许 loopback 隧道。

MCP 工具：

1. `med_deepchest_status`：检查服务和配置。ready 不表示本轮影像已完成推理。
2. `med_deepchest_submit`：传入本轮 path、question、body_region=chest、modality=CT、intensity_units=HU，返回 job_id。
3. `med_deepchest_job`：每次最多等待 30 秒，返回 waiting/running/succeeded/failed 和阶段。成功后自动取回 JSON 和 Markdown，并以文件产物暴露给系统。

Agent 必须持续查询同一 job_id，不能重复提交。纯分析默认 terminal 模式，服务 report 由运行时直接展示和保存，结束本轮，不再调用主模型改写；复合任务使用 material 模式，保留报告再完成其他要求。刷新后的任务查询可用 job_id 恢复；当前没有独立前端后台自动恢复调度器，若本轮 Agent 预算耗尽，需要下一轮继续查询。

## 验证

Python 测试：`python -m unittest discover -s tests -p 'test_deepchest*.py'`（在 plugins/med-tools 下运行，安装服务依赖）。覆盖病例索引隔离、标签排除、NIfTI 几何、DICOM HU 转换与不完整序列、ZIP 边界、鉴权、队列、重启恢复、失败状态、客户端产物保存。

TypeScript 测试覆盖 DeepChest 阶段活动和文件产物，保证不会从工具报告额外推送 assistant 文本。

## 本次部署与验收（2026-09-22）

- node12 服务目录：`/local_data/huojianfan/3D-MLLM/service`，HTTPS 监听 18130。
- 用户级服务：`pilotdeck-deepchest.service`，已 enable，用户 linger 已启用，退出 SSH 后仍运行。使用 `systemctl --user status|restart|stop pilotdeck-deepchest.service` 管理。
- 分割与 CT-CLIP 使用物理 GPU 1，任务串行；没有新部署 Qwen，复用现有答案模型服务。
- 独立 API 密钥和自签证书位于服务目录的 secrets/certs，不在 Git 中。证书有效期 365 天，续期时同步客户端 CA。Mac 凭据位于 `~/.config/med-pilotdeck/deepchest/`，本地忽略的 deploy.env 已配置。
- Mac 严格校验证书的健康检查、任务查询、结果下载成功；node12 从真实上传接口提交示例 CT。
- 成功任务 `295a5d608d952a01ff3870bfe2e16cf7`：从上传至完成约 187 秒，输出 2,137 字符中文报告；新病例目录、新 mask、新特征和结果 case_id 一致，GPU 1 在结束后回到约 4 MiB。
- 首次 HTTP 测试在回答阶段超时，失败记录保留；之后改为内部流式接收并在当前 Qwen 专用调用中关闭额外 thinking（不影响系统其他模型）。客户端只看到最终完整报告。空答案、截断和断流不会记为成功。
- 本地 MCP 函数实调成功，返回 ok=true、terminal、报告和 2 个产物。桥接测试确认 terminal 直接成为正式回答，material 不提前结束。
- 回答提示词进一步限制概率/特异性措辞后，使用同一病例新证据单独复测回答阶段，成功生成 2,558 字符。实测仍可能出现模型自行概括“上部/中部”等位置描述；尚不能宣称所有医学措辞均严格受证据约束，临床有效性不在本次技术验收结论内。
- node12 网页项目已从 `271feb6` 快进同步至 `ba627dc`（后续文档提交另计）。使用项目 Node 22 安装锁定依赖，后端和 UI 构建成功并重启；4020/5180 页面 HTTP 200，18820 网关正常监听。原 `scripts/config.env` 端口设置逐字保留。
- node12 新建忽略的 `config/deploy.env`，配置 DeepChest HTTPS 地址、密钥文件和 CA 路径，以及 RADAR HTTP 地址；没有上传凭据。启动检查确认原有 G9、Qwen、Embedding 模型仍可连接。
- 使用更新后项目的真实 MCP stdio 协议，完成工具发现、上传、轮询和结果下载。新任务 `5b24a197b5a3f44a2ac4ec1bb9a84ed0` 用时约 185 秒，生成 1,706 字符中文报告，返回 terminal/ok=true 和两个文件产物。验收产物保存在 node12 项目 `.runtime/medical-validation/`。
- 未执行浏览器手动上传到聊天回答的完整端到端测试，尚未验证真实患者资料的临床效果。

### RADAR 同步验收

- 现有服务已由同事切换为 HTTP，无需 API 密钥或 CA；客户端兼容该配置，HTTPS 场景仍保留证书校验。
- 初次上传 HTTP 500，定位到独立部署 `/local_data/radar-service/app.py` 的请求体中间件：删除鉴权时一并删掉 `headers` 定义，但仍使用它读取 Content-Length，且异常发生在锁释放保护之前。
- 经用户明确授权，备份为 `app.py.before-headers-fix-20260922`，补回 `headers = dict(scope.get("headers", []))`，语法检查后重启 `radar.service`。仅修改这一行；仓库内保留鉴权的服务模板原本已有该定义，无需同步覆盖独立服务的鉴权配置。
- 重测任务 `f2929c7afa824969b4cda6a079378c16` 约 7 秒：无密钥上传、GPU 推理、CSV 下载均 HTTP 200；146 个候选字段中 139 项有效、7 项缺失，failed_cases 为空，结束后 busy=false。
- 本次使用已知胸部 CT 样例，只验证技术链路。RADAR 主要训练域为增强腹部 CT，不能据此宣称腹部临床效果已经验收。
