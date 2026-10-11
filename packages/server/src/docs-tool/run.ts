import { allRoutes } from "../routes/index.js";
import type { Route } from "../route.js";
import { platformOptions, startFixture } from "../test-support/harness.js";
import type { Context, Step } from "./scenario.js";
import { STEPS } from "./scenario.js";

export interface Recorded {
  readonly step: Step;
  readonly route: Route;
  /** The input as resolved (path, query and body flattened). */
  readonly input: Record<string, unknown>;
  readonly request: { readonly method: string; readonly path: string; readonly headers: Record<string, string>; readonly body: unknown };
  readonly response: { readonly status: number; readonly headers: Record<string, string>; readonly body: unknown };
}

const names = (schema: { shape: Record<string, unknown> } | undefined): string[] => Object.keys(schema?.shape ?? {});

/** Turns the flattened input of an operation into the path, the query and the body of its request. */
export function toRequest(route: Route, input: Record<string, unknown>): { path: string; body: unknown } {
  const paramNames = names(route.params);
  const queryNames = names(route.query);
  const bodyNames = names(route.body);
  const known = new Set([...paramNames, ...queryNames, ...bodyNames]);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`${route.id}: the example uses "${key}", which the operation does not take.`);
  let path = route.path;
  for (const name of paramNames) path = path.replace(`:${name}`, encodeURIComponent(String(input[name])));
  const query = new URLSearchParams();
  for (const name of queryNames) if (input[name] !== undefined) query.set(name, String(input[name]));
  const body = route.body ? Object.fromEntries(bodyNames.filter((name) => input[name] !== undefined).map((name) => [name, input[name]])) : undefined;
  return { path: `${path}${query.size > 0 ? `?${query.toString()}` : ""}`, body };
}

/** Runs the whole scenario against a real server (SQLite) and records what it answered. */
export async function runScenario(): Promise<Recorded[]> {
  const fixture = await startFixture("sqlite", (backend) => platformOptions(backend));
  try {
    const { token } = await fixture.issue({ name: "backend" });
    const results = new Map<string, unknown>();
    const saved = new Map<string, unknown>();
    const context: Context = {
      saved: (name) => {
        if (!saved.has(name)) throw new Error(`The scenario asks for "${name}" before a step saved it.`);
        return saved.get(name);
      },
      last: (operation) => {
        if (!results.has(operation)) throw new Error(`The scenario asks for the answer of ${operation} before it ran.`);
        return results.get(operation);
      },
    };
    const routes = new Map(allRoutes().map((route) => [route.id, route]));
    const recorded: Recorded[] = [];
    for (const step of STEPS) {
      const route = routes.get(step.operation);
      if (!route) throw new Error(`The scenario uses an operation that does not exist: ${step.operation}.`);
      const input = typeof step.input === "function" ? step.input(context) : (step.input ?? {});
      const { path, body } = toRequest(route, input);
      const headers: Record<string, string> = {};
      if (step.actor !== undefined) headers["Uniora-Actor-Subject"] = encodeURIComponent(step.actor);
      if (step.ifMatch) headers["If-Match"] = `"${step.ifMatch(context)}"`;
      if (step.idempotencyKey) headers["Idempotency-Key"] = step.idempotencyKey;
      const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
      if (step.verifiedAs !== undefined) {
        lower["uniora-actor-token"] = fixture.sign(step.verifiedAs, { provider: "main", claims: step.tokenClaims ?? {} });
        // What the reference shows is the placeholder: the real one is a signed JWT that changes at every run.
        headers["Uniora-Actor-Token"] = "<the user's token from your identity provider>";
      }
      if (step.operator !== undefined) {
        lower["uniora-actor-token"] = fixture.sign(step.operator, { provider: "staff", claims: { auth_time: Math.floor(Date.now() / 1000) - 30, amr: ["pwd", "mfa"], ...step.tokenClaims } });
        headers["Uniora-Actor-Token"] = "<the operator's token from your staff identity provider>";
      }
      const response = await fixture.call(route.method, path, { token: step.as === "anonymous" ? null : token, headers: lower, ...(body !== undefined ? { body } : {}) });
      if (response.status !== step.expect) {
        throw new Error(`${step.operation} "${step.title}": expected ${step.expect}, got ${response.status} ${response.text.slice(0, 300)}`);
      }
      if (response.status < 300) results.set(step.operation, response.body);
      if (step.save !== undefined && response.status < 300) saved.set(step.save, response.body);
      recorded.push({
        step,
        route,
        input,
        request: { method: route.method, path, headers, body },
        response: {
          status: response.status,
          headers: Object.fromEntries(["etag", "location"].flatMap((name) => (response.headers.get(name) ? [[name === "etag" ? "ETag" : "Location", response.headers.get(name)!]] : []))),
          body: response.body,
        },
      });
    }
    return recorded;
  } finally {
    await fixture.stop();
  }
}
