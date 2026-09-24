import { authorizeRoute } from "@uniora/next";
import { getDemoAuthorization, isDemoRole } from "@/lib/demo-storage";

/**
 * Demonstrates `@uniora/next`'s `authorizeRoute` helper for a Next.js Route
 * Handler (docs/PROYECT.md §25) — a plain Web `Request -> Response`
 * function, so `authorizeRoute` hands back a ready-to-return `Response`
 * instead of throwing. Try it directly in the browser, e.g.:
 *
 *   /api/authorize-demo?role=owner&permission=vehicles.delete   -> 200
 *   /api/authorize-demo?role=viewer&permission=vehicles.delete  -> 403
 *   /api/authorize-demo?role=owner&feature=ai_assistant         -> 403 (disabled org-wide)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const roleParam = searchParams.get("role") ?? undefined;
  const role = isDemoRole(roleParam) ? roleParam : "viewer";
  const permission = searchParams.get("permission") ?? undefined;
  const feature = searchParams.get("feature") ?? undefined;

  const { engine, organizationId, identity } = await getDemoAuthorization(role);

  const denied = await authorizeRoute(engine, { identity, organizationId, permission, feature });
  if (denied) return denied;

  return Response.json({ allowed: true, role, permission, feature });
}
