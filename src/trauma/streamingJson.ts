/**
 * Incrementally extracts the value of the top-level `naturalLanguageAnswer`
 * JSON string from a structured model response.
 *
 * Model providers split JSON at arbitrary boundaries (including in the
 * middle of an escape sequence), so this deliberately does not call
 * JSON.parse until the complete response is available. It only emits text
 * whose JSON string representation is complete and never exposes JSON
 * syntax to the caller.
 */
export class NaturalLanguageAnswerStreamExtractor {
  private raw = "";
  private contentStart: number | null = null;
  private contentConsumed = 0;
  private contentText = "";
  private contentEnd: number | null = null;

  accept(fragment: string): string | undefined {
    if (!fragment) return undefined;
    this.raw += fragment;
    this.locateAnswer();
    if (this.contentStart === null) return undefined;

    if (this.contentEnd === null) {
      this.contentEnd = findJsonStringEnd(this.raw, this.contentStart);
    }

    const end = this.contentEnd ?? this.raw.length;
    const available = this.raw.slice(this.contentStart, end);
    if (this.contentConsumed > available.length) {
      this.contentConsumed = available.length;
    }
    const decoded = decodeJsonStringPrefix(
      available,
      this.contentConsumed,
      this.contentEnd !== null,
    );
    if (decoded.consumed === this.contentConsumed && !decoded.text) {
      return undefined;
    }
    this.contentConsumed = decoded.consumed;
    this.contentText += decoded.text;
    return decoded.text || undefined;
  }

  /**
   * Flushes a complete answer string when the provider ended immediately
   * after its last content fragment. Valid structured output normally closes
   * the JSON string, but exposing this method keeps the extractor safe for
   * transports that omit a final delimiter.
   */
  finish(): string | undefined {
    if (this.contentStart === null) return undefined;
    if (this.contentEnd === null) {
      this.contentEnd = findJsonStringEnd(this.raw, this.contentStart);
    }
    const end = this.contentEnd ?? this.raw.length;
    const available = this.raw.slice(this.contentStart, end);
    const decoded = decodeJsonStringPrefix(available, this.contentConsumed, true);
    this.contentConsumed = decoded.consumed;
    this.contentText += decoded.text;
    return decoded.text || undefined;
  }

  currentText(): string {
    return this.contentText;
  }

  isFinished(): boolean {
    return this.contentStart !== null && this.contentEnd !== null;
  }

  private locateAnswer(): void {
    if (this.contentStart !== null) return;
    const located = findTopLevelStringValueStart(this.raw, "naturalLanguageAnswer");
    if (located !== null) this.contentStart = located;
  }
}

function findTopLevelStringValueStart(raw: string, targetKey: string): number | null {
  let depth = 0;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '"') {
      const end = findJsonStringEnd(raw, index);
      if (end === null) return null;
      const key = parseJsonString(raw.slice(index, end + 1));
      if (depth === 1 && key === targetKey) {
        let cursor = end + 1;
        while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
        if (raw[cursor] !== ":") {
          index = end + 1;
          continue;
        }
        cursor += 1;
        while (/\s/u.test(raw[cursor] ?? "")) cursor += 1;
        if (raw[cursor] !== '"') return null;
        return cursor + 1;
      }
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return null;
}

/** Returns the index of the closing quote, excluding the quote itself. */
function findJsonStringEnd(raw: string, start: number): number | null {
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') return index;
  }
  return null;
}

function parseJsonString(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeJsonStringPrefix(
  raw: string,
  start: number,
  final: boolean,
): { text: string; consumed: number } {
  let index = start;
  let text = "";
  while (index < raw.length) {
    const char = raw[index]!;
    if (char !== "\\") {
      text += char;
      index += 1;
      continue;
    }

    if (index + 1 >= raw.length) {
      if (!final) break;
      // Invalid JSON should be rejected by the final structured parser. Do
      // not leak a dangling backslash into the user-visible stream.
      break;
    }

    const escape = raw[index + 1]!;
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escape in simpleEscapes) {
      text += simpleEscapes[escape]!;
      index += 2;
      continue;
    }

    if (escape === "u") {
      if (index + 6 > raw.length) {
        if (!final) break;
        break;
      }
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/iu.test(hex)) {
        if (!final) break;
        break;
      }
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }

    // Unknown escape: wait for the final parser to reject it, without
    // exposing the provider's JSON syntax.
    if (!final) break;
    break;
  }
  return { text, consumed: index };
}
