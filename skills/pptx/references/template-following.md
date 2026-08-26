# 遵循模板

## 安全模型

将所提供的 PPTX 同时视为视觉规范和可编辑对象清单。复制源幻灯片，然后仅修改经已验证框架映射授权的命名对象。当可以继承源对象时，不要从零重建视觉上相似的幻灯片。

动画、嵌入的音频/视频、OLE 对象、宏、SmartArt、扩展图表，以及仅放在幻灯片版式上的复杂内容属于高风险。尽可能原样保留。如果所要求的编辑需要不安全的结构性更改，则停止。

## 检查整个源文件

规划前运行 `inspect` 和 `render`。审阅每一张幻灯片，而不仅是选定输出的页面。记录：

- 幻灯片尺寸、顺序、母版、版式、主题字体和颜色。
- 对象名称、ID、类型、边界和可见文本。
- 可复用的页面族和内容密度。
- 页脚、页码标记、标志和品牌装饰。
- 应保持未改动的风险对象。

## 框架映射模式

```json
{
  "version": 1,
  "source": "/absolute/path/template.pptx",
  "slides": [
    {
      "outputSlide": 1,
      "sourceSlide": 3,
      "editTargets": [
        { "name": "Title 1", "action": "replace-text" },
        { "name": "Hero Image", "action": "replace-image" }
      ]
    }
  ]
}
```

允许的操作为 `replace-text`、`replace-image`、`replace-table` 和 `remove`。优先使用 `inspect` 发出的精确对象名。

## 编辑模式

```json
{
  "slides": [
    {
      "outputSlide": 1,
      "operations": [
        { "type": "text", "target": "Title 1", "value": "New audience-facing title" },
        { "type": "image", "target": "Hero Image", "path": "/absolute/path/hero.png" }
      ]
    }
  ]
}
```

表格操作使用 `rows`，每一行是一个数组或 `{ "label": "row-1", "values": [...] }`。删除操作只需要 `type` 和 `target`。

每一项操作都必须匹配框架映射中的一项动作。CLI 会拒绝未声明的编辑。

## 保真度流程

1. 构建未经编辑的起始演示文稿。
2. 以相同 DPI 渲染源文件和起始稿。
3. 运行 `fidelity` 并检查每一张有差异的页面。
4. 仅在无法解释的起始差异解决之后再应用编辑。
5. 渲染并审计已编辑的输出。

像素比较是信号，不能替代检查。字体替换和渲染器差异可能产生细小的合理偏差。
