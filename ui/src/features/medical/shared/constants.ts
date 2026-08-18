/**
 * Medical UI constants.
 *
 * IMPORTANT: The server-side catalog (medicalCatalog.js) and plugin agent
 * profiles (plugins/medical-tools/agents/*.md) are the authoritative sources
 * for profiles, task modes, trauma stages, and model metadata.  This file
 * provides a UI-friendly mirror with icons for offline rendering and loading
 * states.  Always reconcile changes here with the server catalog and preset.
 */

import {
  Activity,
  Ambulance,
  BookOpenCheck,
  Boxes,
  ClipboardCheck,
  FileHeart,
  HeartPulse,
  Image,
  Images,
  Layers3,
  MessageCircle,
  Pill,
  ScanLine,
  Search,
  ShieldAlert,
  Siren,
  Table2,
} from 'lucide-react';
import type {
  MedicalTaskMode,
  TraumaImageCategory,
  TraumaResultSection,
  TraumaResultSectionId,
  TraumaStage,
} from './types';

export const MEDICAL_MODEL_STORAGE_KEY = 'pilotdeck-model';

export const MEDICAL_TASK_MODES: MedicalTaskMode[] = [
  {
    id: 'health-qa',
    label: '健康问答',
    shortLabel: '问答',
    description: '面向常见健康问题的循证解释与就医建议。',
    commandHint: '以健康问答模式回应，区分一般信息与需要线下就诊的风险信号。',
    icon: MessageCircle,
  },
  {
    id: 'war-trauma-diagnosis',
    label: '战创伤诊断',
    shortLabel: '战创伤',
    description: '快速梳理伤情、分级、处置重点与后送风险。',
    commandHint: '以战创伤辅助研判模式回应，优先给出威胁生命的问题、阶段处置和安全禁忌。',
    icon: Siren,
  },
  {
    id: 'report-interpretation',
    label: '报告解读',
    shortLabel: '报告',
    description: '解释检验与影像报告中的指标、趋势及局限。',
    commandHint: '以报告解读模式回应，逐项解释异常指标、可能意义、局限和复查建议。',
    icon: FileHeart,
  },
  {
    id: 'medicine-package-recognition',
    label: '药盒识别',
    shortLabel: '药物',
    description: '结合图片和文字识别药品信息并提示用药风险。',
    commandHint: '以药品信息辅助模式回应；无法确认包装或剂量时必须明确说明，不替代处方。',
    icon: Pill,
  },
  {
    id: 'deep-search',
    label: '深度搜索',
    shortLabel: '检索',
    description: '检索已配置医学语料，组织证据并给出来源。',
    commandHint: '优先调用可用的医学检索能力，按证据回答并列出可核验来源。',
    icon: Search,
  },
  {
    id: 'table-digitization',
    label: '表格电子化',
    shortLabel: '表格',
    description: '从图片或文档中提取结构化表格并支持后续整理。',
    commandHint: '以表格电子化模式回应，保留原始表头、单位和缺失值，不推测无法辨认的内容。',
    icon: Table2,
  },
];

export const TRAUMA_STAGES: TraumaStage[] = [
  {
    id: 'point-of-injury',
    index: 1,
    label: '伤员发生地',
    shortLabel: '发生地',
    description: '火线自救互救与威胁生命问题的即时处置。',
  },
  {
    id: 'field-triage',
    index: 2,
    label: '野战分类场',
    shortLabel: '分类场',
    description: '快速检伤分类、伤标记录和后送优先级判定。',
  },
  {
    id: 'reception-treatment',
    index: 3,
    label: '收容处置组',
    shortLabel: '收容组',
    description: '复评、复苏、基础检查与进一步分流。',
  },
  {
    id: 'critical-care',
    index: 4,
    label: '重伤救治组',
    shortLabel: '重伤组',
    description: '损伤控制复苏及重要脏器功能支持。',
  },
  {
    id: 'surgery',
    index: 5,
    label: '手术组',
    shortLabel: '手术组',
    description: '损伤控制手术、止血和污染控制。',
  },
  {
    id: 'decontamination',
    index: 6,
    label: '洗消组',
    shortLabel: '洗消组',
    description: '疑似化学、生物或放射污染伤员的隔离洗消。',
  },
];

export const TRAUMA_IMAGE_CATEGORIES: TraumaImageCategory[] = [
  { id: 'wound', label: '创面', description: '创口、烧伤、出血点', icon: Image },
  { id: 'xray', label: 'X 光', description: '骨骼及胸部平片', icon: ScanLine },
  { id: 'ecg', label: '心电', description: '心电图或监护截图', icon: Activity },
  { id: 'ct', label: 'CT', description: 'CT 截图或关键层面', icon: Layers3 },
  { id: 'other', label: '其他', description: '超声、检验及现场图片', icon: Images },
];

export const TRAUMA_RESULT_SECTIONS: TraumaResultSection[] = [
  {
    id: 'imaging',
    index: 1,
    title: '图像/影像判读',
    description: '可见征象、主要损伤与不确定性',
    icon: ScanLine,
  },
  {
    id: 'stage-action',
    index: 2,
    title: '阶段处置',
    description: '当前救治层级应立即完成的动作',
    icon: ClipboardCheck,
  },
  {
    id: 'specific-action',
    index: 3,
    title: '特异处置',
    description: '针对损伤机制与部位的专项措施',
    icon: HeartPulse,
  },
  {
    id: 'evacuation',
    index: 4,
    title: '分类/伤标/后送/交接',
    description: '优先级、交接要点和途中监护',
    icon: Ambulance,
  },
  {
    id: 'safety',
    index: 5,
    title: '安全禁忌',
    description: '高风险操作、复评触发条件与边界',
    icon: ShieldAlert,
  },
];

export const TRAUMA_DEMO_RESULTS: Record<TraumaResultSectionId, string> = {
  imaging:
    '演示判读：现场资料提示左下肢开放性损伤并持续渗血；上传影像仅用于辅助定位，需结合生命体征、神经血管检查和正式影像报告复核。',
  'stage-action':
    '立即按 MARCH 顺序复评，控制致命性出血并记录止血措施时间；维持气道、保温，建立连续监测并准备升级救治。',
  'specific-action':
    '覆盖污染创面并固定受伤肢体，固定前后记录远端循环、感觉与运动。避免反复探查创口或盲目复位。',
  evacuation:
    '演示分类为需优先后送。伤标应记录伤情机制、首次评估、处置时间、用药与复评变化；交接时明确止血装置和恶化风险。',
  safety:
    '本结果仅为界面演示，不构成诊断或处方。若出现意识下降、呼吸困难、循环不稳定或出血无法控制，应立即按当地急救流程升级处置。',
};

export const MEDICAL_CAPABILITY_META = {
  status: {
    title: '医疗能力状态',
    description: '检查 Gateway、sidecar、知识库和可选解析器。',
    icon: HeartPulse,
  },
  table: {
    title: '表格电子化',
    description: '上传表格图片或文档，校对识别结果并导出安全 CSV。',
    icon: Table2,
  },
  gallery3d: {
    title: '3D / Volume',
    description: '浏览三维数据集、上传体数据并查看关键切片。',
    icon: Boxes,
  },
} as const;

export const MEDICAL_SAFETY_NOTE =
  '仅用于辅助研判与教学演示，不能替代现场评估、正式诊断或专业医疗处置。';

export const MEDICAL_EVIDENCE_LABEL = {
  icon: BookOpenCheck,
  text: '启用后优先检索已配置语料并要求列出证据来源',
};
