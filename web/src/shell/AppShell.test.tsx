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
import { AppShell, rallyLogFileName } from "./AppShell";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getRallyLog: vi.fn<typeof actual.getRallyLog>(),
    getMatch: vi.fn<typeof actual.getMatch>(),
  };
});

import { getRallyLog } from "../api/client";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("rallyLogFileName", () => {
  it("extracts the filename from POSIX and Windows paths", () => {
    expect(rallyLogFileName("/Users/eloy/pb-tokei/demo.duckdb")).toBe("demo.duckdb");
    expect(rallyLogFileName("C:\\data\\rally_log.duckdb")).toBe("rally_log.duckdb");
    expect(rallyLogFileName("demo.duckdb")).toBe("demo.duckdb");
  });
});

describe("AppShell", () => {
  it("shows the open Rally Log filename with the full path on hover", async () => {
    const fullPath = "/Users/eloy/projects/pb-tokei/demo.duckdb";
    vi.mocked(getRallyLog).mockResolvedValue({ path: fullPath });

    const rootRoute = createRootRoute({ component: AppShell });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <div>Home content</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const label = await screen.findByText("demo.duckdb");
    expect(label.getAttribute("title")).toBe(fullPath);
  });

  it("shows unknown Rally Log if /api/rally-log fails", async () => {
    vi.mocked(getRallyLog).mockRejectedValue(new Error("503 Service Unavailable"));

    const rootRoute = createRootRoute({ component: AppShell });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <div>Home content</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const label = await screen.findByText("unknown Rally Log");
    expect(label.getAttribute("title")).toBe("503 Service Unavailable");
  });
});
