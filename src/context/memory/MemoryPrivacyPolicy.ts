/**
 * Re-export facade.
 *
 * The canonical implementation lives inside the edgeclaw-memory-core sub-package
 * at `edgeclaw-memory-core/src/MemoryPrivacyPolicy.ts` so that it stays within
 * that package's `rootDir` and is reachable without violating tsconfig boundaries.
 *
 * Code outside the sub-package (e.g. tests/context/memory/privacy.spec.ts) should
 * continue to import from this path — it will resolve to the same module.
 */
export {
  redact,
  PHI_POLICY_DESCRIPTION,
} from "./edgeclaw-memory-core/src/MemoryPrivacyPolicy.js";
export type { RedactResult } from "./edgeclaw-memory-core/src/MemoryPrivacyPolicy.js";
