import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router";
import { MatchList } from "./routes/MatchList";
import { MatchPage } from "./routes/MatchPage";

const rootRoute = createRootRoute({
  component: () => (
    <div className="app">
      <header className="app-header">
        <Link to="/" className="brand">
          pb-tokei <span>annotate</span>
        </Link>
      </header>
      <Outlet />
    </div>
  ),
  notFoundComponent: () => <p className="notice">Page not found.</p>,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MatchList,
});

const matchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/matches/$matchId",
  component: MatchPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, matchRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
