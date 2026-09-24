/** Deployment policy shared by discovery, skill loading, and execution. */
const SPECIALIZED_CT_SKILLS = new Set([
  "med-radar-ct",
  "med-deepchest-3dmedagent",
  "med-dicom-router",
]);

export function isSpecializedCtEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MED_SPECIALIZED_CT_ENABLED === "1";
}

export function isMedicalSkillAvailable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const slug = name.trim().toLowerCase().split(":").at(-1) ?? "";
  return !SPECIALIZED_CT_SKILLS.has(slug) || isSpecializedCtEnabled(env);
}

export function isMedToolDisabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Both wire-name builders exist in the runtime (dash and underscore).
  return /^mcp__med[-_]tools__med_(radar|deepchest)_/.test(name)
    && !isSpecializedCtEnabled(env);
}
