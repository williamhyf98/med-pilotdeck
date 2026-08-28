// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { createReadSkillTool } from "../../../src/tool/builtin/readSkill.js";
function baseContext() {
    return {
        cwd: "/workspace",
        projectRoot: "/workspace",
        env: {},
        abortSignal: undefined,
    };
}
test("read_skill returns the resolved SKILL.md path with the skill body", async () => {
    const tool = createReadSkillTool({
        loader: async (name) => name === "spreadsheets" ? "# Spreadsheet workflow" : undefined,
        lister: () => [{
                name: "spreadsheets",
                description: "Create spreadsheets.",
                path: "/opt/pilotdeck/skills/spreadsheets/SKILL.md",
            }],
    });
    const result = await tool.execute({ skillName: "spreadsheets" }, baseContext());
    const first = result.content[0];
    assert.equal(first?.type, "text");
    if (first?.type !== "text")
        assert.fail("read_skill did not return text");
    assert.equal(first.text, [
        "<skill>",
        "<name>spreadsheets</name>",
        "<path>/opt/pilotdeck/skills/spreadsheets/SKILL.md</path>",
        "# Spreadsheet workflow",
        "</skill>",
    ].join("\n"));
});
test("read_skill refuses skills omitted from the current visible catalog", async () => {
    const tool = createReadSkillTool({
        loader: async () => "# Legacy prompt contribution",
        lister: () => [],
    });
    const result = await tool.execute({ skillName: "legacy" }, baseContext());
    const first = result.content[0];
    assert.equal(first?.type, "text");
    if (first?.type !== "text")
        assert.fail("read_skill did not return text");
    assert.equal(first.text, "Skill 'legacy' not found. No skills are currently loaded.");
});
