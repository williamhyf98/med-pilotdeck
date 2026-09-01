# 动效（可选、克制）

医学展示默认少动效。禁止外链动效库、霓虹、故障风。
`prefers-reduced-motion: reduce` 时必须关掉非必要动画。

仅允许内联 CSS。投屏翻页可用短淡入；不要弹簧、视差、粒子。

```css
.reveal {
  opacity: 0;
  transform: translateY(8px);
  animation: fade-in 0.35s ease-out forwards;
}
@keyframes fade-in {
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .reveal { animation: none; opacity: 1; transform: none; }
}
```
