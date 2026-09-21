---
name: med-deepchest-3dmedagent
description: "处理 DICOM 路由判定的非腹部完整 CT：胸部运行 DeepChestVQA / CT-CLIP / 3DMedAgent，其他部位先做 3DMedAgent 兼容性检查并在证据不受支持时明确降级。"
---

# DeepChest 3DMedAgent

## 适用范围

用户要求胸部 CT、气道、胸膜、DeepChestVQA、CT-CLIP、3DMedAgent 流程、dry-run、数据质检或结果分析时使用本 Skill。DICOM 路由将其他已识别部位的完整非腹部 CT 也交给本 Skill 做兼容性检查。固定复用工作区 `/data1/chenchi/3D-MLLM` 中已有的代码、模型和产物。

不要把本 Skill 当作临床诊断工具，也不要把近似分割 mask 当作病灶真值。

路由边界：

- 腹部/盆腔 CT 的 RADAR、146 项 finding 或 RADAR 分数 → `med-radar-ct`。
- 完整胸部 CT → 执行本 Skill 的完整 DeepChest/CT-CLIP/3DMedAgent 流程。
- 完整头颈、脊柱、四肢等 CT → 必须先进入本 Skill，但当前器官词表只覆盖胸腹部。先检查是否存在受支持器官、mask、CT-CLIP 和 Agent 产物；不满足时记录 `compatibility-check` 降级，再用 `med-medical` 回答，不得声称已完成有效的 3DMedAgent 推理。
- 非 CT、单帧/不完整 CT、部位未知或混合目录、PDF、图片或报告附件解读 → `med-medical`。
- 用户明确要求 DeepChest 与 RADAR 联合分析时，分别加载并运行两个 Skill；两套证据、分数、产物和限制必须按来源分开，不能互相覆盖。
- 完整 CT 只运行路由选中的一个专用流程，不同时运行 DeepChest 和 RADAR。

## 固定路径与入口

- 标注：`data/3dmedagent_eval/DeepChestVQA/annotations/DeepChestVQA_smoke20.csv`
- 原始胸部 CT：`data/3dmedagent_eval/DeepChestVQA/volumes/`
- 分割：`artifacts/3dmedagent_deepchest/smoke20/segmentations/`
- CT-CLIP：`artifacts/3dmedagent_deepchest/smoke20/ctclip/`
- Agent 结果：`artifacts/3dmedagent_deepchest/smoke20/predictions/`
- 运行入口：`experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh`
- 3DMedAgent 主程序：`third_party/3DMedAgent-official/Final_Test/GPT_memory_t1s.py`

执行前优先复用已有产物并断点续跑。可先检查 `models/CT-CLIP_v2.pt`、`models/biomedvlp/config.json`、标注 CSV 和输出目录；不要重新下载已存在的权重。

## 证据与模型约定

- 主答案模型是 `Qwen3.8-27B`，OpenAI-compatible 地址为 `http://10.31.112.13:8040/v1`。不要切回 G9 `8030`，除非用户另行指定。
- 胸部流程必须使用 `--default-organ lung`。
- 真实 CT-CLIP 稠密特征形状必须保留为 `[1,24,24,24,512]`。
- `detail_slice` 必须保留真实 240 层坐标；不得用 32 层压缩结果替代主要证据。
- `bronchus-airway` 当前是气管保守近似，`pleura` 是肺边界形态学壳层；二者只能用于器官定位和流程验证，不能当作病灶真值。

## 强制运行规则

1. 首次验证默认只做 dry-run，不调用答案模型，也不上传 CT：

   ```bash
   cd /data1/chenchi/3D-MLLM && \
   experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh \
     --dry-run --save-dry-run \
     --target-subtypes bronchus/airway_lesion_existence \
     --max-per-subtype 1
   ```

2. dry-run 结束后检查 JSON 是否可解析，并核对器官路由、目标 mask、候选切片、`clip_global`、`clip_detail`、`clip_detail_slice`、缺失项和 `memory_schema_warnings`；不能只看退出码。

3. 纯文本 Agent 运行会把 CT-CLIP、mask 和报告摘要组成文本 memory。当前 MedPilotDeck 中，用户提交完整非腹部 CT 并要求分析即授权发送该去标识派生证据到 `10.31.112.13:8040`，无需再次询问：

   ```bash
   cd /data1/chenchi/3D-MLLM && \
   experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh \
     --target-subtypes bronchus/airway_lesion_existence \
     --max-per-subtype 1
   ```

   获得授权后再扩大到完整 smoke20；默认不要并发增加请求。

4. `--include-t1s` 会把 CT 切片图像发送到主模型，必须另外获得图像发送授权，默认不启用：

   ```bash
   cd /data1/chenchi/3D-MLLM && \
   experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh \
     --include-t1s --vision-model Qwen3.8-27B --t1s-max-iters 1
   ```

5. 缺少 structured report 时可以使用脚本已有的 `--allow-missing-report`，但结果必须标记为不完整复现；不得声称与论文或私有数据完全一致。不得把 `gt_answer`、`disease_findings` 或其他标注真值注入答案模型，它们只能用于离线评测。

## 结果检查与输出

检查每个结果 JSON：

- `facts_memory.lesion_memory.clip_global.available == true`
- `facts_memory.lesion_memory.clip_detail.available == true`
- `facts_memory.lesion_memory.clip_detail_slice.available == true`
- `memory_schema_warnings` 为空或逐项解释
- `GPT_summarized_result` 或对应最终答案字段可解析

中文报告必须区分：流程是否跑通、数据和证据是否可用、医学语义是否正确。输出至少说明数据/产物质量、模型证据、缺失项和结论边界；不要把模型输出写成确诊、排除或治疗决定。最终结论仅供辅助分析，须由有资质的医学人员结合原始影像、病史和正式报告复核。

联合分析时，DeepChest 结果只放在 DeepChest / CT-CLIP / 3DMedAgent 小节；RADAR 结果只放在 RADAR score / CSV / JSON 小节。不要把 RADAR 分数写入 `facts_memory.lesion_memory`，也不要把胸部 evidence 当作 RADAR 的腹部输入依据。

## 失败与安全边界

- 服务不可达、模型文件缺失或产物不完整时，报告实际错误和缺失项，优先退回本地 dry-run 或结果分析，不编造模型输出。
- 不主动上传原始 CT、mask、切片图像或患者元数据到未获授权的服务。
- 近似 airway/pleura mask、缺失报告、缺失 CT-CLIP 分支和不完整标注都必须单独列为限制。
- 本 Skill 不是 `med-radar-ct` 的替代品；RADAR 仍只用于其定义的腹部 CT 域。
