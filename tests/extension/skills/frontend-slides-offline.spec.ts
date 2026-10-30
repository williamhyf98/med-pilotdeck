import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const skillRoot = resolve("skills/frontend-slides");

test("frontend-slides is restored as a medical HTML skill without public deploy", () => {
  const skill = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
  const visual = readFileSync(resolve(skillRoot, "references/med-visual.md"), "utf8");
  const template = readFileSync(resolve(skillRoot, "html-template.md"), "utf8");

  assert.match(skill, /医学风格的单文件 HTML/);
  assert.match(skill, /默认自由布局/);
  assert.match(skill, /只用 `pptx`/);
  // Previews must land under exports/ or the chat never shows a file card for them.
  assert.match(skill, /exports\/preview\/风格预览\.html/);
  assert.doesNotMatch(skill, /scratch\/preview/);
  assert.doesNotMatch(skill, /日间|交班投屏|值班深色/);
  assert.doesNotMatch(skill, /vercel\.app|npx vercel|deploy\.sh 部署/i);
  assert.doesNotMatch(template, /fonts\.google|Clash Display|api\.fontshare/i);
  assert.match(visual, /信息密（近读）/);
  assert.match(visual, /高对比大字（远看）/);
  assert.match(visual, /深色低亮（暗光）/);
  assert.match(visual, /定稿前审查/);
  assert.match(skill, /定稿前审查/);
  assert.equal(existsSync(resolve(skillRoot, "scripts/deploy.sh")), false);
  assert.equal(existsSync(resolve("skills/frontend-design/SKILL.md")), false);
});
