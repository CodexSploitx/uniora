# UNIORA playground

A Next.js app (App Router, shadcn/ui + ReUI) that shows UNIORA's guards side by side. It uses in-memory storage and three demo identities (an Owner, a salesperson and a viewer), so it needs no database and no sign-in.

```bash
pnpm install
pnpm --filter playground dev      # http://localhost:3000
```

| What you see | Where it lives |
| --- | --- |
| Role switcher, permission checks and feature checks | `src/components/playground/` |
| `<Can>` and `<Feature>` fed by a server-computed snapshot (`@uniora/react`) | `src/app/page.tsx`, `src/lib/demo-storage.ts` |
| `assertCan` in a Server Action: the real check behind the hidden button (`@uniora/next`) | `src/app/actions.ts` |
| `authorizeRoute` in a Route Handler | `src/app/api/authorize-demo/route.ts` (try `/api/authorize-demo?role=viewer&permission=vehicles.delete`) |

`src/lib/demo-storage.ts` stands in for your own database layer. The route lets the caller pick their role in the query string **for the demo only**: in a real app the identity comes from a verified session and the permission is a constant of the route. See the [frameworks guide](../../guides/frameworks.md) and the [hardening guide](../../guides/hardening.md).
