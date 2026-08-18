import type { LucideIcon } from 'lucide-react';

export type MedicalPageId = 'dialogue' | 'med-trauma';

export type MedicalTaskModeId =
  | 'health-qa'
  | 'war-trauma-diagnosis'
  | 'report-interpretation'
  | 'medicine-package-recognition'
  | 'deep-search'
  | 'table-digitization';

export type MedicalTaskMode = {
  id: MedicalTaskModeId;
  label: string;
  shortLabel: string;
  description: string;
  commandHint: string;
  icon: LucideIcon;
};

export type MedicalModelOption = {
  value: string;
  label: string;
};

export type MedicalCapabilityId = 'table' | 'gallery3d' | 'status';

export type TraumaStageId =
  | 'point-of-injury'
  | 'field-triage'
  | 'reception-treatment'
  | 'critical-care'
  | 'surgery'
  | 'decontamination';

export type TraumaStage = {
  id: TraumaStageId;
  index: number;
  label: string;
  shortLabel: string;
  description: string;
};

export type TraumaImageCategoryId = 'wound' | 'xray' | 'ecg' | 'ct' | 'other';

export type TraumaImageCategory = {
  id: TraumaImageCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
};

export type TraumaImageItem = {
  id: string;
  name: string;
  category: TraumaImageCategoryId;
  size?: number;
  previewUrl?: string;
  file?: File;
  demo?: boolean;
};

export type TraumaResultSectionId =
  | 'imaging'
  | 'stage-action'
  | 'specific-action'
  | 'evacuation'
  | 'safety';

export type TraumaResultSection = {
  id: TraumaResultSectionId;
  index: number;
  title: string;
  description: string;
  icon: LucideIcon;
};

export type TraumaStreamState = 'idle' | 'streaming' | 'complete' | 'stopped';

export type MedicalBranding = {
  productName: string;
  dialogueName: string | null;
  traumaName: string | null;
  organizationName: string | null;
  logoAsset: string | null;
};

export type MedicalFeatures = Record<string, boolean>;

export type MedicalSecurity = {
  crossSessionMemory: boolean;
  publicWebSearch: boolean;
  externalTelemetry: boolean;
  requireHumanReview: boolean;
  phiStorage?: string;
  dicomBurnedInClearanceRequired?: boolean;
};

export type MedicalPresetInfo = {
  presetId: string | null;
  branding: MedicalBranding;
  features: MedicalFeatures;
  security: MedicalSecurity;
  deployment: { offlineLevel: string };
  customer?: { id: string; displayName: string } | null;
  knowledge?: { enabledCorpora: string[]; defaultCorpus: string; corpusVersion?: string | null };
  profiles?: Record<string, string>;
};
