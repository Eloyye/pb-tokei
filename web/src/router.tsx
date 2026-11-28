import {
  createRootRoute,
  createRoute,
  createRouter,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { isWorkspace } from "./lib/workspaces";
import { ComparePage } from "./routes/ComparePage";
import { compareSearch } from "./routes/compareSearch";
import { EditMatchPage } from "./routes/EditMatchPage";
import { LeaderboardPage } from "./routes/LeaderboardPage";
import { leaderboardSearch } from "./routes/leaderboardSearch";
import { playerReportSearch, teamReportSearch } from "./routes/matchFilters";
import { HomePrototype } from "./routes/home-prototype/HomePrototype";
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

// PROTOTYPE (branch prototype/home-screen): `?variant=` and `?data=sample` pick a Home variant.
const searchText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (
    search: Record<string, unknown>,
  ): { variant?: string; data?: string; select?: string; clean?: string } => {
    return {
      variant: searchText(search.variant),
      data: searchText(search.data),
      select: searchText(search.select),
      clean: searchText(search.clean),
    };
  },
  component: HomePrototype,
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

const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compare",
  validateSearch: compareSearch,
  component: ComparePage,
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
    compareRoute,
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
