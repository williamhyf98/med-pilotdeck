# Office Renderer 部署说明

Office Renderer 把 LibreOffice 放在 node12 的受控 Worker 中运行。Mac 和医院
应用端的 PilotDeck 都只上传文件内容，不再从当前机器启动 LibreOffice；node12
仅作为渲染服务节点保留 LibreOffice 后端。

## node12

Renderer 默认监听 `0.0.0.0:19400`，启动和停止：

```bash
bash scripts/start-office-renderer.sh
bash scripts/stop-office-renderer.sh
curl http://127.0.0.1:19400/health
```

node12 的 `scripts/config.env` 使用：

```dotenv
PILOTDECK_OFFICE_RENDERER_ROLE=server
PILOTDECK_OFFICE_RENDERER_PORT=19400
PILOTDECK_OFFICE_RENDERER_URL=http://127.0.0.1:19400
```

`start-local.sh` 在 `ROLE=server` 时会一并启动 Renderer。Worker 需要
LibreOffice Writer、`bwrap`、项目 `.runtime` 和已准备好的 DOCX Python
运行时；这些目录在 Worker 中只读挂载，单个任务目录是唯一可写目录。

## Mac

Mac 不需要安装或授权本地 LibreOffice。`scripts/config.env` 使用 node12
地址：

```dotenv
PILOTDECK_OFFICE_RENDERER_ROLE=remote
PILOTDECK_OFFICE_RENDERER_PORT=19400
PILOTDECK_OFFICE_RENDERER_URL=http://10.31.112.13:19400
```

设置生效后，DOCX、PPTX、XLSX skill 和 UI 的 Office 转换、公式重算、打印版式
预览都会上传到 node12。客户端远程地址已配置时不会探测本机 `soffice`，因此
不会访问 `/Applications/LibreOffice.app` 或启动本机 LibreOffice。

## 接口

- `GET /health`
- `POST /v1/render/docx`：返回 ZIP，包含 `manifest.json`、页面 PNG 和可选 PDF
- `POST /v1/render/pptx`、`POST /v1/render/xlsx`：返回逐页 PNG 和可选 PDF 的 ZIP
- `POST /v1/convert/pdf`：Office 文件转 PDF
- `POST /v1/convert/xlsx`：旧表格转 XLSX
- `POST /v1/convert/pptx`：旧版 PPT 转 PPTX
- `POST /v1/convert/xls`：用于回归测试的 XLSX 转 XLS
- `POST /v1/convert/ppt`：用于回归测试的 PPTX 转 PPT

接口只接收上传内容，不接受服务器路径。任务完成后会删除输入文件、临时目录
和预览文件。默认并发数为 1，默认单文件上限为 50 MiB。

Renderer 可选 Bearer Token：

```dotenv
PILOTDECK_OFFICE_RENDERER_TOKEN=replace-with-a-deployment-secret
```

服务端和客户端必须配置相同 token，并且 `19400` 应限制在可信内网或防火墙
允许的地址范围内。

## 不可用时的交付语义

结构审计、OOXML 校验等本地能力通过后，即使 Renderer 暂时不可达，PPTX/XLSX/DOCX
仍可交付；结果必须明确标记“未完成视觉验收”，公式重算和旧格式转换也必须标记为
未完成或不可用。不得把结构校验结果描述成已经完成页面视觉验收。
