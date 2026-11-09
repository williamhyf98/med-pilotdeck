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

import SecurityServicesSettings from "./index";

const service = {
  id: "model.local",
  name: "Local model",
  purpose: "Model requests",
  protocol: "http",
  host: "127.0.0.1",
  port: 19000,
  source: "model.providers.local.url",
  enabled: true,
  status: "not_tested",
};

describe("SecurityServicesSettings", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ services: [service], networkRevision: "rev-1" })),
    );
  });

  afterEach(() => cleanup());

  it("loads registered services and tests the registered endpoint", async () => {
    render(<SecurityServicesSettings title="Internal services" />);
    expect(await screen.findByText("Local model")).toBeTruthy();

    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      service: { ...service, status: "reachable", lastTest: { status: "reachable", ok: true, latencyMs: 4, testedAt: "now" } },
      test: { status: "reachable", ok: true, latencyMs: 4, testedAt: "now" },
      networkRevision: "rev-1",
    })));
    fireEvent.click(screen.getByRole("button", { name: "securityPolicy.actions.test" }));
    await waitFor(() => expect(screen.getByText("securityPolicy.status.reachable")).toBeTruthy());
    expect(mockedFetch.mock.calls.at(-1)?.[0]).toBe(
      "/api/security-policy/services/model.local/test",
    );
  });

  it("edits only host, port, and protocol with the current revision", async () => {
    render(<SecurityServicesSettings title="Internal services" />);
    await screen.findByText("Local model");
    fireEvent.click(screen.getByRole("button", { name: "securityPolicy.actions.edit" }));
    fireEvent.change(screen.getByLabelText("securityPolicy.services.host"), {
      target: { value: "127.0.0.2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "securityPolicy.actions.save" }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      "/api/security-policy/services/model.local",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          revision: "rev-1",
          host: "127.0.0.2",
          port: 19000,
          protocol: "http",
        }),
      }),
    ));
  });
});
