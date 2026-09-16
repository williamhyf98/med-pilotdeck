import type { WebMessage } from "../web/client/webMessage.js";

export type RecentConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

export function renderRecentConversation(
  messages: RecentConversationMessage[],
  limits: { perMessage?: number; total?: number } = {},
): string {
  const perMessage = limits.perMessage ?? 800;
  const total = limits.total ?? 3_000;
  let remaining = total;
  const turns: string[] = [];
  for (const message of messages) {
    if (remaining <= 0) break;
    const text = message.text.trim().slice(0, Math.min(perMessage, remaining));
    if (!text) continue;
    turns.push(`<turn role="${message.role}">${text}</turn>`);
    remaining -= text.length;
  }
  return turns.length > 0
    ? `<recentConversation>\n${turns.join("\n")}\n</recentConversation>`
    : "";
}

function messageText(message: WebMessage): string {
  return (message.text ?? "").trim();
}

export function extractRecentConversationMessages(
  messages: WebMessage[],
  currentInput?: string,
): RecentConversationMessage[] {
  const current = currentInput?.trim();
  return messages
    .filter((message) => (
      (message.role === "user" || message.role === "assistant")
      && message.kind === "text"
    ))
    .map((message) => ({
      role: message.role as "user" | "assistant",
      text: messageText(message),
    }))
    .filter((message) => message.text && (!current || message.text !== current));
}
