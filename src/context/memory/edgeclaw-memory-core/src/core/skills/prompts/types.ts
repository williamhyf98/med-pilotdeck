export type MemoryNoteKind = "user" | "project" | "feedback";

/** Shared string fragments exported from shared.ts and referenced by all profiles. */
export interface SharedPromptFragments {
  /** "- Return JSON only." rule appended to all structured-output prompts. */
  readonly jsonOnlyRule: string;
  /** Override-test line used in classifiers to distinguish user vs feedback. */
  readonly overrideTest: string;
  /** Three-line language-follow block injected into note-create prompts. */
  readonly languageFollowRules: string;
}

export interface MemoryPromptProfile {
  /** Profile identifier — surfaced in trace logs. */
  readonly type: "general_medicine" | "war_trauma";

  /**
   * Hard gate: LlmMemoryExtractor discards note-create requests for any kind
   * not present here, logging a trace entry. Never rely on prompt text alone.
   */
  readonly allowedTypes: ReadonlyArray<MemoryNoteKind>;

  /** System prompt for classifying a turn → should_store + labels. */
  readonly classify: string;

  /** System prompts for note creation, keyed by kind. Absent = unsupported. */
  readonly noteCreate: {
    readonly user?: string;
    readonly project?: string;
    readonly feedback: string;
  };

  /**
   * Direct reference to the shared fragments object from shared.ts.
   * Exposed so tests can assert identity (===) rather than equality.
   */
  readonly shared: SharedPromptFragments;
}
