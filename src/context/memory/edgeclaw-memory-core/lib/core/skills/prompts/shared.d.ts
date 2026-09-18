/**
 * Single source of truth for prompt fragments shared across all profile archives.
 *
 * Do NOT copy-paste these strings into individual profile files. Interpolate them.
 * If a fragment needs to change, change it here once and both profiles inherit the update.
 */
import type { SharedPromptFragments } from "./types.js";
export declare const JSON_ONLY_RULE = "- \u53EA\u8FD4\u56DE JSON\u3002";
export declare const OVERRIDE_TEST = "- \u8986\u76D6\u6D4B\u8BD5\uFF1A\u5982\u679C\u53E6\u4E00\u4E2A\u9879\u76EE\u53EF\u4EE5\u5408\u7406\u5730\u8986\u76D6\u8FD9\u6761\u89C4\u5219\u6216\u504F\u597D\uFF0C\u5B83\u5C31\u4E0D\u5C5E\u4E8E user\uFF1B\u5E94\u5206\u7C7B\u4E3A feedback\u3002";
/**
 * Three-line language-follow block that appears verbatim in every note-create prompt.
 * No trailing newline — the template literal supplies the surrounding newlines.
 */
export declare const LANGUAGE_FOLLOW_RULES: string;
export declare const CLASSIFY_JSON_CONTRACT = "\u4E25\u683C\u4F7F\u7528\u4EE5\u4E0B JSON \u7ED3\u6784\uFF1A\n{\n  \"should_store\": true,\n  \"labels\": [\n    {\n      \"type\": \"user | project | feedback\",\n      \"reason\": \"\u4E3A\u4EC0\u4E48\u9002\u7528\u8BE5\u7C7B\u522B\",\n      \"evidence\": \"\u7126\u70B9\u8F6E\u6B21\u4E2D\u7684\u7B80\u77ED\u539F\u6587\u6216\u8BC1\u636E\u6458\u8981\"\n    }\n  ]\n}";
/**
 * Build the note-create JSON contract for a specific note kind.
 * The only variation between kinds is the "name" example string.
 */
export declare function buildNoteCreateJsonContract(kind: "user" | "project" | "feedback"): string;
/**
 * Exported as a single object so profiles can hold a reference and tests can
 * assert identity (===) rather than equality — proving no copy was made.
 */
export declare const SHARED_FRAGMENTS: SharedPromptFragments;
