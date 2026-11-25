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
        tournament: "Atlanta Open",
        tour: "ppa",
        team_a: [
          { name: "A1", handedness: "right" },
          { name: "A2", handedness: "right" },
        ],
        team_b: [
          { name: "B1", handedness: "left" },
          { name: "B2", handedness: "right" },
        ],
      },
      ONE,
    );

    expect(requests[1]!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(requests.at(-1)!.headers.get("X-Rally-Log")).toBe(encodeURIComponent(ONE));
    expect(client.getTabRallyLog()).toBe(TWO);
  });
});
