# 排版与字体

## 优先级

按此顺序选择排版：

1. 明确的用户或品牌方向。
2. 从所提供 PPTX 继承的主题字体。
3. 用户要求的目标平台配置。
4. 根据内容语言推断的 PilotDeck 跨平台配置。

切勿仅仅因为存在 PilotDeck 默认字体，就替换所提供模板的字体。

## 配置

在创建全新演示文稿之前解析版式令牌：

```js
const tokens = await resolveDesignTokens({
  lang: 'zh-CN',
  profile: 'cross-platform-zh',
  density: 'presentation',
});
const pptx = await createDeck({ lang: 'zh-CN', tokens });
```

可用配置：

- `cross-platform-en`：Arial，用于广泛的 macOS 和 Windows 兼容性。
- `office-en`：Aptos，用于已知的现代 Microsoft Office 受众。
- `cross-platform-zh`：Arial 作为逻辑拉丁字体，并为中文预留保守的回退空间。
- `windows-zh`：Microsoft YaHei，用于仅 Windows 目标。
- `macos-zh`：PingFang SC，用于仅 macOS 目标。
- `libreoffice-zh`：仅当渲染环境已安装该字体时使用 Noto Sans CJK SC。

PowerPoint 不接受 CSS 风格的字体栈。配置是 Harness 解析策略，而不是写入 PPTX 的逗号分隔字体名。

不存在可以假定在每台 macOS 和 Windows 系统上都已安装的中文字体。跨平台默认值追求可读、稳定的替换，而不是像素级一致输出。当必须使用相同排版时，要求共享的授权或可嵌入字体。

## 16:9 演示文稿的默认字号

| 元素 | 演示 | 密集报告 |
|---|---:|---:|
| 封面标题 | 32–44 pt | 28–34 pt |
| 章节标题 | 28–34 pt | 24–30 pt |
| 幻灯片标题 | 24–30 pt | 22–26 pt |
| 正文 | 16–20 pt | 14–17 pt |
| 图表标签 | 11–14 pt | 10–12 pt |
| 表格正文 | 12–15 pt | 10–12 pt |
| 脚注或来源 | 9–11 pt | 9–10 pt |

投影使用 `presentation` 密度，桌面阅读使用 `report` 密度。不要仅为消除适配警告，就把普通正文缩小到低于密集报告范围。

## 中文与中英混排的版式安全

- 中文正文使用大约 1.2–1.35 的行高系数。
- 为跨平台字体替换预留 10–15% 的垂直容量。
- 幻灯片标题尽可能保持一行，且不超过两行。
- 中文表格比同等英文表格给予更大的行高。
- 除非品牌系统要求更多，否则最多使用一个中文字族和一个拉丁字族。
- 保持图表数字和百分比一致；Arial 是安全的拉丁选择。
- 简体中文内容将演示语言设为 `zh-CN`。

## 兼容性解读

将 Microsoft PowerPoint 视为目标阅读器。LibreOffice 渲染是自动化基线。如果 PPTX 包含完整的中文 OOXML 文本，但 LibreOffice 替换或省略了字形，则报告渲染器兼容性警告，并在目标 PowerPoint 中对该同一产物做冒烟测试。不要仅为使 LibreOffice 基线看起来完全相同而重写一份有效的演示文稿。
