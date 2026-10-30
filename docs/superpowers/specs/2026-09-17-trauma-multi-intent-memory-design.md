# Trauma Multi-Intent Preference Memory Design

## Background

The current war-trauma entry path classifies each user message into exactly one
intent: `case_update`, `domain_question_no_case`, `system_help`, or
`out_of_scope`. This makes a presentation preference such as "以后先给结论" look
out of scope even though the post-turn memory capture path may still save it as
Feedback. The result is internally inconsistent: the current reply rejects the
request, the preference cannot affect the current reply, and only a later turn
may benefit after Index completes.

Long-term-memory recall has a second reliability issue. Trauma delegates recall
to the generic semantic router, which may choose `user`, `project`, `mix`, or
`none`. Consequently, a stable project Feedback rule or global clinical
preference can exist on disk without being supplied to the Reasoner or Knowledge
QA model on a given turn.

## Goal

Support messages that combine a primary medical request with presentation or
workflow preferences, apply newly stated preferences to the current response,
and persist those preferences asynchronously for later turns without allowing
patient facts into long-term memory.

## Non-Goals

- Do not turn Trauma routing into an unconstrained tool-calling agent.
- Do not allow Feedback to override medical safety, evidence, stage, or schema
  constraints.
- Do not write patient facts, vital signs, injury details, or Case State into
  long-term memory.
- Do not add `user` or `project` memory writes to war-trauma projects.
- Do not change the physical Case State format.

## Decision 1: One Primary Intent Plus Side Intents

A turn has exactly one primary workflow and zero or more preference updates.
This is multi-intent behavior without permitting multiple state-changing
workflows to race.

```ts
export type TraumaPrimaryIntent =
  | "case_update"
  | "knowledge_question"
  | "system_help"
  | "out_of_scope";

export type TraumaPreferenceCategory =
  | "format"
  | "detail"
  | "language"
  | "workflow";

export type ExtractedTraumaPreference = {
  sourceSpan: string;
  directive: string;
  category: TraumaPreferenceCategory;
};

export type TraumaIntentPlan = {
  primaryIntent: TraumaPrimaryIntent;
  scopeReason: string;
  preferences: ExtractedTraumaPreference[];
  caseForm: TurnFormInput;
  knowledgeQuestion?: string;
};
```

The extractor must copy every `sourceSpan` from the current user input. Code
validates that invariant before using or persisting a preference.

Compatibility is handled at the model-output boundary: the existing
`inputIntent` field remains accepted during rollout and is normalized to
`primaryIntent`. Existing callers consume only `TraumaIntentPlan` after
normalization.

## Decision 2: Deterministic Orchestration

The model describes the turn; code chooses the workflow.

| Primary intent | Main workflow | Case State mutation | Preference behavior |
|---|---|---:|---|
| `case_update` | Trauma Runner | Yes | Apply now and persist after completion |
| `knowledge_question` | Knowledge QA | No | Apply now and persist after completion |
| `system_help` | Help response | No | Confirm and persist |
| `out_of_scope` | Scope response | No | Confirm valid preferences; reject only unrelated remainder |

If the message contains both a case update and a general knowledge question,
`case_update` wins as the primary workflow. The raw question remains available
to Runner/RAG, avoiding a second parallel model pipeline.

A preference-only turn produces a preference acknowledgement instead of the
current out-of-scope rejection. It never creates or updates Case State.

## Decision 3: Current-Turn Preferences Apply Immediately

New preferences are normalized before the answering model is called. They are
passed directly to the Reasoner or Knowledge QA model and do not wait for L0,
Index, or Dream.

Persistence remains post-response:

```text
extract preference
  -> validate and redact
  -> apply to current answer
  -> finish answer
  -> capture as L0 Feedback candidate
  -> immediate Index
  -> immediate Dream when files changed
```

If persistence fails, the current response still follows the preference. Only
future-turn continuity is lost.

## Decision 4: Deterministic Baseline Preference Loading

Presentation preferences must not depend on the generic semantic memory gate.
`MemoryDomainFacade` gains a narrow method that deterministically reads:

1. The compact global user profile.
2. Active Feedback entries belonging to the current project.

It continues to exclude Project Memory and Case State. Results pass through the
existing PHI policy and character budgets.

Semantic retrieval remains available for future use, but it is not responsible
for deciding whether baseline presentation preferences are injected.

## Decision 5: Separate Clinical Authority From Presentation Priority

The prompts must no longer express these as one mixed priority chain.

Clinical authority:

```text
Current-turn case facts > current Case State > validated RAG evidence
```

Presentation priority:

```text
Current-turn preferences
> current-project Feedback
> global clinical preferences
> default presentation template
```

The following remain non-overridable:

- Medical safety requirements.
- No fabrication of patient facts or evidence.
- Stage and facility capability boundaries.
- Citation validity.
- Structured output schema.
- Required medical-review disclaimer.

## Decision 6: Required Content, Flexible Rendering

The Reasoner must still cover conclusion, confirmed stage, current actions,
evacuation guidance, and missing information. The existing five-section layout
becomes the default only when no applicable preference changes presentation.

Feedback may change headings, order, use of tables or lists, verbosity, language,
and terminology depth. It may not remove required clinical content from the
structured result.

Knowledge QA follows the same presentation hierarchy while retaining its
evidence-only and citation constraints.

## Effective Presentation Policy

Introduce a focused module that merges the three preference sources without
parsing or mutating medical facts:

```ts
export type EffectivePresentationPolicy = {
  currentTurn: string[];
  projectFeedback: string[];
  globalPreferences: string[];
};

export function buildEffectivePresentationPolicy(input: {
  currentTurn: readonly ExtractedTraumaPreference[];
  recalled: TraumaPreferenceMemory | null;
}): EffectivePresentationPolicy;
```

The rendered model payload preserves source boundaries. The model receives
separate arrays instead of one undifferentiated Markdown block.

## Preference Validation And Capture

The extractor output is not trusted by itself. Before current-turn use or
persistence, each preference must pass all checks:

1. `sourceSpan` is a non-empty exact substring of the current input.
2. `directive` is non-empty and length-limited.
3. The span does not contain clinical facts rejected by the trauma capture
   policy.
4. PHI redaction is applied.

The capture sink accepts validated preference directives rather than reparsing
the complete raw message. The EdgeClaw war-trauma profile and
`allowedTypes: ["feedback"]` remain the final write gate.

## Failure Handling

- Extractor failure retains the existing case-update fallback, but produces no
  inferred preference updates.
- Preference validation failure drops only the invalid preference; it does not
  fail the primary workflow.
- Baseline preference read failure logs a warning and runs without stored
  preferences.
- Feedback persistence, Index, or Dream failure never changes the completed
  answer or Case State.
- Aborted or failed turns do not persist newly stated preferences.

## Observability

Each turn should record:

- Primary intent.
- Number and categories of accepted preferences.
- Number of rejected preference spans and rejection reasons.
- Whether global and project preferences were injected.
- Whether current-turn preferences were applied.
- Feedback capture result and target project scope.

Raw PHI and rejected clinical spans must not be written to memory audit logs.

## Acceptance Criteria

1. A preference-only message receives an acknowledgement and does not run
   Trauma Runner or mutate Case State.
2. A mixed preference/case message applies the preference to the same response
   and saves only the case portion to Case State.
3. A mixed preference/knowledge message applies the preference to Knowledge QA.
4. Stored project Feedback and global preferences are supplied even when the
   generic semantic memory gate would return `none`.
5. Current-turn preferences override stored preferences; project Feedback
   overrides global preferences; safety rules override every preference.
6. Clinical facts and PHI never enter Feedback memory.
7. Existing single-intent case, knowledge, help, and out-of-scope behavior
   remains compatible when no preference is present.

