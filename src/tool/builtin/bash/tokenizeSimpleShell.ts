/**
 * 把命令拆成简单 token；遇到 `| ; & < > \`` 或 `$(` 等 shell 元字符时返回 `undefined`。
 * 导出给 `sandbox/networkPolicy.ts` 复用：只有「单条简单命令」才允许获得网络出口。
 */
export function tokenizeSimpleShell(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && (char === "`" || (char === "$" && next === "("))) {
        return undefined;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if ("|;&<>`".includes(char) || (char === "$" && next === "(")) {
      return undefined;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    current += char;
  }

  if (escaped || quote) {
    return undefined;
  }
  pushCurrent();
  return tokens;
}

