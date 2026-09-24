import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AuthorizationSnapshot } from "@uniora/core";
import { UnioraProvider } from "./context.js";
import { Can } from "./can.js";
import { Feature } from "./feature.js";

afterEach(cleanup);

const snapshot: AuthorizationSnapshot = {
  organizationId: "org-1",
  permissions: { "vehicles.create": true, "vehicles.delete": false },
  features: { advanced_reports: true },
};

describe("<Can>", () => {
  it("renderiza los children cuando el permission está otorgado", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <Can permission="vehicles.create">
          <button>Create vehicle</button>
        </Can>
      </UnioraProvider>,
    );
    expect(screen.getByRole("button", { name: "Create vehicle" })).toBeInTheDocument();
  });

  it("no renderiza nada por defecto cuando el permission está denegado", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <Can permission="vehicles.delete">
          <button>Delete vehicle</button>
        </Can>
      </UnioraProvider>,
    );
    expect(screen.queryByRole("button", { name: "Delete vehicle" })).not.toBeInTheDocument();
  });

  it("renderiza el fallback explícito cuando se deniega", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <Can permission="vehicles.delete" fallback={<span>No access</span>}>
          <button>Delete vehicle</button>
        </Can>
      </UnioraProvider>,
    );
    expect(screen.getByText("No access")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete vehicle" })).not.toBeInTheDocument();
  });
});

describe("<Feature>", () => {
  it("renderiza los children cuando el feature está habilitado", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <Feature feature="advanced_reports">
          <div>Reports panel</div>
        </Feature>
      </UnioraProvider>,
    );
    expect(screen.getByText("Reports panel")).toBeInTheDocument();
  });

  it("no renderiza nada por defecto cuando el feature está deshabilitado/no registrado", () => {
    render(
      <UnioraProvider snapshot={snapshot}>
        <Feature feature="ai_assistant">
          <div>AI panel</div>
        </Feature>
      </UnioraProvider>,
    );
    expect(screen.queryByText("AI panel")).not.toBeInTheDocument();
  });
});
