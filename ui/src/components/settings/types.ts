export type SettingsMenuKey =
  | 'account'
  | 'users'
  | 'general'
  | 'modelPool'
  | 'agent'
  | 'agentModel'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'agentSchedule'
  | 'integrations'
  | 'extensions'
  | 'mcpServers'
  | 'officePreview'
  | 'privacy'
  | 'advanced'
  | 'securityServices'
  | 'allowedCommands'
  | 'about';

export type SettingsMenuItem = {
  key: SettingsMenuKey;
  label: string;
  children?: SettingsMenuItem[];
  showDot?: boolean;
};
