// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager, SkillManagerError } from "../../../src/extension/skills/index.js";
import { getPilotExtensionPaths } from "../../../src/pilot/paths.js";
async function writeSkill(root, slug, description) {
    const dir = join(root, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`, "utf8");
}
test("SkillManager lists built-ins separately and describes override relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-builtin-"));
    try {
        const pilotHome = join(root, "pilot-home");
        const projectRoot = join(root, "project");
        const builtinSkillsRoot = join(root, "bundled-skills");
        await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");
        await writeSkill(builtinSkillsRoot, "docx", "Built-in DOCX");
        await writeSkill(join(pilotHome, "skills"), "pdf", "User PDF override");
        const projectSkillsRoot = getPilotExtensionPaths(projectRoot, pilotHome).projectSkillsDir;
        await writeSkill(projectSkillsRoot, "docx", "Project DOCX override");
        await writeSkill(projectSkillsRoot, "custom", "Project custom skill");
        const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
        const result = await manager.list({ projectKey: projectRoot });
        assert.deepEqual(result.builtin.map((skill) => skill.slug), ["docx", "pdf"]);
        assert.equal(result.builtin.find((skill) => skill.slug === "pdf")?.overriddenBy, "user");
        assert.equal(result.builtin.find((skill) => skill.slug === "docx")?.overriddenBy, "project");
        assert.equal(result.builtin.every((skill) => skill.readonly), true);
        assert.equal(result.user[0]?.overridesBuiltin, true);
        assert.equal(result.project.find((skill) => skill.slug === "docx")?.overridesBuiltin, true);
        assert.equal(result.project.find((skill) => skill.slug === "custom")?.overridesBuiltin, undefined);
        assert.deepEqual(result.medical, []);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("SkillManager permits reading but rejects mutations of built-in skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-readonly-"));
    try {
        const pilotHome = join(root, "pilot-home");
        const builtinSkillsRoot = join(root, "bundled-skills");
        await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");
        const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
        const read = await manager.read({ scope: "builtin", slug: "pdf" });
        assert.match(read.content, /Built-in PDF/);
        assert.equal(read.skill?.readonly, true);
        for (const operation of [
            () => manager.write({ scope: "builtin", slug: "pdf", content: "changed" }),
            () => manager.create({ scope: "builtin", slug: "new-skill", name: "new-skill" }),
            () => manager.delete({ scope: "builtin", slug: "pdf" }),
            () => manager.import({ sourcePath: join(builtinSkillsRoot, "pdf"), scope: "builtin" }),
        ]) {
            await assert.rejects(operation, (error) => {
                assert.equal(error instanceof SkillManagerError, true);
                assert.equal(error.code, "read_only");
                return true;
            });
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("SkillManager lists medical skills as a separate read-only group", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-medical-"));
    try {
        const pilotHome = join(root, "pilot-home");
        const builtinSkillsRoot = join(root, "bundled-skills");
        const medicalSkillsRoot = join(root, "med-skills");
        await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF skill description.");
        await writeSkill(medicalSkillsRoot, "med-medical", "Parse medical attachments into structured findings.");
        const manager = new SkillManager({ pilotHome, builtinSkillsRoot, medicalSkillsRoot });
        const result = await manager.list({});
        assert.deepEqual(result.builtin.map((skill) => skill.slug), ["pdf"]);
        assert.deepEqual(result.medical.map((skill) => skill.slug), ["med-medical"]);
        assert.equal(result.medical[0]?.readonly, true);
        assert.equal(result.medical[0]?.scope, "medical");
        const read = await manager.read({ scope: "medical", slug: "med-medical" });
        assert.match(read.content, /Parse medical attachments/);
        await assert.rejects(
            () => manager.write({ scope: "medical", slug: "med-medical", content: "changed" }),
            (error) => {
                assert.equal(error instanceof SkillManagerError, true);
                assert.equal(error.code, "read_only");
                return true;
            },
        );
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("SkillManager lists all medical skills for management with fixed availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-project-type-"));
    try {
        const pilotHome = join(root, "pilot-home");
        const medicalSkillsRoot = join(root, "plugins", "med-tools", "skills");
        for (const slug of ["med-medical", "med-case-report", "med-trauma-assist", "med-trauma-stage-plan"]) {
            await writeSkill(medicalSkillsRoot, slug, slug);
        }
        const manager = new SkillManager({ pilotHome, medicalSkillsRoot });
        const generalProject = join(pilotHome, "workspaces", "general_med", "general_med-example");
        const traumaProject = join(pilotHome, "workspaces", "trauma_med", "trauma_med-example");

        const general = await manager.list({ projectKey: generalProject });
        assert.deepEqual(
            general.medical.map((skill) => skill.slug),
            ["med-case-report", "med-medical", "med-trauma-assist", "med-trauma-stage-plan"],
        );
        assert.deepEqual(general.medical.find((skill) => skill.slug === "med-case-report")?.availability, ["general_medicine"]);
        assert.deepEqual(general.medical.find((skill) => skill.slug === "med-trauma-assist")?.availability, ["war_trauma"]);
        assert.equal(general.medical.find((skill) => skill.slug === "med-medical")?.availabilityMutable, true);
        const trauma = await manager.list({ projectKey: traumaProject });
        assert.deepEqual(
            trauma.medical.map((skill) => skill.slug),
            ["med-case-report", "med-medical", "med-trauma-assist", "med-trauma-stage-plan"],
        );

        const managementRead = await manager.read({
            scope: "medical",
            slug: "med-trauma-stage-plan",
            projectKey: generalProject,
        });
        assert.match(managementRead.content, /med-trauma-stage-plan/u);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("SkillManager updates user and med-medical availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-availability-"));
    try {
        const pilotHome = join(root, "pilot-home");
        const medicalSkillsRoot = join(root, "plugins", "med-tools", "skills");
        await writeSkill(join(pilotHome, "skills"), "custom", "Custom skill");
        await writeSkill(medicalSkillsRoot, "med-medical", "Medical parser");
        const manager = new SkillManager({ pilotHome, medicalSkillsRoot });

        const userResult = await manager.setAvailability({
            scope: "user",
            slug: "custom",
            availability: ["war_trauma"],
        });
        assert.deepEqual(userResult.skill.availability, ["war_trauma"]);
        const userRead = await manager.read({ scope: "user", slug: "custom" });
        assert.match(userRead.content, /availability:\n\s+- war_trauma/u);

        const medicalResult = await manager.setAvailability({
            scope: "medical",
            slug: "med-medical",
            availability: ["general_medicine"],
        });
        assert.deepEqual(medicalResult.skill.availability, ["general_medicine"]);

        await assert.rejects(
            () => manager.setAvailability({
                scope: "medical",
                slug: "med-trauma-assist",
                availability: ["global"],
            }),
            (error) => {
                assert.equal(error instanceof SkillManagerError, true);
                assert.equal(error.code, "read_only");
                return true;
            },
        );
        await assert.rejects(
            () => manager.setAvailability({
                scope: "user",
                slug: "custom",
                availability: ["unknown"],
            }),
            (error) => {
                assert.equal(error instanceof SkillManagerError, true);
                assert.equal(error.code, "invalid_input");
                return true;
            },
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
