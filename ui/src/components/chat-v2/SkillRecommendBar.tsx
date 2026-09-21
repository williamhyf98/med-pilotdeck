import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../utils/api';
import { skillDisplayName } from '../../utils/skillDisplayName';
import { cn } from '../../lib/utils.js';

/**
 * Skill chips above the composer.
 *
 * A suggestion the user has to wait for is worse than no suggestion, so this
 * stays out of the send path entirely: it debounces on the already-controlled
 * `input` string, aborts whatever is in flight when the text moves on, and
 * renders nothing at all until the server has something to say. Every failure
 * mode (offline server, 500, malformed body) collapses to "no chips" — the
 * composer itself never blocks on this.
 */

export type SkillRecommendation = {
  slug: string;
  name: string;
  description: string;
  scope: string | null;
  department?: string | null;
  category?: string | null;
  score: number;
  matchedTerms: string[];
};

type SkillRecommendBarProps = {
  /** Current composer text — debounced internally. */
  input: string;
  /** Absolute project path, so project-scoped skills are considered too. */
  projectPath?: string | null;
  /** `general_medicine` | `war_trauma`; gates project-type-scoped skills. */
  projectType?: string | null;
  /** Inserts the mention text at the caret. */
  onUseSkill: (text: string) => void;
  /** Hidden while a slash/at menu owns the keyboard, and while sending. */
  disabled?: boolean;
};

/** Below this the query is too short to say anything useful. */
const MIN_QUERY_LENGTH = 4;
/** Long enough that a fast typist sends one request per pause, not per key. */
const DEBOUNCE_MS = 350;

export default function SkillRecommendBar({
  input,
  projectPath = null,
  projectType = null,
  onUseSkill,
  disabled = false,
}: SkillRecommendBarProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [recommendations, setRecommendations] = useState<SkillRecommendation[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The query the user already accepted a suggestion for. Accepting a chip
   * rewrites `input`, which would otherwise re-trigger the request and offer
   * the same skill straight back. We stay quiet until that text is gone —
   * appending more words to the sentence keeps it dismissed, clearing it
   * doesn't.
   */
  const dismissedQueryRef = useRef<string | null>(null);

  // Shares the `skillsTab.departments.*` labels with the skills browser; an
  // unknown department falls back to its raw frontmatter value.
  const departmentLabel = (department: string): string =>
    t(`skillsTab.departments.${department}`, {
      ns: 'common',
      defaultValue: department,
    }) as string;

  const trimmed = input.trim();
  useEffect(() => {
    const accepted = dismissedQueryRef.current;
    if (accepted !== null && !trimmed.includes(accepted)) {
      dismissedQueryRef.current = null;
      setDismissed(false);
    }
  }, [trimmed]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;

    if (disabled || dismissed || trimmed.length < MIN_QUERY_LENGTH) {
      setRecommendations([]);
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const response = await authenticatedFetch('/api/skills/recommend', {
          method: 'POST',
          body: JSON.stringify({
            query: trimmed,
            projectPath,
            projectType,
          }),
          signal: controller.signal,
          // A background affordance shouldn't raise a toast on every blip.
          suppressServerErrorToast: true,
        });
        if (!response.ok) {
          setRecommendations([]);
          return;
        }
        const data = (await response.json()) as { recommendations?: SkillRecommendation[] };
        if (controller.signal.aborted) return;
        setRecommendations(Array.isArray(data?.recommendations) ? data.recommendations : []);
      } catch {
        // Aborted, offline, or a non-JSON body — all mean "show nothing".
        if (!controller.signal.aborted) setRecommendations([]);
      }
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [trimmed, projectPath, projectType, disabled, dismissed]);

  if (dismissed || recommendations.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1.5 pt-1">
      <span className="inline-flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500">
        <Sparkles className="h-3 w-3" strokeWidth={1.8} />
        {t('skillRecommend.label', { defaultValue: '推荐技能' })}
      </span>
      {recommendations.map((recommendation) => (
        <button
          key={recommendation.slug}
          type="button"
          onClick={() => {
            onUseSkill(
              t('skillRecommend.insertTemplate', {
                name: recommendation.name,
                defaultValue: '（使用「{{name}}」技能）',
              }) as string,
            );
            dismissedQueryRef.current = trimmed;
            setDismissed(true);
          }}
          title={recommendation.description}
          className={cn(
            'inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
            'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100',
            'dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-950/70',
          )}
        >
          <span className="truncate font-medium">{skillDisplayName(recommendation)}</span>
          {recommendation.department ? (
            <span className="shrink-0 text-[10px] text-sky-500/80 dark:text-sky-400/70">
              {departmentLabel(recommendation.department)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
