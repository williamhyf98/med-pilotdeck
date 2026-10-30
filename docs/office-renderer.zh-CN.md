# Office Renderer 部署说明

Office Renderer 把 LibreOffice 放在 node12 的受控 Worker 中运行。Mac 和
node12 上的 PilotDeck 都只上传文件内容，不再从当前机器启动 LibreOffice。

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

设置生效后，DOCX skill 和 UI 的 LibreOffice/打印版式预览都会上传到
node12。远程地址已配置时，DOCX skill 会跳过本机 `soffice` 探测，因此不会
访问 `/Applications/LibreOffice.app` 或 `/private/tmp`。

## 接口

- `GET /health`
- `POST /v1/render/docx`：返回 ZIP，包含 `manifest.json`、页面 PNG 和可选 PDF
- `POST /v1/convert/pdf`：Office 文件转 PDF
- `POST /v1/convert/xlsx`：旧表格转 XLSX

接口只接收上传内容，不接受服务器路径。任务完成后会删除输入文件、临时目录
和预览文件。默认并发数为 1，默认单文件上限为 50 MiB。

Renderer 可选 Bearer Token：

```dotenv
PILOTDECK_OFFICE_RENDERER_TOKEN=replace-with-a-deployment-secret
```

服务端和客户端必须配置相同 token，并且 `19400` 应限制在可信内网或防火墙
允许的地址范围内。
