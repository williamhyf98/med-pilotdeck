# HTML 展示骨架（按需取用，不要整页锁成幻灯片）

变量从 [references/med-visual.md](references/med-visual.md) 三套之一复制。禁止外链字体与脚本。

仅当投屏或选了「交班投屏」时，把 `viewport-base.css` 全文贴进 `<style>`，并用 `.slide` 分屏。默认自由布局用普通文档流即可。

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>展示标题</title>
    <style>
      :root {
        --bg: #fafafa;
        --surface: #ffffff;
        --text: #171717;
        --muted: #525252;
        --border: #e5e5e5;
        --accent: #2563eb;
        --font-body: "Noto Sans SC", "Source Han Sans SC", "PingFang SC",
          "Microsoft YaHei", system-ui, sans-serif;
      }
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--font-body);
        line-height: 1.55;
      }
      a { color: var(--accent); }
      .wrap { max-width: 72rem; margin: 0 auto; padding: 1.5rem; }
      .muted { color: var(--muted); }
      .disclaimer {
        margin-top: 2rem;
        font-size: 0.85rem;
        color: var(--muted);
      }
      @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <h1>主结论或标题</h1>
      <p class="muted">来源与时间 · 缺项写「未提供」</p>
      <!-- 自由排版：目录、章节、表、Tab、折叠均可 -->
      <p class="disclaimer">本页为辅助展示，不替代临床决策。</p>
    </main>
    <script>
      /* 可选：键盘翻页仅用于 .slide 投屏结构。不要 fetch。 */
    </script>
  </body>
</html>
```

## 可选交互（全部内联）

- 目录：`id` + `a href="#..."`
- Tab / 折叠：按钮切换 `hidden` 或 class
- 投屏：左右方向键切换 `.slide`；把当前页 `aria-current` 设好

## 不要从旧模板抄的

- Fontshare / Google Fonts `<link>`
- 「必须粘贴 viewport-base」作为所有页面的默认
- 深色赛博 accent（`#00ffcc`）
