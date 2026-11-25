// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Match } from "../api/client";
import { MatchList } from "./MatchList";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  listMatches: vi.fn<Client["listMatches"]>(),
}));

import { listMatches } from "../api/client";

function makeMatch(id: string, overrides: Partial<Match> = {}): Match {
  return {
    id,
    tournament: "PPA Atlanta Open 2026",
    team_a: ["Anna Bright", "Ben Johns"],
    team_b: ["Cara Lee", "Dan Kim"],
    franchise_a: null,
    franchise_b: null,
    video_status: "none",
    footage_job: null,
    ...overrides,
  };
}

function renderList() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: MatchList,
  });
  const matchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/matches/$matchId/$workspace",
    component: () => <div>Match</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, matchRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MatchList Video pills", () => {
  it("shows live download/convert progress, Queued (n), Fetch failed, and static statuses", async () => {
    vi.mocked(listMatches).mockResolvedValue([
      makeMatch("m1", { video_status: "ready" }),
      makeMatch("m2", {
        video_status: "none",
        footage_job: { state: "downloading", queue_position: null, percent: 42.4 },
      }),
      makeMatch("m3", {
        video_status: "not_converted",
        footage_job: { state: "converting", queue_position: null, percent: 75 },
      }),
      makeMatch("m4", {
        video_status: "none",
        footage_job: { state: "queued", queue_position: 2, percent: null },
      }),
      makeMatch("m5", {
        video_status: "none",
        footage_job: { state: "error", queue_position: null, percent: null },
      }),
    ]);

    renderList();

    for (const text of [
      "Video ready",
      "Downloading 42%",
      "Converting 75%",
      "Queued (2)",
      "Fetch failed",
    ]) {
      const pill = await screen.findByText(text);
      expect(pill.tagName).toBe("SPAN");
    }
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
