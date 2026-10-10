import type { Route } from "../route.js";
import { decisionRoutes } from "./decisions.js";
import { readRoutes } from "./reads.js";

/** Every route the server answers, in one place: the pipeline, the OpenAPI document and the tests all read this list. */
export function allRoutes(): readonly Route[] {
  return [...decisionRoutes, ...readRoutes];
}
