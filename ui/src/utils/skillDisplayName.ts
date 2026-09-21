const SKILL_DISPLAY_NAMES: Record<string, string> = {
  '1password': '密码与密钥管理',
  'apple-notes': '苹果备忘录管理',
  'apple-reminders': '苹果提醒事项管理',
  'bear-notes': 'Bear 笔记管理',
  blogwatcher: '博客与订阅监控',
  'diagram-maker': '图示制作',
  docx: 'Word 文档处理',
  'find-skills': '技能发现与安装',
  'frontend-design': '前端界面设计',
  'frontend-slides': '网页演示制作',
  github: 'GitHub 协作管理',
  gog: 'Google 工作区管理',
  himalaya: '邮件收发与管理',
  'karpathy-guidelines': '稳健编码指南',
  'med-case-report': '结构化病例报告',
  'med-role-emergency': '急诊科诊疗助手',
  'med-role-critical-care': '重症医学诊疗助手',
  'med-role-orthopedics': '骨科诊疗助手',
  'med-role-radiology': '影像科判读助手',
  'med-role-laboratory': '检验结果分析助手',
  'med-role-burn': '烧伤科诊疗助手',
  'med-medical': '医疗附件解析',
  'med-trauma-assist': '战创伤知识问答',
  'med-trauma-stage-plan': '战创伤分阶段救治方案',
  'meeting-recorder-assistant': '会议录音与纪要',
  'minimax-pdf': '精美 PDF 制作',
  notion: 'Notion 内容管理',
  obsidian: 'Obsidian 知识库管理',
  pdf: 'PDF 文档处理',
  'pilotdeck-skills-migration': '技能迁移',
  pptx: 'PowerPoint 演示文稿处理',
  'react-next-best-practices': 'React 与 Next.js 开发实践',
  'skill-creator': '技能创建与优化',
  spreadsheets: '电子表格处理',
  spike: '可行性快速验证',
  summarize: '内容总结与转录',
  tmux: '终端会话管理',
  trello: 'Trello 任务管理',
  weather: '天气查询',
  'web-design-guidelines': '网页界面质量审查',
};

export function skillDisplayName(skill: { slug: string; name: string }): string {
  const mapped = SKILL_DISPLAY_NAMES[skill.slug.toLowerCase()];
  if (mapped) return mapped;
  if (/\p{Script=Han}/u.test(skill.name)) return skill.name;
  return `自定义技能：${skill.name}`;
}
