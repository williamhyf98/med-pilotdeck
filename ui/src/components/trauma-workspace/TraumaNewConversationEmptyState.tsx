import medAssistantLogo from '../../assets/med-assistant-logo.png';

export default function TraumaNewConversationEmptyState({ noProject = false }: { noProject?: boolean }) {
  return (
    <div className="mx-auto flex h-full max-w-[760px] flex-col items-center justify-center px-6 py-10 text-center">
      <div className="pd-welcome-enter flex w-full flex-col items-center">
        <img
          src={medAssistantLogo}
          alt="Trauma Agent"
          className="mb-3 h-auto w-52 max-w-[65vw] object-contain"
        />
        <h2 className="text-balance text-[26px] font-semibold tracking-tight text-neutral-950 dark:text-neutral-50">
          战创伤救治推演助手
        </h2>
        <p className="mt-3 max-w-[560px] text-[14px] leading-7 text-neutral-600 dark:text-neutral-300">
          输入伤员的自由描述，系统会抽取关键信息，结合战伤救治规则进行知识检索，
          并生成本轮处置建议、后送判断和可追踪的推演记录。
        </p>

        <div className="mt-7 grid w-full gap-3 text-left sm:grid-cols-3">
          {[
            ['1', '描述伤情', '用自然语言说明伤部、生命体征、已处置措施和当前环境。'],
            ['2', '选择救治级别', '在底部输入区选择当前所处救治阶段，系统会据此组织推演。'],
            ['3', '查看推演结果', '答案、流程节点、细节页和引用依据会随本轮生成过程同步更新。'],
          ].map(([step, title, description]) => (
            <div
              key={step}
              className="pd-welcome-card rounded-2xl border border-neutral-200/80 bg-white/70 p-4 shadow-sm backdrop-blur dark:border-neutral-800/80 dark:bg-neutral-900/70"
            >
              <div className="mb-3 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-red-700 px-2 text-[11px] font-semibold text-white dark:bg-red-500">
                {step}
              </div>
              <div className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                {title}
              </div>
              <div className="mt-1.5 text-[12px] leading-5 text-neutral-500 dark:text-neutral-400">
                {description}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-full border border-red-100 bg-white/75 px-4 py-2 text-[12px] text-red-800 shadow-sm dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-200">
          {noProject
            ? '创建战创伤医学项目后，即可输入伤情并开始首轮推演。'
            : '从下方输入框提交第一轮信息后，此介绍会自动切换为对话记录。'}
        </div>
      </div>
    </div>
  );
}
