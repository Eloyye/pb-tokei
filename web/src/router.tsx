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
import { NewMatchPage } from "./routes/NewMatchPage";
import { asReportSplit, type ReportSplit } from "./routes/reportOptions";
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

const newMatchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matches/new",
  component: NewMatchPage,
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
  validateSearch: (search): { by?: ReportSplit } => {
    const by = asReportSplit(search.by);
    return by ? { by } : {};
  },
  beforeLoad: ({ params }) => {
    if (!isWorkspace(params.workspace)) throw notFound();
  },
  component: MatchPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, newMatchRoute, matchRoute, workspaceRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
