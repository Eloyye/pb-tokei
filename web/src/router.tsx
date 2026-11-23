import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { isWorkspace } from "./lib/workspaces";
import { MatchList } from "./routes/MatchList";
import { MatchPage } from "./routes/MatchPage";
import { AppShell } from "./shell/AppShell";

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => <p className="notice">Page not found.</p>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MatchList,
});

/** A Match opens in Annotate. */
const matchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matches/$matchId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/matches/$matchId/$workspace",
      params: { matchId: params.matchId, workspace: "annotate" },
      replace: true,
    });
  },
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matches/$matchId/$workspace",
  beforeLoad: ({ params }) => {
    if (!isWorkspace(params.workspace)) throw notFound();
  },
  component: MatchPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, matchRoute, workspaceRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
