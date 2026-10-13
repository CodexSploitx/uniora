import type { Route } from "../route.js";
import { accessRoutes } from "./access.js";
import { decisionRoutes } from "./decisions.js";
import { invitationRoutes } from "./invitations.js";
import { platformRoutes } from "./platform.js";
import { profileRoutes } from "./profiles.js";
import { policyRoutes } from "./policies.js";
import { provisioningRoutes } from "./provisioning.js";
import { readRoutes } from "./reads.js";
import { teamRoutes } from "./teams.js";

/** Every route the server answers, in one place: the pipeline, the OpenAPI document and the tests all read this list. */
export function allRoutes(): readonly Route[] {
  return [...decisionRoutes, ...readRoutes, ...accessRoutes, ...teamRoutes, ...policyRoutes, ...invitationRoutes, ...provisioningRoutes, ...profileRoutes, ...platformRoutes];
}
