import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { isWorkspace } from "./lib/workspaces";
import { EditMatchPage } from "./routes/EditMatchPage";
import { LeaderboardPage } from "./routes/LeaderboardPage";
import { leaderboardSearch } from "./routes/leaderboardSearch";
import { playerReportSearch, teamReportSearch } from "./routes/matchFilters";
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
  validateSearch: playerReportSearch,
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
  validateSearch: teamReportSearch,
  component: TeamReportPage,
});

const leaderboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leaderboard",
  validateSearch: leaderboardSearch,
  component: LeaderboardPage,
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

const editMatchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matches/$matchId/edit",
  component: EditMatchPage,
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
    leaderboardRoute,
    newMatchRoute,
    matchRoute,
    editMatchRoute,
    workspaceRoute,
  ]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
