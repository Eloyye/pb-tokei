// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type RallyLogInfo } from "../api/client";
import { registerOperatorTimeFlush, reportSaveStatus } from "../lib/unsavedChanges";
import { AppShell } from "./AppShell";
import { rallyLogFolder } from "./rallyLog";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getRallyLog: vi.fn<Client["getRallyLog"]>(),
  openRallyLog: vi.fn<Client["openRallyLog"]>(),
  getMatch: vi.fn<Client["getMatch"]>(),
  getTabRallyLog: vi.fn<Client["getTabRallyLog"]>(() => null),
  subscribeTabRallyLog: vi.fn<Client["subscribeTabRallyLog"]>(() => () => {}),
}));

import { getRallyLog, getTabRallyLog, openRallyLog } from "../api/client";

const ONE = "/data/one.duckdb";
const TWO = "/data/two.duckdb";
const GONE = "/mnt/drive/gone.duckdb";
const OPEN_ONE: RallyLogInfo = {
  path: ONE,
  recent: [
    { path: ONE, exists: true },
    { path: TWO, exists: true },
    { path: GONE, exists: false },
  ],
};

const editor = {};

function renderShell(initialPath = "/") {
  const rootRoute = createRootRoute({ component: AppShell });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>Home content</div>,
  });
  const matchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/elsewhere",
    component: () => <div>Elsewhere</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, matchRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

async function openPicker() {
  fireEvent.click(await screen.findByText("one.duckdb"));
  return screen.findByRole("dialog");
}

beforeEach(() => {
  vi.mocked(getRallyLog).mockResolvedValue(OPEN_ONE);
  vi.mocked(openRallyLog).mockImplementation(async (path) => ({
    path,
    recent: [{ path, exists: true }],
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  reportSaveStatus(editor, null);
  vi.clearAllMocks();
});

describe("Rally Log picker", () => {
  it("lists recent Rally Logs, with the open one and missing ones not choosable", async () => {
    renderShell();
    await openPicker();

    const [open, two, gone] = screen.getAllByRole("button", { name: /duckdb/ }).slice(-3);
    expect(open!.hasAttribute("disabled")).toBe(true);
    expect(two!.hasAttribute("disabled")).toBe(false);
    expect(gone!.hasAttribute("disabled")).toBe(true);
    expect(gone!.textContent).toContain("missing");
  });

  it("waits for queued saves before switching, then goes Home on the new Rally Log", async () => {
    reportSaveStatus(editor, { state: "saving" });
    const { router } = renderShell("/elsewhere");
    await openPicker();

    fireEvent.click(screen.getByTitle(TWO));
    expect(await screen.findByText("Saving changes…")).toBeTruthy();
    expect(openRallyLog).not.toHaveBeenCalled();

    act(() => reportSaveStatus(editor, { state: "saved" }));

    await waitFor(() => expect(openRallyLog).toHaveBeenCalledWith(TWO, false));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("refuses to switch while a save is failing", async () => {
    reportSaveStatus(editor, { state: "retrying", error: "503 Service Unavailable" });
    renderShell();
    await openPicker();

    fireEvent.click(screen.getByTitle(TWO));

    expect((await screen.findByRole("alert")).textContent).toContain("503 Service Unavailable");
    expect(openRallyLog).not.toHaveBeenCalled();
  });

  it("gives the old Rally Log a chance to save time and ignores a flush failure", async () => {
    let fail!: (error: Error) => void;
    const pendingTime = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const flush = vi.fn<() => Promise<void>>(() => pendingTime);
    const unregister = registerOperatorTimeFlush(flush);
    try {
      renderShell();
      await openPicker();
      fireEvent.click(screen.getByTitle(TWO));
      await waitFor(() => expect(flush).toHaveBeenCalledOnce());
      expect(openRallyLog).not.toHaveBeenCalled();

      await act(async () => fail(new Error("Busy")));
      expect(openRallyLog).toHaveBeenCalledWith(TWO, false);
    } finally {
      unregister();
    }
  });

  it("opens the next Rally Log after the time flush deadline", async () => {
    const unregister = registerOperatorTimeFlush(() => new Promise<void>(() => {}));
    try {
      renderShell();
      await openPicker();
      vi.useFakeTimers();
      fireEvent.click(screen.getByTitle(TWO));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1999);
      });
      expect(openRallyLog).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(openRallyLog).toHaveBeenCalledWith(TWO, false);
    } finally {
      unregister();
    }
  });

  it("creates a new Rally Log at the typed path, starting from the open one's folder", async () => {
    renderShell();
    await openPicker();
    const field = screen.getByLabelText("Path") as HTMLInputElement;
    expect(field.value).toBe(rallyLogFolder(ONE));

    fireEvent.change(field, { target: { value: "/data/new" } });
    fireEvent.click(screen.getByText("New Rally Log"));

    await waitFor(() => expect(openRallyLog).toHaveBeenCalledWith("/data/new", true));
  });

  it("shows why the server refused, and stays open", async () => {
    vi.mocked(openRallyLog).mockRejectedValue(new ApiError(404, "Rally Log not found: /x.duckdb"));
    renderShell();
    await openPicker();

    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/x.duckdb" } });
    fireEvent.click(screen.getByText("Open"));

    expect((await screen.findByRole("alert")).textContent).toBe("Rally Log not found: /x.duckdb");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens at once when no Rally Log is open", async () => {
    vi.mocked(getRallyLog).mockResolvedValue({ path: null, recent: [] });
    renderShell();

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("No Rally Log is open. Open one, or make a new one.")).toBeTruthy();
    expect(screen.getByText("No Rally Log")).toBeTruthy();
  });

  it("offers a reload once the app has switched away from this tab's Rally Log", async () => {
    vi.mocked(getTabRallyLog).mockReturnValue(TWO);
    renderShell();

    const stale = await screen.findByText("Rally Log switched elsewhere: reload");
    expect(stale.getAttribute("title")).toContain(TWO);
  });
});
