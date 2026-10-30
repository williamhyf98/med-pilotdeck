export type XmlField = { label: string; value: string };
export type XmlLab = { name: string; value: string; unit: string; reference: string; flag: string };
export type XmlSection = { title: string; narrative: string; fields: XmlField[]; labs: XmlLab[] };
export type XmlReading = {
  document: Document;
  kind: 'clinical' | 'ecg' | 'generic';
  title: string;
  fields: XmlField[];
  sections: XmlSection[];
};

export const xmlChildren = (node: Element, name: string) => Array.from(node.children).filter(child => child.localName === name);
const child = (node: Element, name: string) => xmlChildren(node, name)[0];
const descendants = (node: Element, name: string) => Array.from(node.getElementsByTagNameNS('*', name));
const text = (node?: Element) => node?.textContent?.trim() || '';
function narrativeText(node?: Element): string {
  if (!node) return '';
  const read = (current: Node): string => {
    if (current.nodeType === 3 || current.nodeType === 4) return current.textContent || '';
    if (current.nodeType !== 1) return '';
    const element = current as Element;
    if (element.localName === 'br') return '\n';
    const value = Array.from(element.childNodes).map(read).join('');
    if (['paragraph', 'p', 'item', 'tr', 'list', 'table'].includes(element.localName)) return `${value}\n`;
    if (['td', 'th'].includes(element.localName)) return `${value}\t`;
    return value;
  };
  return read(node).trim();
}
const codeLabel = (node: Element) => {
  const code = child(node, 'code');
  return code?.getAttribute('displayName') || code?.getAttribute('code') || '';
};
const nodeValue = (node?: Element): string => {
  if (!node) return '';
  if (node.hasAttribute('nullFlavor')) return `未提供（${node.getAttribute('nullFlavor')}）`;
  return text(node) || node.getAttribute('value') || node.getAttribute('displayName') || node.getAttribute('code') || '';
};
const valueWithUnit = (node?: Element) => [nodeValue(node), node?.getAttribute('unit')].filter(Boolean).join(' ');
const observationField = (node: Element): XmlField => ({ label: codeLabel(node) || '未命名字段', value: valueWithUnit(child(node, 'value')) });
const sectionLabels: Record<string, string> = {
  '10154-3': '主诉', '10164-2': '现病史', '11348-0': '既往史', '10157-6': '家族史',
  '29762-2': '社会史', '48765-2': '过敏史', '8716-3': '生命体征', '29545-1': '体格检查',
  '29548-5': '诊断', '30954-2': '检查与检验', '18782-3': '影像检查',
  '11369-6': '预防接种史', '56836-0': '输血史', '49033-4': '月经史',
};

function labRow(cluster: Element): XmlLab | null {
  const observations = descendants(cluster, 'observation');
  const find = (label: string) => observations.find(node => codeLabel(node) === label);
  const result = find('检验定量结果');
  if (!result) return null;
  const resultCode = find('检验结果代码');
  const labelNode = resultCode && child(resultCode, 'value');
  const display = labelNode?.getAttribute('displayName');
  const code = labelNode?.getAttribute('code');
  const idNode = find('检验项目代码');
  const internalId = idNode ? nodeValue(child(idNode, 'value')) : '';
  const valueNode = child(result, 'value');
  const unitObservation = find('检查定量结果计量单位');
  const range = descendants(result, 'referenceRange')[0];
  const rangeValue = range && descendants(range, 'value')[0];
  const low = rangeValue && child(rangeValue, 'low');
  const high = rangeValue && child(rangeValue, 'high');
  const flag = child(result, 'interpretationCode');
  return {
    name: (display && !['z', '-', '***'].includes(display) ? display : '')
      || (code && !/^\d+$/.test(code) ? code : '')
      || (internalId ? `院内项目代码 ${internalId}` : '项目名称未提供'),
    value: nodeValue(valueNode),
    unit: valueNode?.getAttribute('unit') || (unitObservation && nodeValue(child(unitObservation, 'value'))) || '',
    reference: (range && text(descendants(range, 'text')[0])) || (rangeValue && (low || high ? `${nodeValue(low) || '…'} ～ ${nodeValue(high) || '…'}` : nodeValue(rangeValue))) || '',
    flag: flag?.getAttribute('displayName') || flag?.getAttribute('code') || '',
  };
}

export function parseXmlPreview(source: string): XmlReading {
  if (source.length > 8 * 1024 * 1024) throw new Error('文件较大，请使用源码视图查看。');
  // Never resolve an uploaded document's DTD, stylesheet or external entities.
  if (/<!DOCTYPE\s/i.test(source)) throw new Error('此文件包含 DTD 声明，请使用源码视图查看。');
  // Text-file reads retain the decoded BOM. Chrome 153's XML parser rejects
  // that leading character, although older browsers accept it. Strip only
  // the encoding marker from the parse copy, never from the editor buffer.
  const document = new DOMParser().parseFromString(source.replace(/^\uFEFF/, ''), 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('XML 格式不完整或存在语法错误，请在源码视图查看。');
  const root = document.documentElement;
  const result: XmlReading = { document, kind: 'generic', title: root.localName, fields: [], sections: [] };
  if (root.localName === 'AnnotatedECG') {
    result.kind = 'ecg';
    result.title = '心电原始记录';
    const leads = descendants(root, 'code').map(node => node.getAttribute('code') || '').filter(code => /LEAD/i.test(code));
    result.fields.push({ label: '导联', value: [...new Set(leads)].join('、') || '未提供' });
    result.fields.push({ label: '波形数据段', value: String(descendants(root, 'digits').length) });
    const increment = descendants(root, 'increment').find(node => node.getAttribute('unit') === 's');
    const interval = Number(increment?.getAttribute('value'));
    if (Number.isFinite(interval) && interval > 0) result.fields.push({ label: '采样率', value: `${Number((1 / interval).toFixed(4))} Hz` });
    return result;
  }
  if (root.localName !== 'ClinicalDocument') return result;
  result.kind = 'clinical';
  result.title = text(child(root, 'title')) || '临床文书';
  const patient = descendants(root, 'patient')[0];
  if (patient) {
    for (const [tag, label] of [['name', '姓名'], ['administrativeGenderCode', '性别'], ['age', '年龄'], ['birthTime', '出生日期']] as const) {
      const value = valueWithUnit(child(patient, tag));
      if (value) result.fields.push({ label, value });
    }
  }
  const time = nodeValue(child(root, 'effectiveTime'));
  if (time) result.fields.push({ label: '文档时间', value: time });
  result.sections = descendants(root, 'section').map(section => {
    const code = child(section, 'code');
    const fields = descendants(section, 'observation')
      .filter(node => {
        // Nested sections and laboratory clusters render independently.
        let parent = node.parentElement;
        while (parent && parent !== section) {
          if (parent.localName === 'section' || (parent.localName === 'organizer' && parent.getAttribute('classCode') === 'CLUSTER' && labRow(parent))) return false;
          parent = parent.parentElement;
        }
        return true;
      })
      .map(observationField)
      .filter(field => field.value !== '');
    const labs = descendants(section, 'organizer')
      .filter(node => node.getAttribute('classCode') === 'CLUSTER')
      .map(labRow).filter((row): row is XmlLab => row !== null);
    return {
      title: text(child(section, 'title')) || sectionLabels[code?.getAttribute('code') || ''] || codeLabel(section) || '其他内容',
      narrative: narrativeText(child(section, 'text')),
      fields,
      labs,
    };
  });
  return result;
}

// Explicit source edit only. Preserve mixed content, CDATA and xml:space.
export function formatXml(source: string): string {
  const { document } = parseXmlPreview(source);
  const serializer = new XMLSerializer();
  const visit = (element: Element, depth: number) => {
    if (depth > 100 || element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space') === 'preserve') return;
    if (Array.from(element.childNodes).some(node => node.nodeType === 4 || (node.nodeType === 3 && node.textContent?.trim()))) return;
    if (!element.children.length) return;
    Array.from(element.childNodes).filter(node => node.nodeType === 3 && !node.textContent?.trim()).forEach(node => node.remove());
    for (const node of Array.from(element.childNodes)) {
      element.insertBefore(document.createTextNode(`\n${'  '.repeat(depth + 1)}`), node);
      if (node.nodeType === 1) visit(node as Element, depth + 1);
    }
    element.appendChild(document.createTextNode(`\n${'  '.repeat(depth)}`));
  };
  visit(document.documentElement, 0);
  const declaration = source.replace(/^\uFEFF/, '').match(/^<\?xml[^?]*\?>/)?.[0];
  // Chromium preserves the XML declaration; other DOM implementations omit it.
  const serialized = serializer.serializeToString(document).replace(/^<\?xml\s[^?]*\?>\s*/, '');
  return `${declaration ? `${declaration}\n` : ''}${serialized}`;
}
