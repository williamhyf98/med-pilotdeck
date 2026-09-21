# DeepChest 最小迁移至 node12

日期：2026-09-22。范围：迁移独立工作区并验证现有流程，不包含 HTTP 服务或新上传病例接入，不启动 GPU 推理。

状态：迁移和 CPU-only 验证已完成。node12 工作区占用约 28 GB。

## 目录与迁移内容

- 来源：node36 `/data1/chenchi/3D-MLLM`，保留原目录及环境。
- 目标：node12 `/local_data/huojianfan/3D-MLLM`。
- 基础 Python：目标下 `.runtime/python`，由原 `/data1/conda-envs/Medical-swift` 使用 conda-pack 打包，打包时指定目标 prefix。
- 工作虚拟环境：目标下 `.venvs/radar`，使用迁移后的 Python 重新创建，保留原有 overlay 包；修正可编辑安装的 ct_clip、transformer_maskgit 及命令入口路径。
- 搬入 experiments、third_party、CT-CLIP、BiomedVLP、TotalSegmentator 模型和 smoke20 证据产物。
- 原始 CT 只搬入 `train_4827_a_2` 一例，复制的是文件本身，不依赖 node36 的影像软链接。
- 未搬入其他原始影像、RADAR 模型、嵌套 med-pilotdeck 副本或失败下载目录。
- 原 smoke20 标注仍保留全部记录。只有该单例原始 CT 已迁入，不能据此认为完整 smoke20 可重新推理。

## 传输与校验

使用两台服务器可访问的共享暂存目录，不经过 Mac 中转：

`/slow_share2/ultrafast_share/home/huojianfan/deepchest-migration.5SCrIf`

暂存目录包含 workspace.tar、sample-ct.tar、venv-tools.tar、python.tar.gz 和环境打包日志，目录权限为当前用户私有。环境压缩包约 13 GB。它包含指定 node12 目标路径的 prefix；后续迁到其他路径需重新打包或重建环境，不能直接改目录名。

源端与目标端的模型、示例影像 SHA-256 一致：

| 文件 | SHA-256 |
| --- | --- |
| CT-CLIP_v2.pt | `75eeb75a49c557a0e6eb7be72a53166e9123661518cc72c7aa1705ee7942c8c9` |
| train_4827_a_2.nii.gz | `63b9a4b2b9efd3987f10cc10f225439ecb1e4ba88f733a2213cfa140b42965cf` |
| python.tar.gz | `b41821b7e6882b2b7447ee06e1f04376d25b11866b91a1fcb310bc359da05476` |

## 验证入口

在 node12 工作区执行下面的单题检查，输出写入独立目录，避免覆盖原实验结果：

```bash
cd /local_data/huojianfan/3D-MLLM
CUDA_VISIBLE_DEVICES='' PYTHONNOUSERSITE=1 \
  experiments/3dmedagent_repro/run_deepchest_agent_qwen.sh \
  --dry-run --save-dry-run \
  --target-subtypes bronchus/airway_lesion_existence \
  --max-per-subtype 1 \
  --save-dir artifacts/migration-validation/agent
CUDA_VISIBLE_DEVICES='' PYTHONNOUSERSITE=1 \
  .venvs/radar/bin/python artifacts/migration-validation/verify.py
```

验证脚本检查 Python prefix、关键依赖导入来源、示例 CT 三维尺寸和 dry-run 输出。证据字段使用当前程序实际输出的 clip_global、clip_detail_by_target、clip_detail_slice_by_target。结构化报告缺失应保留 `report_fallback_used=true`，不能隐藏。

本次验证结果：

- Python 3.12.13、PyTorch 2.10.0+cu128；12 个关键模块均可导入，加载路径均位于 node12 新工作区。
- 示例影像可读取，尺寸 512 × 512 × 450；模型及影像源/目标哈希一致。
- 单题 Agent dry-run 成功，三类证据均可用，`memory_schema_warnings=[]`，未调用答案模型。
- 单病例 CT-CLIP dry-run 返回“可运行”，输入问题为空，期望病例数为 1；生成的命令不包含 node36 工作区路径。
- 分割 dry-run 成功，命令指向 node12 的 Python 工具和示例影像。
- `.venvs` 和 `models` 中未发现失效软链接。
- 保留原有“缺失结构化报告”标记。导入 vector_quantize_pytorch 时存在 PyTorch AMP 弃用警告，不影响此次验证；GPU 执行仍未验证。

详细结果位于 node12 工作区的 `artifacts/migration-validation/verification.json`，相关日志、单例 CSV 和预检产物也位于该目录。

## 与系统接入的区别

本次不修改 node12 或 Mac 的 med-pilotdeck 运行配置，不启动 HTTP 服务，不调用 Qwen 或 G9 生成答案，不运行新的分割或 CT-CLIP GPU 推理。

后续需指定可用 GPU 验证新 CT 完整推理，再实现真实上传病例绑定、问答适配和远程服务。迁移验证通过只表示原有示例流程及依赖可在 node12 运行。

## 第二检查点：单例完整推理（2026-09-22）

已在 node12 使用当时空闲的物理 GPU 1 重新处理上述示例 CT。产物写入新建的 `artifacts/migration-validation/full-inference/`，未覆盖或复用 smoke20 的旧分割和特征。

- TotalSegmentator fast 模式（3 mm）重新生成肺叶、气管及派生 mask；验证通过，形状、仿射与原始 CT 一致且目标非空。TotalSegmentator 自报运行时间为 30.24 秒，不含后续派生 mask 和校验时间。
- CT-CLIP embedding/global/section/slice 四个阶段均成功，各产出 1 例；整体从 00:25:47 至 00:26:32，约 45 秒。特征形状 `[1,24,24,24,512]`，提取日志显示已有产物跳过数为 0。
- Agent 使用显式指定的新 mask 和三类新证据目录，调用已有 Qwen3.8-27B 服务；单题约 43.20 秒，输出记录非 ERROR/SKIP/DRY_RUN，最终选项为 B。这里只验证执行成功，不代表医学答案正确。
- 三类影像证据 available，`memory_schema_warnings=[]`；结构化报告仍缺失并保留标记。未启用 T1S，不发送 CT 切片图像，只发送派生文本证据。
- 权重审计：missing_keys 为空；唯一 unexpected_key 是 `text_transformer.embeddings.position_ids`（位置编号缓存），没有缺失模型权重。审计在 CPU 完成，未修改加载器。
- 结束后 GPU 1 显存恢复到约 4 MiB。此次没有连续采样，不能把中途观测的约 2.4 GB 当作峰值显存或最低部署要求。

日志及证据：`segmentation.log`、`ctclip.log`、`ctclip/流水线汇总.json`、`agent.log`、`agent/train_4827_a_2.json`、`weight-audit.log` 均位于该 full-inference 目录。

本检查点完成后，剩余工作是实际上传病例绑定、开放式中文回答适配以及 HTTP 服务和系统集成。现有评测 CSV 包含标签；现有程序按 leak-safe memory 生成提示词，后续生产适配应直接去除标签字段，不使用评测 CSV 作为上传病例模板。

## 第三检查点：服务与项目集成（2026-09-22）

上述剩余适配已完成：独立上传病例索引不含评测标签，HTTPS 服务提供异步推理与中文报告，med-pilotdeck 通过 MCP 客户端调用。代码已推送至 feat/trauma，并在 node12 项目同步、构建、重启。新上传任务完整跑通约 185 秒；RADAR 无鉴权服务的请求头遗漏修复后也完成真实推理及 CSV 下载。详细任务记录、限制和部署方式见 [deepchest-service.md](deepchest-service.md)。
