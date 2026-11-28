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
import { reportSearch } from "./routes/reportOptions";
import { PlayersPage, TeamsPage } from "./routes/SubjectIndexPage";
import { PlayerReportPage, TeamReportPage } from "./routes/SubjectReportPage";
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

const playersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/players",
  component: PlayersPage,
});

const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/players/$playerId",
  validateSearch: reportSearch,
  component: PlayerReportPage,
});

const teamsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teams",
  component: TeamsPage,
});

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teams/$teamId",
  validateSearch: reportSearch,
  component: TeamReportPage,
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
  validateSearch: reportSearch,
  beforeLoad: ({ params }) => {
    if (!isWorkspace(params.workspace)) throw notFound();
  },
  component: MatchPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    playersRoute,
    playerRoute,
    teamsRoute,
    teamRoute,
    newMatchRoute,
    matchRoute,
    workspaceRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
