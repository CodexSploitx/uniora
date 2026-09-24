import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AuthorizationSnapshot } from "@uniora/core";
import { UnioraProvider } from "./context.js";
import { useCan, useFeature } from "./hooks.js";

afterEach(cleanup);

const snapshot: AuthorizationSnapshot = {
  organizationId: "org-1",
  permissions: { "vehicles.read": true, "vehicles.delete": false },
  features: { advanced_reports: true, ai_assistant: false },
};

function ProbeCan({ permission }: { permission: string }) {
  return <div data-testid="result">{String(useCan(permission))}</div>;
}

function ProbeFeature({ feature }: { feature: string }) {
  return <div data-testid="result">{String(useFeature(feature))}</div>;
}

describe("useCan", () => {
  it("devuelve el valor real del snapshot cuando el permission sí fue pedido", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeCan permission="vehicles.read" />
      </UnioraProvider>,
    );
    expect(screen.getByTestId("result")).toHaveTextContent("true");
  });

  it("devuelve false para un permission explícitamente denegado", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeCan permission="vehicles.delete" />
      </UnioraProvider>,
    );
    expect(screen.getByTestId("result")).toHaveTextContent("false");
  });

  it("falla cerrado (false) para un permission nunca pedido al snapshot, sin lanzar", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeCan permission="vehicles.update" />
      </UnioraProvider>,
    );
    expect(screen.getByTestId("result")).toHaveTextContent("false");
  });

  it("falla cerrado (false) fuera de un UnioraProvider", () => {
    render(<ProbeCan permission="vehicles.read" />);
    expect(screen.getByTestId("result")).toHaveTextContent("false");
  });

  it("advierte en dev cuando el permission nunca fue pedido al snapshot (pero sigue denegando)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeCan permission="never.requested" />
      </UnioraProvider>,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('useCan("never.requested")'));
    warn.mockRestore();
  });

  it("no advierte para un permission explícitamente resuelto (así sea false)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeCan permission="vehicles.delete" />
      </UnioraProvider>,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("useFeature", () => {
  it("devuelve el valor real del snapshot cuando el feature sí fue pedido", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeFeature feature="advanced_reports" />
      </UnioraProvider>,
    );
    expect(screen.getByTestId("result")).toHaveTextContent("true");
  });

  it("falla cerrado (false) para un feature nunca pedido al snapshot", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <ProbeFeature feature="bulk_import" />
      </UnioraProvider>,
    );
    expect(screen.getByTestId("result")).toHaveTextContent("false");
  });

  it("falla cerrado (false) fuera de un UnioraProvider", () => {
    render(<ProbeFeature feature="advanced_reports" />);
    expect(screen.getByTestId("result")).toHaveTextContent("false");
  });
});
