// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("./client");

const ONE = "/data/Pickleball ピックル/one.duckdb";
const TWO = "/data/two.duckdb";

let requests: Request[];
let rallyLogPath: string | null;

/** A fresh copy of the client (its tab Rally Log starts unknown) over a stubbed `fetch`. */
async function freshClient(): Promise<Client> {
  vi.resetModules();
  return import("./client");
}

beforeEach(() => {
  requests = [];
  rallyLogPath = ONE;
  // openapi-fetch takes `fetch` when the client is created, so stub it before importing.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      requests.push(input);
      const body = new URL(input.url).pathname.endsWith("/rally-log")
        ? { path: rallyLogPath, recent: [] }
        : [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("sends Match filters as report query parameters, repeating Tournament IDs", async () => {
  const client = await freshClient();
  const filters = {
    tournament: ["one", "two"],
    tour: "ppa" as const,
    date_from: "2026-04-15",
    date_to: "2026-06-04",
    opponent: "opponent",
  };
  await client.getPlayerReport("player", { ...filters, partner: "partner" });
  await client.getTeamReport("team", filters);

  const [player, team] = requests.map((request) => new URL(request.url));
  for (const url of [player!, team!]) {
    expect(url.searchParams.getAll("tournament")).toEqual(filters.tournament);
    expect(url.searchParams.get("tour")).toBe(filters.tour);
    expect(url.searchParams.get("date_from")).toBe(filters.date_from);
    expect(url.searchParams.get("date_to")).toBe(filters.date_to);
    expect(url.searchParams.get("opponent")).toBe(filters.opponent);
  }
  expect(player!.pathname).toBe("/api/players/player");
  expect(player!.searchParams.get("partner")).toBe("partner");
  expect(team!.pathname).toBe("/api/teams/team");
  expect(team!.searchParams.has("partner")).toBe(false);
});

describe("the tab's Rally Log", () => {
  it("is named in every request once the tab has learnt it", async () => {
    const client = await freshClient();

    await client.getRallyLog();
    await client.listMatches();

    expect(requests[0]!.headers.get("X-Rally-Log")).toBeNull();
    expect(requests[1]!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(client.matchVideoUrl("m-1")).toBe(
      `/api/matches/m-1/video?rally_log=${encodeURIComponent(ONE)}`,
    );
  });

  it("stays put when the app has switched elsewhere, so the tab can tell it is stale", async () => {
    const client = await freshClient();
    await client.getRallyLog();

    rallyLogPath = TWO;
    const latest = await client.getRallyLog();
    await client.listMatches();

    expect(latest.path).toBe(TWO);
    expect(client.getTabRallyLog()).toBe(ONE);
    expect(requests.at(-1)!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
  });

  it("follows this tab's own switch", async () => {
    const client = await freshClient();
    await client.getRallyLog();

    rallyLogPath = TWO;
    await client.openRallyLog(TWO, false);
    await client.listMatches();

    expect(client.getTabRallyLog()).toBe(TWO);
    expect(requests.at(-1)!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(TWO));
  });

  it("is adopted from the server when no Rally Log was open before", async () => {
    rallyLogPath = null;
    const client = await freshClient();
    await client.getRallyLog();
    await client.listMatches();

    expect(client.getTabRallyLog()).toBeNull();
    expect(requests.at(-1)!.headers.get("X-Rally-Log")).toBeNull();
    expect(client.matchVideoUrl("m-1")).toBe("/api/matches/m-1/video");

    rallyLogPath = ONE;
    await client.getRallyLog();

    expect(client.getTabRallyLog()).toBe(ONE);
  });

  it("keeps a New Match form bound to the Rally Log its roster came from", async () => {
    const client = await freshClient();
    await client.getRallyLog();
    await client.getRoster(ONE);

    rallyLogPath = TWO;
    await client.openRallyLog(TWO, false);
    await client.createMatch(
      {
        date: "2026-04-12",
        tournament: "Atlanta Open",
        tour: "ppa",
        team_a: ["p-existing-1", { name: "A2", handedness: "right" }],
        team_b: [{ name: "B1", handedness: "left" }, "p-existing-2"],
      },
      ONE,
    );

    expect(requests[1]!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(requests.at(-1)!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(client.getTabRallyLog()).toBe(TWO);
  });

  it("keeps a closing session bound to the Rally Log where it started", async () => {
    const client = await freshClient();
    await client.getRallyLog();
    rallyLogPath = TWO;
    await client.openRallyLog(TWO, false);
    const body = {
      workspace: "annotate",
      started_at: "2026-01-01T00:00:00Z",
      ended_at: "2026-01-01T00:00:10Z",
      active_seconds: 10,
    } as const;
    await client.upsertOperatorSession("match", "session", body, {
      keepalive: true,
      rallyLog: ONE,
    });

    const request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/matches/match/operator-sessions/session");
    expect(request.method).toBe("PUT");
    expect(request.keepalive).toBe(true);
    expect(request.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(await request.json()).toEqual(body);
  });

  it("sends PATCH /api/matches/{id} bound to the tab Rally Log when updating a date", async () => {
    const client = await freshClient();
    await client.getRallyLog();

    await client.updateMatch("match-1", { date: "2026-04-18" });

    const request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/matches/match-1");
    expect(request.method).toBe("PATCH");
    expect(request.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(await request.json()).toEqual({ date: "2026-04-18" });
  });

  it.each([
    [409, "The app has switched to another Rally Log"],
    [422, "Match date must be YYYY-MM-DD"],
  ])("throws ApiError(%i) when updateMatch fails", async (status, detail) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const client = await freshClient();

    await expect(
      client.updateMatch("match-1", { date: "2026-04-18" }, { rallyLog: ONE }),
    ).rejects.toMatchObject({ status, message: detail });
  });

  it("sends dry_run query params and parses 409 exact-name conflict targets", async () => {
    const client = await freshClient();
    await client.getRallyLog();

    await client.updatePlayer("p-1", { name: "Anna B." }, { dryRun: true });
    let request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/players/p-1");
    expect(new URL(request.url).searchParams.get("dry_run")).toBe("true");
    expect(request.method).toBe("PATCH");

    await client.mergePlayer("p-1", { into: "p-2" }, { dryRun: true });
    request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/players/p-1/merge");
    expect(new URL(request.url).searchParams.get("dry_run")).toBe("true");
    expect(await request.json()).toEqual({ into: "p-2" });

    await client.replaceMatchPlayer("m-1", { from: "p-1", to: "p-2" });
    request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/matches/m-1/replace-player");
    expect(await request.json()).toEqual({ from: "p-1", to: "p-2" });

    await client.deleteMatch("m-1");
    request = requests.at(-1)!;
    expect(new URL(request.url).pathname).toBe("/api/matches/m-1");
    expect(request.method).toBe("DELETE");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              detail: "Player 'Anna Bright' already exists",
              existing_id: "p-real",
              existing_name: "Anna Bright",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const conflictClient = await freshClient();
    await expect(
      conflictClient.updatePlayer("p-1", { name: "Anna Bright" }, { dryRun: true }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Player 'Anna Bright' already exists",
      conflict: { id: "p-real", name: "Anna Bright" },
    });
  });
});
