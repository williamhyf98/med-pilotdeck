import { useMemo, useState } from 'react';
import { ChevronRight, FileText, ListTree } from 'lucide-react';
import { parseXmlPreview, type XmlField } from '../../utils/xmlPreview';

function Fields({ fields, sectionTitle }: { fields: XmlField[]; sectionTitle?: string }) {
  return <dl className="divide-y divide-border/50">{fields.map((field, index) => (
    <div key={index} className={`${field.value.length > 90 || field.label === sectionTitle ? 'space-y-1' : 'grid grid-cols-[minmax(5rem,28%)_minmax(0,1fr)] gap-4'} py-2.5 text-[13px] leading-7`}>
      <dt className={field.label === sectionTitle ? 'sr-only' : 'break-words text-muted-foreground'}>{field.label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{field.value}</dd>
    </div>
  ))}</dl>;
}

function LongText({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > 600;
  return <div className="min-w-0 whitespace-pre-wrap break-all text-[12px] leading-6 text-foreground">
    {long && !expanded ? `${value.slice(0, 300)}…` : value}
    {long && <button type="button" onClick={() => setExpanded(!expanded)} className="ml-2 rounded px-2 text-primary underline underline-offset-4">{expanded ? '收起' : `展开全部（${value.length.toLocaleString()} 字符）`}</button>}
  </div>;
}

function XmlNode({ element, depth = 0 }: { element: Element; depth?: number }) {
  const [open, setOpen] = useState(depth === 0);
  const [limit, setLimit] = useState(80);
  const children = Array.from(element.childNodes).filter(node => node.nodeType === 1 || Boolean(node.textContent?.trim()));
  const attrs = Array.from(element.attributes);
  return <div className="min-w-0 border-l border-border/60 pl-3">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex max-w-full items-start gap-1.5 rounded py-2 text-left text-[12px] hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
      <ChevronRight className={`mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      <span className="break-all font-mono font-medium">{element.tagName}</span>
      <span className="shrink-0 text-muted-foreground">{element.children.length ? `· ${element.children.length}` : ''}</span>
    </button>
    {open && <div className="min-w-0 space-y-1 pb-2 pl-2">
      {attrs.length > 0 && <dl className="mb-2 rounded-md bg-muted/50 px-3 py-2">{attrs.map(attr => <div key={attr.name} className="grid grid-cols-[minmax(4rem,30%)_minmax(0,1fr)] gap-3 py-0.5 text-[11px]"><dt className="break-all font-mono text-muted-foreground">{attr.name}</dt><dd className="break-all">{attr.value || '（空）'}</dd></div>)}</dl>}
      {children.length === 0 && <p className="text-xs text-muted-foreground">空节点</p>}
      {depth >= 60 ? <p className="text-xs text-muted-foreground">嵌套较深，请在源码视图继续查看。</p> : children.slice(0, limit).map((node, index) => node.nodeType === 1
        ? <XmlNode key={index} element={node as Element} depth={depth + 1} />
        : <div key={index}>{node.nodeType === 8 && <span className="text-xs text-muted-foreground">注释</span>}<LongText value={node.textContent || ''} /></div>)}
      {children.length > limit && depth < 60 && <button type="button" onClick={() => setLimit(limit + 80)} className="py-2 text-xs text-primary underline">继续显示（剩余 {children.length - limit} 项）</button>}
    </div>}
  </div>;
}

export default function XmlDocumentPreview({ content, mode, onSource }: { content: string; mode: 'content' | 'structure'; onSource: () => void }) {
  const parsed = useMemo(() => {
    try { return { value: parseXmlPreview(content), error: '' }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : '无法解析 XML' }; }
  }, [content]);
  const [showEmpty, setShowEmpty] = useState(false);
  if (!parsed.value) return <div className="p-6 text-sm leading-7 text-foreground"><p>{parsed.error}</p><button type="button" onClick={onSource} className="mt-3 text-primary underline">查看源码</button></div>;
  const model = parsed.value;
  const structure = <XmlNode key={content} element={model.document.documentElement} />;
  const emptyCount = model.sections.filter(section => !section.narrative && !section.fields.length && !section.labs.length).length;
  if (mode === 'structure' || model.kind === 'generic') return <div className="h-full overflow-auto bg-background p-5 text-foreground">
    <div className="mb-4 flex items-center gap-2 text-sm font-medium"><ListTree className="h-4 w-4 text-primary" />{model.kind === 'generic' ? '文档结构' : '完整 XML 结构'}</div>
    {model.kind === 'generic' && <p className="mb-4 text-xs leading-6 text-muted-foreground">此文档使用自定义结构。展开节点可查看文字和属性；编辑、搜索全文请切换源码。</p>}
    {structure}
  </div>;
  return <div className="h-full overflow-auto bg-background text-foreground">
    <article className="mx-auto max-w-4xl px-5 py-7 sm:px-8">
      <header className="mb-6 border-b border-border pb-5">
        <div className="mb-3 flex items-center gap-2 text-[11px] tracking-wide text-muted-foreground"><FileText className="h-4 w-4 text-primary" />{model.kind === 'ecg' ? '心电数据' : '医疗文书'}<span className="ml-auto">原文阅读</span></div>
        <h1 className="break-words text-2xl font-semibold leading-snug tracking-tight">{model.title}</h1>
        <div className="mt-4"><Fields fields={model.fields} /></div>
      </header>
      {model.kind === 'ecg' && <p className="mb-6 rounded-lg border border-border bg-muted/40 p-4 text-[13px] leading-7">本文件包含原始心电采样数据。当前展示记录信息，尚未绘制波形；各导联的完整数据可在下方结构中展开查看。</p>}
      {emptyCount > 0 && <label className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showEmpty} onChange={event => setShowEmpty(event.target.checked)} />显示空章节（{emptyCount}）</label>}
      {model.sections.map((section, index) => {
        if (!showEmpty && !section.narrative && !section.fields.length && !section.labs.length) return null;
        return <section key={index} className="mb-7">
          <h2 className="mb-3 border-l-2 border-primary pl-3 text-[15px] font-semibold leading-6">{section.title}</h2>
          {section.narrative && <p className="mb-3 whitespace-pre-wrap break-words text-[14px] leading-7">{section.narrative}</p>}
          <Fields fields={section.fields} sectionTitle={section.title} />
          {section.labs.length > 0 && <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-xs leading-6">
            <thead className="bg-muted/60 text-muted-foreground"><tr>{['检验项目', '结果', '单位', ...(section.labs.some(row => row.reference) ? ['参考范围'] : []), ...(section.labs.some(row => row.flag) ? ['原文标记'] : [])].map(label => <th key={label} className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody className="divide-y divide-border/60">{section.labs.map((row, rowIndex) => <tr key={rowIndex}><td className="min-w-28 px-3 py-2.5 font-medium">{row.name}</td><td className="px-3 py-2.5 tabular-nums">{row.value || '未提供'}</td><td className="px-3 py-2.5">{row.unit || '—'}</td>{section.labs.some(item => item.reference) && <td className="px-3 py-2.5">{row.reference || '—'}</td>}{section.labs.some(item => item.flag) && <td className="px-3 py-2.5">{row.flag || '—'}</td>}</tr>)}</tbody>
          </table></div>}
          {!section.narrative && !section.fields.length && !section.labs.length && <p className="text-xs text-muted-foreground">该章节未提供可识别正文，请在完整结构中查看。</p>}
        </section>;
      })}
      <details className="mt-8 border-t border-border pt-4"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">其他字段与完整结构</summary><p className="my-3 text-xs leading-6 text-muted-foreground">包括未归类字段、空节点、原始编码和文档属性。</p>{structure}</details>
    </article>
  </div>;
}
