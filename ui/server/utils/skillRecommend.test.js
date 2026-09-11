import { describe, expect, it } from 'vitest';
import { isAvailableIn, recommendSkills, tokenize } from './skillRecommend.js';

/**
 * Trimmed copies of the shipped SKILL.md frontmatter. Kept as a fixture rather
 * than read off disk so a wording tweak in a skill doesn't fail the algorithm
 * tests — but the wording here should stay close to the real descriptions,
 * because that is what the scorer actually sees.
 */
const SKILLS = [
  {
    slug: 'med-role-emergency',
    name: 'med-role-emergency',
    scope: 'medical',
    department: 'emergency',
    availability: ['global'],
    description:
      '以急诊科医生视角组织回答：先分诊定级，再排除致命性诊断，最后给首小时处置顺序。适用于未分诊的急性症状——胸痛、腹痛、呼吸困难、昏迷、抽搐、休克、高热、外伤初到、中毒。',
  },
  {
    slug: 'med-role-critical-care',
    name: 'med-role-critical-care',
    scope: 'medical',
    department: 'critical-care',
    availability: ['global'],
    description:
      '以重症医学科（ICU）医生视角组织回答，按器官系统逐项给支持目标值与撤离条件。适用于已收治重症患者的持续管理——机械通气与呼吸机参数、PEEP、脱机、血流动力学与血管活性药、镇痛镇静、脓毒症、CRRT、肠内营养。',
  },
  {
    slug: 'med-role-orthopedics',
    name: 'med-role-orthopedics',
    scope: 'medical',
    department: 'orthopedics',
    availability: ['global'],
    description:
      '以骨科医生视角组织回答：定位、分型、稳定性判断、固定方式与手术指征。适用于骨、关节、脊柱与肢体损伤——骨折、脱位、韧带损伤、骨筋膜室综合征、开放伤清创、内固定与外固定、负重与康复时机。',
  },
  {
    slug: 'med-role-laboratory',
    name: 'med-role-laboratory',
    scope: 'medical',
    department: 'laboratory',
    availability: ['global'],
    description:
      '以检验科医生视角组织回答：先判断标本与方法学是否可靠，再按项目组解读异常值、给危急值处置与复查建议。适用于已有检验数值——血常规、生化、电解质、凝血、血气、乳酸、心肌标志物、血培养。',
  },
  {
    slug: 'med-trauma-stage-plan',
    name: 'med-trauma-stage-plan',
    scope: 'medical',
    availability: ['war_trauma'],
    description:
      '生成战创伤分级救治方案。当用户需要针对伤员发生地/野战分类场/收容处置组/重伤救治组/手术组/洗消组之一给出结构化救治方案时使用。',
  },
  {
    slug: 'pptx',
    name: 'pptx',
    scope: 'builtin',
    availability: ['global'],
    description:
      '创建、读取、审计和安全修改 Microsoft PowerPoint .pptx 演示文稿。输入或交付物是 .pptx 时使用本技能。',
  },
  {
    slug: 'docx',
    name: 'docx',
    scope: 'builtin',
    availability: ['global'],
    description:
      '读取、创建、编辑、审阅、渲染并校验工作区 Microsoft Word .docx 文档。输入或交付物是 .docx 时使用本技能，包括把对话里刚生成的方案、病例报告导出为 Word。',
  },
];

const top = (query, options) => recommendSkills(query, SKILLS, options)[0]?.slug ?? null;

describe('tokenize', () => {
  it('splits CJK runs into adjacent-character bigrams', () => {
    expect([...tokenize('战创伤')]).toEqual(['战创', '创伤']);
  });

  it('keeps latin runs whole and lowercases them', () => {
    expect([...tokenize('PEEP and CT')]).toEqual(['peep', 'and', 'ct']);
  });

  it('drops single-character latin runs but keeps a lone CJK character', () => {
    expect([...tokenize('X光')]).toEqual(['光']);
  });

  it('returns nothing for punctuation-only or empty input', () => {
    expect([...tokenize('，。！')]).toEqual([]);
    expect([...tokenize('')]).toEqual([]);
    expect([...tokenize(undefined)]).toEqual([]);
  });
});

describe('isAvailableIn', () => {
  it('passes everything when the project type is unknown', () => {
    expect(isAvailableIn({ availability: ['war_trauma'] }, null)).toBe(true);
  });

  it('keeps global skills in every project type', () => {
    expect(isAvailableIn({ availability: ['global'] }, 'general_medicine')).toBe(true);
  });

  it('hides a skill scoped to a different project type', () => {
    expect(isAvailableIn({ availability: ['war_trauma'] }, 'general_medicine')).toBe(false);
  });

  it('treats a missing availability list as unrestricted', () => {
    expect(isAvailableIn({}, 'general_medicine')).toBe(true);
  });
});

describe('recommendSkills', () => {
  it('routes an acute presentation to the emergency role', () => {
    expect(top('60岁男性突发胸痛30分钟，血压90/60')).toBe('med-role-emergency');
  });

  it('routes a fracture question to orthopedics', () => {
    expect(top('股骨干骨折需要手术吗')).toBe('med-role-orthopedics');
  });

  it('routes ventilator management to critical care', () => {
    expect(top('患者在ICU用呼吸机，PEEP怎么调')).toBe('med-role-critical-care');
  });

  it('routes lab values to the laboratory role', () => {
    expect(top('这份血气结果怎么解读，乳酸 6.2')).toBe('med-role-laboratory');
  });

  it('prefers pptx over other export skills when the user names the format', () => {
    // "PPT" is a strict prefix of "pptx"; docx also mentions 导出/方案 in prose.
    expect(top('帮我把这份方案导出成PPT')).toBe('pptx');
  });

  it('returns nothing for small talk', () => {
    expect(recommendSkills('今天天气怎么样', SKILLS)).toEqual([]);
    expect(recommendSkills('你好', SKILLS)).toEqual([]);
  });

  it('returns nothing for an empty or whitespace query', () => {
    expect(recommendSkills('', SKILLS)).toEqual([]);
    expect(recommendSkills('   ', SKILLS)).toEqual([]);
    expect(recommendSkills(null, SKILLS)).toEqual([]);
  });

  it('tolerates a missing or malformed skill list', () => {
    expect(recommendSkills('胸痛', null)).toEqual([]);
    expect(recommendSkills('胸痛', [])).toEqual([]);
    expect(recommendSkills('胸痛', [null, {}, { slug: '' }])).toEqual([]);
  });

  it('hides skills that are not offered in the current project type', () => {
    const query = '野战分类场的救治方案';
    expect(recommendSkills(query, SKILLS).map((s) => s.slug))
      .toContain('med-trauma-stage-plan');
    expect(recommendSkills(query, SKILLS, { projectType: 'general_medicine' })
      .map((s) => s.slug)).not.toContain('med-trauma-stage-plan');
  });

  it('skips a builtin that a user copy already shadows', () => {
    const shadowed = SKILLS.map((skill) => (
      skill.slug === 'pptx' ? { ...skill, overriddenBy: 'user' } : skill
    ));
    expect(recommendSkills('帮我把这份方案导出成PPT', shadowed).map((s) => s.slug))
      .not.toContain('pptx');
  });

  it('honours the limit and never exceeds it', () => {
    const results = recommendSkills('救治方案的报告导出', SKILLS, { limit: 1, minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('orders results by descending score', () => {
    const results = recommendSkills('救治方案报告', SKILLS, { minScore: 0 });
    const scores = results.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('reports the terms that drove the match', () => {
    const [best] = recommendSkills('股骨干骨折需要手术吗', SKILLS);
    expect(best.matchedTerms).toContain('骨折');
  });

  it('carries the department through for badge rendering', () => {
    const [best] = recommendSkills('股骨干骨折需要手术吗', SKILLS);
    expect(best.department).toBe('orthopedics');
  });
});
