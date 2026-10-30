# Excalidraw 模式

信封：

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "openclaw/diagram-maker",
  "elements": [],
  "appState": { "viewBackgroundColor": "#ffffff" }
}
```

带标签的圆角矩形：

```json
{
  "type": "rectangle",
  "id": "svc",
  "x": 100,
  "y": 100,
  "width": 180,
  "height": 72,
  "roundness": { "type": 3 },
  "backgroundColor": "#a5d8ff",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "roughness": 1,
  "opacity": 100,
  "boundElements": [{ "id": "svc_text", "type": "text" }]
}
```

绑定文本：

```json
{
  "type": "text",
  "id": "svc_text",
  "x": 112,
  "y": 124,
  "width": 156,
  "height": 24,
  "text": "API service",
  "originalText": "API service",
  "fontSize": 20,
  "fontFamily": 1,
  "strokeColor": "#1e1e1e",
  "textAlign": "center",
  "verticalAlign": "middle",
  "containerId": "svc",
  "autoResize": true
}
```

绑定箭头：

```json
{
  "type": "arrow",
  "id": "a1",
  "x": 280,
  "y": 136,
  "width": 140,
  "height": 0,
  "points": [
    [0, 0],
    [140, 0]
  ],
  "endArrowhead": "arrow",
  "startBinding": { "elementId": "svc", "fixedPoint": [1, 0.5] },
  "endBinding": { "elementId": "db", "fixedPoint": [0, 0.5] }
}
```

调色板：

- 主要/输入：`#a5d8ff`
- 处理：`#d0bfff`
- 成功/输出：`#b2f2bb`
- 存储/数据：`#c3fae8`
- 外部/警告：`#ffd8a8`
- 错误/风险：`#ffc9c9`
- 备注/决策：`#fff3bf`
