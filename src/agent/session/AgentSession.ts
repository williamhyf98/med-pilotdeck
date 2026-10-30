import { randomUUID } from "node:crypto";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import type { AgentTranscriptReplayResult } from "../../session/transcript/TranscriptReplay.js";
import type { TurnRunner } from "../turn/TurnRunner.js";
import {
  appendPermissionDenials,
  cloneSessionStateForRuntimeReload,
  createInitialAgentSessionState,
  mergeSessionUsage,
  snapshotAgentSessionState,
} from "./AgentSessionState.js";
import type { AgentTranscriptWriterState } from "../../session/transcript/TranscriptWriter.js";
import type { AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";

export type AgentSessionOptions = {
  sessionId: string;
  turnRunner: TurnRunner;
  cwd?: string;
  transcriptPath?: string;
  uuid?: () => string;
  initialState?: AgentSessionStateShape;
  replayEvents?: AgentEvent[];
  lifecycle?: LifecycleRuntime;
  transcript?: AgentTranscriptWriter;
};

export type AgentSessionRuntimeReloadSnapshot = {
  state: AgentSessionStateShape;
  cwd: string;
  transcriptPath: string;
  transcriptWriterState?: AgentTranscriptWriterState;
  fileState?: AgentLoopSeedState;
};

export class AgentSession {
  private state: AgentSessionStateShape;

  constructor(private readonly options: AgentSessionOptions) {
    this.state = options.initialState ?? createInitialAgentSessionState(options.sessionId);
  }

  /** Persist a policy refusal as a complete web turn, without running a model.
   * Web-only messages appear in the transcript but are excluded from model replay.
   */
  async recordRejectedTurn(turnId: string, userText: string, reply: string): Promise<void> {
    const transcript = this.options.transcript;
    if (!transcript) throw new Error("Session transcript unavailable for policy refusal.");
    const metadata = { purpose: "policy_denial", webOnly: true };
    await transcript.recordAcceptedInput(this.state.sessionId, turnId, [{
      role: "user", content: [{ type: "text", text: userText }], metadata,
    }]);
    await transcript.recordDurableMessage(this.state.sessionId, turnId, {
      role: "assistant", content: [{ type: "text", text: reply }], metadata,
    });
    const timestamp = new Date().toISOString();
    await transcript.recordTurnResult(this.state.sessionId, turnId, {
      type: "success", sessionId: this.state.sessionId, turnId,
      stopReason: "completed", usage: {}, permissionDenials: [], turns: 0,
      startedAt: timestamp, completedAt: timestamp,
    });
  }

  async *submit(input: AgentInput, submitOptions: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
    const turnId = submitOptions.turnId ?? this.nextId();
    this.state.status = "running";
    this.state.currentTurnId = turnId;
    this.state.abortController = new AbortController();
    yield { type: "session_started", sessionId: this.state.sessionId };
    await this.options.lifecycle?.dispatch({
      event: "SessionStart",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { source: "startup" },
      matchQuery: "SessionStart",
      signal: this.state.abortController.signal,
    });
    await this.options.lifecycle?.dispatch({
      event: "Setup",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: {},
      matchQuery: "Setup",
      signal: this.state.abortController.signal,
    });
    yield { type: "setup_completed", sessionId: this.state.sessionId };

    const runResult = yield* this.options.turnRunner.run({
      sessionId: this.state.sessionId,
      turnId,
      messages: this.state.messages,
      input,
      maxTurns: submitOptions.maxTurns,
      maxToolCalls: submitOptions.maxToolCalls,
      ...(submitOptions.profile !== undefined ? { profile: submitOptions.profile } : {}),
      ...(submitOptions.turnOverrides !== undefined
        ? { turnOverrides: submitOptions.turnOverrides }
        : {}),
      runMode: submitOptions.runMode,
      permissionMode: submitOptions.permissionMode,
      allowedReadFiles: submitOptions.allowedReadFiles,
      basePermissionMode: submitOptions.basePermissionMode,
      allowPlanModeTools: submitOptions.allowPlanModeTools,
      canPrompt: submitOptions.canPrompt,
      permissionRules: submitOptions.permissionRules,
      syntheticMessages: submitOptions.syntheticMessages,
      abortSignal: this.state.abortController.signal,
    });

    this.state.messages = runResult.messages;
    this.state.usage = mergeSessionUsage(this.state.usage, runResult.result.usage);
    this.state.permissionDenials = appendPermissionDenials(
      this.state.permissionDenials,
      runResult.result.permissionDenials,
    );
    this.state.status = runResult.result.type === "aborted" ? "aborted" : runResult.result.type === "error" ? "failed" : "idle";
    this.state.currentTurnId = undefined;
    const sessionEndReason = this.state.status === "aborted" ? "other" : "prompt_input_exit";
    await this.options.lifecycle?.dispatch({
      event: "SessionEnd",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { reason: sessionEndReason },
      matchQuery: "SessionEnd",
      signal: this.state.abortController.signal,
    });
    yield { type: "session_ended", sessionId: this.state.sessionId, reason: sessionEndReason };
  }

  abort(reason?: string): void {
    this.state.abortController.abort(reason);
    this.state.status = "aborted";
  }

  snapshot(): AgentSessionStateShape {
    return snapshotAgentSessionState(this.state);
  }

  snapshotForRuntimeReload(): AgentSessionRuntimeReloadSnapshot {
    const runtime = this.options.turnRunner.snapshotForRuntimeReload();
    return {
      state: cloneSessionStateForRuntimeReload(this.state),
      cwd: runtime.runtimeContext.cwd,
      transcriptPath: runtime.runtimeContext.transcriptPath,
      transcriptWriterState: runtime.transcriptWriterState,
      fileState: this.options.turnRunner.snapshotFileState(),
    };
  }

  async *replay(): AsyncGenerator<AgentEvent, void, unknown> {
    for (const event of this.options.replayEvents ?? []) {
      yield event;
    }
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }
}

export function createAgentSessionStateFromReplay(
  sessionId: string,
  replay: AgentTranscriptReplayResult,
): AgentSessionStateShape {
  return {
    ...createInitialAgentSessionState(sessionId),
    messages: replay.messages,
    usage: replay.usage,
    permissionDenials: replay.permissionDenials,
  };
}
