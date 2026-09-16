import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, FolderOutput, ShieldPlus, Stethoscope } from 'lucide-react';
import type { Project } from '../../types/app';
import { resolveProjectType } from '../app-shell/appShellSelection';
import medAssistantLogo from '../../assets/med-assistant-logo.png';

type ChatWelcomeV2Props = {
  selectedProject: Project | null;
  welcomeTitle?: string;
  welcomeDescription?: string;
  composerSlot: ReactNode;
};

const GENERAL_MEDICINE_CAPABILITIES = [
  {
    title: '临床分析',
    description: '病例整理、鉴别诊断、风险提示与诊疗建议。',
    Icon: Stethoscope,
    iconClassName: 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  },
  {
    title: '医学资料与病例',
    description: '解读影像、检验、心电图等资料，生成结构化病例报告。',
    Icon: FileText,
    iconClassName: 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
  },
  {
    title: '战创伤支持',
    description: '检索战创伤知识，生成分阶段救治方案。',
    Icon: ShieldPlus,
    iconClassName: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  },
  {
    title: '文档与展示',
    description: '制作 PDF、Word、PPT、表格、流程图和 HTML 展示页。',
    Icon: FolderOutput,
    iconClassName: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
] as const;

export default function ChatWelcomeV2({
  selectedProject,
  welcomeTitle,
  welcomeDescription,
  composerSlot,
}: ChatWelcomeV2Props) {
  const { t } = useTranslation('chat');
  const projectName = selectedProject?.displayName || selectedProject?.name || '';
  const showGeneralMedicineOverview = Boolean(
    selectedProject
    && resolveProjectType(selectedProject) === 'general_medicine'
    && !welcomeTitle
    && !welcomeDescription,
  );

  if (showGeneralMedicineOverview) {
    return (
      <div className="pd-chat-welcome flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-neutral-950">
        <div
          data-testid="general-medicine-overview"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex min-h-full w-full max-w-[1120px] flex-col items-center justify-center px-5 py-5 text-center sm:px-8">
            <img
              src={medAssistantLogo}
              alt="通用医学智能助手"
              className="mb-2 h-auto w-44 max-w-[60vw] object-contain"
            />
            <h1 className="text-balance text-[24px] font-semibold tracking-tight text-neutral-950 dark:text-neutral-50">
              通用医学智能助手
            </h1>
            <p className="mt-2 max-w-[720px] text-[13px] leading-6 text-neutral-600 dark:text-neutral-300">
              支持临床分析、医学资料解读、战创伤辅助，以及 PDF、Word、PPT、表格和可视化内容制作。
            </p>

            <div
              data-testid="general-medicine-capability-grid"
              className="mt-5 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-2 lg:grid-cols-4"
            >
              {GENERAL_MEDICINE_CAPABILITIES.map(({ title, description, Icon, iconClassName }) => (
                <div
                  key={title}
                  className="min-h-[116px] rounded-lg border border-neutral-200/80 bg-white p-3.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <div className={`flex h-8 w-8 items-center justify-center rounded-md ${iconClassName}`}>
                    <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                  </div>
                  <div className="mt-3 text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
                    {title}
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-neutral-500 dark:text-neutral-400">
                    {description}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 text-[12px] text-neutral-500 dark:text-neutral-400">
              解读这份检查报告，整理为结构化病例报告，并导出为PDF。
            </div>
          </div>
        </div>
        <div
          data-testid="general-medicine-composer-dock"
          className="shrink-0 bg-white px-5 pb-5 pt-3 dark:bg-neutral-950 sm:px-8"
        >
          <div className="mx-auto w-full max-w-[900px]">
            {composerSlot}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pd-chat-welcome flex h-full flex-col bg-white dark:bg-neutral-950">
      <div className="pd-chat-welcome-body flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <div className="pd-chat-welcome-column w-full max-w-[720px]">
          <h1 className="pd-chat-welcome-title mb-8 text-center text-[26px] font-medium tracking-tight text-neutral-900 dark:text-neutral-100">
            {welcomeTitle || (selectedProject
              ? t('welcome.greetingWithProject', {
                  project: projectName,
                  defaultValue: `What's on the plan today?`,
                })
              : t('welcome.noProject', {
                  defaultValue: 'Pick a project from the sidebar to get started',
                }))}
          </h1>
          {welcomeDescription ? (
            <p className="pd-chat-welcome-description text-center text-[13px] leading-6 text-neutral-500 dark:text-neutral-400">
              {welcomeDescription}
            </p>
          ) : null}
          {composerSlot}
        </div>
      </div>
    </div>
  );
}
