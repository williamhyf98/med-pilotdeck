# 济南模型接入配置（W1）

> 日期：2026-08-14
> 状态：模型服务已就绪，端点已连通（本机验证通过）

## 1. 济南模型服务（已启动）

| 用途 | 模型 id | 端点 | 协议 | 验证 |
|------|---------|------|------|------|
| 主 Agent / 医疗 VLM | `G9-V-Med` | `http://10.31.112.13:8030/v1` | OpenAI 兼容（vLLM，max_model_len 131072，支持 image_url） | `GET /v1/models` 返回 200 ✅ |
| Embedding（W3 RAG 用） | `qwen3-vl-embedding` | `http://10.31.112.13:65507` | OpenAI 兼容（Qwen3-VL-Embedding-2B，max_model_len 8192） | `GET /v1/models` 返回 200 ✅ |

均无需 API Key。

## 2. 已完成的配置改动

### 2.1 主 Agent 模型（运行时配置 `~/.pilotdeck/pilotdeck.yaml`）

该文件是本地运行时配置（gitignored），本机已改：

```yaml
agent:
  model: my-llm1/G9-V-Med        # ← 原 deepseek/deepseek-v4-flash
router:
  scenarios:
    default: my-llm1/G9-V-Med    # ← 原 deepseek/deepseek-v4-flash；路由默认场景必须同步改，否则 Router 会覆盖 agent.model
  fallback:
    default:
      - my-llm/qwen3.6-27b
      - deepseek/deepseek-v4-flash   # ← 新增兜底
```

provider `my-llm1` 声明（已存在，无需改动）：

```yaml
model:
  providers:
    my-llm1:
      protocol: openai
      url: http://10.31.112.13:8030/v1
      apiKey: xxx
      models:
        G9-V-Med:
          multimodal:
            input: [text, image]
```

其他机器部署时按上述片段配置即可（`agent.model` + `router.scenarios.default` 两处都要改）。

### 2.2 med-tools 插件 VLM（已提交 `plugins/med-tools/plugin.json`）

```json
"MED_VLM_API_BASE": "http://10.31.112.13:8030/v1",   // ← 原 http://127.0.0.1:8030/v1
"MED_VLM_MODEL": "G9-V-Med",
"MED_VLM_API_KEY": "EMPTY"
```

GPT-5.5 fallback 保留，仅作兜底。改完需重启 Gateway 生效。

### 2.3 医疗 Tab 隐藏（已提交 `ui/src/components/app-shell/MainAreaV2.tsx`）

主界面"医疗工作台"分组（Dialogue / Med-trauma 两个按钮）已通过 feature flag 隐藏：

```typescript
const MEDICAL_TABS_VISIBLE = false;  // 置回 true 即可恢复按钮，页面/路由代码未删除
```

## 3. Embedding 接入说明（待 W3）

- 端点 `http://10.31.112.13:65507`，模型 id `qwen3-vl-embedding`（多模态 embedding，支持文本+图像输入）。
- 当前 med-tools 尚无 embedding 消费者；W3（William）把 RAG 迁入 `plugins/med-tools/data/` 时，建议沿用 `MED_EMBED_*` 前缀环境变量接入此端点，与现有 `MED_VLM_*` 命名保持一致。

## 4. W1 验收待办

- [ ] Agent 主页面发起对话，确认实际走 `my-llm1/G9-V-Med`（Gateway 日志可见 model id）
- [ ] 上传医疗文件触发 `med_parse_medical` tool_call，模型基于工具结果生成回答
- [ ] 记录 TTFT / 整轮耗时、回答质量简评（填到 `work-split-med-pilotdeck.zh.md` §10 交接清单）
- [ ] 主界面无医疗 Tab 入口（Dialogue / Med-trauma 按钮不显示），直访旧 URL 不白屏
