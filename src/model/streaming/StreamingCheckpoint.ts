import type { CanonicalModelEvent } from "../protocol/canonical.js";

export interface StreamingCheckpoint {
  partialText: string;
  tokensReceived: number;
  hasToolCalls: boolean;
  incompleteToolCalls: number;
}

/**
 * Lightweight tracker that accumulates partial assistant content from a
 * streaming model response. Used by the stream-retry logic in `streamModel`
 * to decide whether a mid-stream failure has enough partial content to
 * warrant a continuation retry (as opposed to a full from-scratch retry).
 */
export class StreamingCheckpointManager {
  private checkpoint: StreamingCheckpoint = {
    partialText: "",
    tokensReceived: 0,
    hasToolCalls: false,
    incompleteToolCalls: 0,
  };
  private readonly openToolCallIds = new Set<string>();

  onEvent(event: CanonicalModelEvent): void {
    switch (event.type) {
      case "text_delta":
        this.checkpoint.partialText += event.text;
        this.checkpoint.tokensReceived++;
        break;
      case "thinking_delta":
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_start":
        this.openToolCallIds.add(event.id);
        this.checkpoint.incompleteToolCalls = this.openToolCallIds.size;
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_delta":
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.tokensReceived++;
        break;
      case "tool_call_end":
        this.openToolCallIds.delete(event.toolCall.id);
        this.checkpoint.incompleteToolCalls = this.openToolCallIds.size;
        this.checkpoint.hasToolCalls = true;
        this.checkpoint.tokensReceived++;
        break;
    }
  }

  get(): StreamingCheckpoint {
    return { ...this.checkpoint };
  }

  hasSubstantialContent(): boolean {
    return this.checkpoint.partialText.trim().length > 0;
  }

  reset(): void {
    this.openToolCallIds.clear();
    this.checkpoint = {
      partialText: "",
      tokensReceived: 0,
      hasToolCalls: false,
      incompleteToolCalls: 0,
    };
  }
}
