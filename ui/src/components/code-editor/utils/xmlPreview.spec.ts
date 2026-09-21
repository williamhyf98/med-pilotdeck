// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { formatXml, parseXmlPreview } from './xmlPreview';

describe('XML reading model', () => {
  it('supports browsers that reject a leading BOM while retaining BOM characters inside text', () => {
    const parse = DOMParser.prototype.parseFromString;
    // Chrome 153 rejects the decoded U+FEFF before an XML declaration.
    const strictParser = vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(function (this: DOMParser, source, type) {
      return parse.call(this, String(source).startsWith('\uFEFF') ? '<parsererror>Unexpected characters outside the root element</parsererror>' : source, type);
    });
    try {
      const source = '\uFEFF<?xml version="1.0" encoding="UTF-8"?><ClinicalDocument><title>记录\uFEFF正文</title></ClinicalDocument>';
      expect(parseXmlPreview(source).title).toBe('记录\uFEFF正文');
      expect(parseXmlPreview(formatXml(source)).title).toBe('记录\uFEFF正文');
    } finally {
      strictParser.mockRestore();
    }
  });
  it('reads the real admission fixture without dropping negative findings', () => {
    const source = readFileSync('../plugins/med-tools/tests/fixtures/admission-note.cda.xml', 'utf8');
    const result = parseXmlPreview(source);
    expect(result.kind).toBe('clinical');
    expect(result.title).toBe('入院记录');
    expect(result.sections.length).toBeGreaterThan(5);
    expect(result.sections.flatMap(section => section.fields).some(field => field.value === '无')).toBe(true);
  });
  it('reads named lab items from the real fixture without guessing internal codes', () => {
    const result = parseXmlPreview(readFileSync('../plugins/med-tools/tests/fixtures/lab-biochem.cda.xml', 'utf8'));
    expect(result.sections.flatMap(section => section.labs).map(lab => lab.name)).toEqual(expect.arrayContaining(['cTnI', 'MYO', 'NT-proBNP']));
  });
  it('preserves zero, false, units, CDATA and arbitrary attributes', () => {
    const result = parseXmlPreview('<ClinicalDocument><title>记录</title><component><section><title>检查</title><entry><observation><code displayName="疼痛评分"/><value value="0" unit="分"/></observation></entry><entry><observation><code displayName="过敏"/><value value="false"/></observation></entry><text><![CDATA[未见异常]]></text><extra custom="保留"/></section></component></ClinicalDocument>');
    expect(result.sections[0].fields).toEqual(expect.arrayContaining([{ label: '疼痛评分', value: '0 分' }, { label: '过敏', value: 'false' }]));
    expect(result.sections[0].narrative).toBe('未见异常');
    expect(result.document.documentElement.querySelector('extra')?.getAttribute('custom')).toBe('保留');
  });
  it('supports prefixed namespaces and falls back for unknown documents', () => {
    expect(parseXmlPreview('<c:ClinicalDocument xmlns:c="urn:hl7-org:v3"><c:title>报告</c:title></c:ClinicalDocument>').title).toBe('报告');
    expect(parseXmlPreview('<config><item value="0"/></config>').kind).toBe('generic');
  });
  it('keeps narrative paragraphs and table cells separate', () => {
    const result = parseXmlPreview('<ClinicalDocument><component><section><text><paragraph>主诉</paragraph><paragraph>无胸痛<br/>无发热</paragraph><table><tr><td>指标</td><td>0</td></tr></table></text></section></component></ClinicalDocument>');
    expect(result.sections[0].narrative).toBe('主诉\n无胸痛\n无发热\n指标\t0');
  });
  it('rejects malformed XML and external entity declarations', () => {
    expect(() => parseXmlPreview('<root>')).toThrow();
    expect(() => parseXmlPreview('<!DOCTYPE r [<!ENTITY e SYSTEM "file:///secret">]><r>&e;</r>')).toThrow();
  });
  it('formats element-only structure without changing mixed text or CDATA', () => {
    const source = '<r><p>前 <b>中</b> 后</p><value><![CDATA[  无\n0  ]]></value></r>';
    const formatted = formatXml(source);
    expect(formatted).toContain('\n  <p>前 <b>中</b> 后</p>');
    expect(parseXmlPreview(formatted).document.documentElement.textContent?.replace(/\n  (?=<)/g, '')).toContain('前 中 后');
    expect(formatted).toContain('<![CDATA[  无\n0  ]]>');
    expect(formatXml('<r xml:space="preserve"><a/><b/></r>')).toBe('<r xml:space="preserve"><a/><b/></r>');
    const declared = formatXml('<?xml version="1.0" encoding="UTF-8"?><r><a/></r>');
    expect(declared.match(/<\?xml/g)).toHaveLength(1);
    expect(parseXmlPreview(declared).kind).toBe('generic');
  });
});
