---
name: war-trauma-assessment
description: 六阶段战创伤研判工作流；生成固定五段结构并保留逐图 metadata，要求人工复核。
---

# 战创伤研判

1. 阶段必须是：伤员发生地、野战分类场、收容处置组、重伤救治组、手术组、洗消组之一。
2. 图像类别只接受：创面、X 光、心电、CT、其他；保留 image ID、label 和 index。
3. 调用 `medical_sidecar_build_trauma_prompt`，默认 `eval`；民用消融比较才使用 `plain`。
4. 将返回的 system/user prompt 交给 PilotDeck ModelRuntime，不让 sidecar 调用生成模型。
5. `eval` 输出必须覆盖：
   - 图像/影像判读
   - 本阶段处置措施
   - 伤情特异处置
   - 分类、伤标、后送/分流和交接记录
   - 安全禁忌和不得遗漏事项
6. 多图逐张判读后再综合，不用文字描述替代图像所见。
7. 对生命威胁、不确定性、资源限制和禁忌明确标注；结果必须经现场医疗人员复核。

