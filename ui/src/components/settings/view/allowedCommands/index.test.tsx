// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedFetch = vi.hoisted(() => vi.fn());
const translate = vi.hoisted(() => (key: string) => key);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));
vi.mock("../../../../utils/api", () => ({
  authenticatedFetch: mockedFetch,
}));

import AllowedCommandsSettings from "./index";

const command = {
  id: "pdf.make",
  enabled: true,
  allowedOptions: ["--out"],
  availableOptions: ["--out", "--force"],
  inputRoots: ["inbox"],
  allowedInputRoots: ["inbox", "scratch", "exports"],
  outputRoots: ["exports"],
  allowedOutputRoots: ["scratch", "exports"],
  writable: true,
  networkRuleIds: [],
  timeoutMs: 1000,
  maxTimeoutMs: 600000,
};

describe("AllowedCommandsSettings", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({
        policy: { version: 1, mode: "registered_only", commands: [command] },
        commands: [command],
        commandRevision: "commands-1",
      })),
    );
  });

  afterEach(() => cleanup());

  it("shows registered command limits and saves only the policy fields", async () => {
    render(<AllowedCommandsSettings title="Allowed commands" />);
    expect(await screen.findByText("pdf.make")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "securityPolicy.commands.details" }));
    fireEvent.click(screen.getByRole("switch", { name: "securityPolicy.commands.enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "securityPolicy.actions.save" }));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      "/api/security-policy/commands",
      expect.objectContaining({ method: "PUT" }),
    ));
    const body = JSON.parse(mockedFetch.mock.calls.at(-1)?.[1].body);
    expect(body.revision).toBe("commands-1");
    expect(body.policy.commands[0]).toMatchObject({ id: "pdf.make", enabled: false });
    expect(body.policy.commands[0]).not.toHaveProperty("availableOptions");
    expect(body.policy.commands[0]).not.toHaveProperty("maxTimeoutMs");
  });
});
