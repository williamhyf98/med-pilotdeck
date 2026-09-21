/** General medicine: professional identity, medical project work, durable feedback. */
import type { MemoryPromptProfile } from "./types.js";
import { SHARED_FRAGMENTS, CLASSIFY_JSON_CONTRACT, buildNoteCreateJsonContract } from "./shared.js";

const EVIDENCE_RULES = `- 以焦点用户轮次为依据，相邻对话仅用于消歧。助手单独提出的推测、建议或结论不构成已确认事实；用户明确确认的内容仅按其确认范围记录。
- 项目是工作空间，可包含病例、科研、教学和文献分析；不要求用户选择用途、绑定患者或判断是否为同一患者。
- 保留已有病例指代、文献来源、时间、适用范围及“假设、疑似、待排查、否认、已纠正”等限定。不能把文献病例、研究人群或教学情境改写成当前患者的确定事实。
- 只提取有持续价值的信息；普通知识提问、一次性指令、文献全文和无依据的结论不应自动沉淀。“请记住”是持久化信号，但不能突破类别、证据和隐私边界。`;

const FEEDBACK_SCOPE = `- 持续性的回答格式、详略、语言、结论顺序、证据呈现、协作流程和文件/工具边界属于 feedback。即使用户说“所有项目”“以后都如此”，也不进入全局画像；只在当前项目保存，不承诺跨项目生效。
- “这次”“本轮”“下一轮”等临时表达要求通常由会话上下文处理，不创建长期 Feedback，不能改写成“以后每轮”。未说明期限时，仅明确表达持续习惯或默认规则才保存，不自行扩大时效。
- 混合内容分别提取：临时要求不保存，不影响同轮病例事实或明确长期偏好的提取。偏好仅约束表达与协作，不能覆盖医学事实、证据或安全边界。`;

const NOTE_RULES = `${EVIDENCE_RULES}
${SHARED_FRAGMENTS.languageFollowRules}
- 最多创建一条当前类别的笔记，不混入其他类别；没有合格内容时返回 skip=true。
- name、description 和 markdown 均遵守事实与隐私规则，不保存患者可识别信息、原始附件路径或文件名。
- 保持简洁可读的 Markdown，按内容需要使用标题，不强制填满模板。
${SHARED_FRAGMENTS.jsonOnlyRule}`;

export const GENERAL_MEDICINE_PROFILE: MemoryPromptProfile = {
  type: "general_medicine",
  allowedTypes: ["user", "project", "feedback"],
  shared: SHARED_FRAGMENTS,
  classify: `你负责为通用医学长期记忆分类一个焦点用户轮次，此时不要生成记忆文件。
规则：
${EVIDENCE_RULES}
- 一轮可匹配多个类别，每类最多一次，分别给出证据，不把整句混合内容复制到每一类。
- user：用户持久的身份背景（机构、职务、资历、稳定职业角色）与专业领域（专业方向、长期擅长领域与临床场景）。
- project：当前项目值得持续保留的医学工作内容，包括病例、病史、过敏史、用药、检查结果、处置和诊疗线索，以及科研目标、纳排标准、调查结果、教学案例、文献分析结论和重要项目决策。
- feedback：持续有效的回答与协作要求，例如“以后默认表格展示”“每次把结论放在最后”。
- 具体病情、诊断、化验值、用药、既往史、过敏史及研究结果一律不属于 user，即使用户说“我有糖尿病”或内容在多个项目重复。专业擅长的疾病方向与具体患病事实必须区分。
${SHARED_FRAGMENTS.overrideTest}
${FEEDBACK_SCOPE}
- 例：“我是急诊科主治，擅长多发伤”属于 user；“患者青霉素过敏”属于 project；“论文中的病例青霉素过敏”仅在有持续研究价值时存 project，并保留来源与病例限定。
- 例：“假设患者过敏怎么办”是问题，不建立真实病史；明确需延续的教学案例可存 project，保留假设标记。“本研究排除青霉素过敏者”是纳排标准，不是患者过敏史。
- 例：“我是骨科医生，这位患者青霉素过敏，以后用表格回答”分别提取 user、project、feedback；“下一轮用表格”单独出现时不存长期记忆。
- 没有值得持久记忆的内容时返回 should_store=false 且 labels=[]。
${SHARED_FRAGMENTS.jsonOnlyRule}
${CLASSIFY_JSON_CONTRACT}`,
  noteCreate: {
    user: `你创建一条仅追加的 user 记忆笔记，用于全局用户画像。
- 只记录身份背景或专业领域。身份背景描述机构、职务、资历和稳定角色；专业领域描述专业方向、擅长领域与长期临床场景。
- 不包含具体病例、用户自身病史、患者信息、研究结果、项目进展或回答/协作偏好。研究某疾病不代表患有该疾病。
- 只保留本轮新增的画像事实，不重写完整画像，不增加临床偏好或协作偏好段落。
${NOTE_RULES}
${buildNoteCreateJsonContract("user")}`,
    project: `你创建一条仅追加的 project 记忆笔记，只属于当前项目。
- 保存有持续价值的病例、病史、过敏史、手术史、用药、检查、处置和诊疗线索；科研目标、方法、纳排标准、调查结果；教学案例、文献分析结论；项目范围、重要决定及进展。
- 不假设一个项目只有一位患者，不把多段资料汇总成同一人的病史；沿用输入已有的指代和来源，不另建患者标识，不因涉及不同患者而拒绝整个轮次。
- 过敏史、重要用药和禁忌信息保留原表述、时间、否认或纠正状态，不静默覆盖冲突，不补写缺失值。
- 文献结论保留已知出处、研究对象和适用范围，只记有助后续工作的要点，不复制全文，不提升为无条件医学结论。
- 不记录用户画像或回答偏好。可按内容使用“病例资料”“研究上下文”“教学情境”“文献要点”等标题，无需固定子类型字段。
${NOTE_RULES}
${buildNoteCreateJsonContract("project")}`,
    feedback: `你创建一条仅追加的 feedback 记忆笔记，只属于当前项目。
${FEEDBACK_SCOPE}
- 可记录汇报格式、术语表达、详略、引用呈现和交付顺序等持续要求；不能把某次治疗建议或患者用药记录当成协作规则。
- 保留明确适用条件，例如“病例汇报时”，不扩展到所有任务。用户明确修改旧偏好时记录新要求和替代关系。
- 只有临时要求、病例事实、研究结果或助手自行提出的偏好时，返回 skip=true。
${NOTE_RULES}
${buildNoteCreateJsonContract("feedback")}`,
  },
};
