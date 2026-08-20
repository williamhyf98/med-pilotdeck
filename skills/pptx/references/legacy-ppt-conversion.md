# 旧版 PPT 转换

## 支持约定

仅将二进制 PowerPoint 97–2003 `.ppt` 作为保留源接受。用 LibreOffice 将其转换为不同的 `.pptx`，然后使用正常的 OOXML 检查、模板、审计、渲染和交付工作流。切勿承诺原生 `.ppt` 编辑、`.ppt` 输出或无损迁移。

```bash
bash "$PPTX" convert \
  --input source.ppt \
  --out "$WORKSPACE/tmp/source-converted.pptx" \
  --qa-dir "$WORKSPACE/legacy-conversion-qa"
```

该命令根据文件字节检测格式，而不是信任扩展名。被重命名的 PPTX 会规范化且不经过旧版转换。无效或损坏的二进制文件以失败关闭，并且不会创建所要求的输出。

## 核验

转换命令会：

1. 在转换前后对源文件求哈希。
2. 用 LibreOffice 渲染源 `.ppt`。
3. 通过 `Impress MS PowerPoint 2007 XML` 筛选器进行转换。
4. 解析转换后的 OOXML，并核验非空的幻灯片清单。
5. 以相同 DPI 渲染转换后的 `.pptx`。
6. 比较页数和成对的栅格输出。
7. 仅在结构检查通过后原子写入所要求的 `.pptx`。

页数不匹配、源被改动、无效 OOXML、缺失渲染输出或转换失败会阻断结果。视觉差异警告需要全尺寸审阅和兼容性说明。

## 已知限制

不要声称 LibreOffice 会保留所有旧版 PowerPoint 行为。明确披露以下风险：

- VBA 宏，无法保留在 `.pptx` 中。
- 旧版动画、切换、WordArt 和组织图。
- 嵌入的 OLE 对象、链接文件、音频和视频。
- 可编辑图表数据和非常用的 PowerPoint 97–2003 对象。
- 缺失字体、文本重排和目标阅读器替换。
- 受密码保护或损坏的文件。

对于高风险归档迁移，请用户在 Microsoft PowerPoint 中对转换后的文件做冒烟测试。PowerPoint 是目标阅读器权威；LibreOffice 提供自动化转换和基线渲染。
