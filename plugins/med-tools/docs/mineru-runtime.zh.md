# MinerU 外部运行时配置

Med-PilotDeck 不打包、不安装、也不提交 MinerU 本体或模型。部署方提供一个已可用的 MinerU 运行时，并在启动导入任务的终端或服务配置中设置：

```bash
export MED_RAG_MINERU_LAUNCHER='"/path/to/python" -m mineru.cli.client'
export MED_RAG_MINERU_MODEL_ROOT='/path/to/mineru-pipeline-models'
export MED_RAG_RUNTIME_ROOT='/path/to/med-pilotdeck-rag-data'
```

- `MED_RAG_MINERU_LAUNCHER`：调用 MinerU 的命令；可为 `mineru`，也可为 Python 模块启动命令。它由团队共享环境、容器或每位开发者自己的环境提供。
- `MED_RAG_MINERU_MODEL_ROOT`：已下载的本地 pipeline 模型目录。解析过程使用本地模型，不会在运行时下载模型。
- `MED_RAG_RUNTIME_ROOT`：本次导入产生的模型缓存、解析产物、语料、索引和状态账本的专用数据盘目录；不得位于 `$HOME`。

启动前代码会校验命令可执行且模型目录存在。以上均是部署配置，不应提交真实服务器路径、Token 或模型文件到 Git。

导入代码通过 `MinerURuntime.from_environment()` 读取这些变量，再用
`MinerUInvocation.from_runtime(...)` 创建任务；因此运行时的位置属于部署配置，不属于仓库代码。
