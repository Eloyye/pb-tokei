// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FootageJobOut, MatchDetail } from "../api/client";
import { FetchPanel } from "./FetchPanel";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getMatchFootage: vi.fn<Client["getMatchFootage"]>(),
  fetchMatchFootage: vi.fn<Client["fetchMatchFootage"]>(),
  cancelMatchFootage: vi.fn<Client["cancelMatchFootage"]>(),
}));

import { cancelMatchFootage, fetchMatchFootage, getMatchFootage } from "../api/client";

const MATCH_ID = "0b1c0c55-1f43-4a87-9d2a-2a1f6c0f7f3e";
const SAMPLE_URL = "https://www.youtube.com/watch?v=abc123";

function makeMatch(overrides: Partial<MatchDetail> = {}): MatchDetail {
  return {
    id: MATCH_ID,
    tournament: "PPA Atlanta Open 2026",
    team_a: ["Anna Bright", "Ben Johns"],
    team_b: ["Cara Lee", "Dan Kim"],
    franchise_a: null,
    franchise_b: null,
    video_status: "none",
    footage_job: null,
    fix_command: `pb-tokei download <url> --match ${MATCH_ID} --db /data/log.duckdb`,
    source_url: null,
    original_present: false,
    team_a_id: "11111111-1111-1111-1111-111111111111",
    team_b_id: "22222222-2222-2222-2222-222222222222",
    players: [
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
        name: "Anna Bright",
        team_id: "11111111-1111-1111-1111-111111111111",
        team: "a",
      },
      {
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
        name: "Ben Johns",
        team_id: "11111111-1111-1111-1111-111111111111",
        team: "a",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
        name: "Cara Lee",
        team_id: "22222222-2222-2222-2222-222222222222",
        team: "b",
      },
      {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
        name: "Dan Kim",
        team_id: "22222222-2222-2222-2222-222222222222",
        team: "b",
      },
    ],
    ...overrides,
  };
}

function makeJob(overrides: Partial<FootageJobOut> = {}): FootageJobOut {
  return {
    state: "idle",
    queue_position: null,
    percent: null,
    speed: null,
    eta: null,
    error: null,
    hint: null,
    stderr_tail: null,
    cookies_from_browser: null,
    ...overrides,
  };
}

function renderPanel(match: MatchDetail = makeMatch()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <FetchPanel match={match} />
    </QueryClientProvider>,
  );
  return { queryClient, invalidateSpy };
}

beforeEach(() => {
  vi.mocked(getMatchFootage).mockResolvedValue(makeJob());
  vi.mocked(fetchMatchFootage).mockResolvedValue(makeJob({ state: "queued", queue_position: 1 }));
  vi.mocked(cancelMatchFootage).mockResolvedValue(makeJob({ state: "idle" }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("FetchPanel", () => {
  it("renders idle state with pre-filled URL, remembered cookies/profile, Fetch, and terminal command", async () => {
    vi.mocked(getMatchFootage).mockResolvedValue(
      makeJob({ cookies_from_browser: "chrome:Profile 1" }),
    );
    renderPanel(makeMatch({ source_url: SAMPLE_URL }));

    const urlInput = screen.getByLabelText("Video URL") as HTMLInputElement;
    expect(urlInput.value).toBe(SAMPLE_URL);

    await waitFor(() => {
      expect((screen.getByLabelText("Cookies from") as HTMLSelectElement).value).toBe("chrome");
    });
    expect((screen.getByLabelText("Profile (optional)") as HTMLInputElement).value).toBe(
      "Profile 1",
    );
    expect(screen.getByText(/or from the terminal/i)).toBeTruthy();
    expect(screen.getByText(/pb-tokei download/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() =>
      expect(fetchMatchFootage).toHaveBeenCalledWith(MATCH_ID, {
        url: SAMPLE_URL,
        cookies_from_browser: "chrome:Profile 1",
      }),
    );
  });

  it("renders only a Convert button when original footage is already on disk", async () => {
    renderPanel(
      makeMatch({
        video_status: "not_converted",
        original_present: true,
        source_url: SAMPLE_URL,
        fix_command: "pb-tokei convert /data/footage/abc123.mkv",
      }),
    );

    expect(screen.queryByLabelText("Video URL")).toBeNull();
    const convertBtn = await screen.findByRole("button", { name: "Convert" });
    fireEvent.click(convertBtn);

    await waitFor(() => expect(fetchMatchFootage).toHaveBeenCalledWith(MATCH_ID, {}));
  });

  it("renders queued state with queue position and cancels on click", async () => {
    vi.mocked(getMatchFootage).mockResolvedValue(makeJob({ state: "queued", queue_position: 2 }));
    renderPanel();

    expect(await screen.findByText("Queued (2)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelMatchFootage).toHaveBeenCalledWith(MATCH_ID));
  });

  it("renders downloading progress with percent, speed, ETA, and converting progress", async () => {
    vi.mocked(getMatchFootage).mockResolvedValue(
      makeJob({ state: "downloading", percent: 42.4, speed: "5.23MiB/s", eta: "00:42" }),
    );
    const { queryClient } = renderPanel();

    expect(await screen.findByText("Downloading 42%")).toBeTruthy();
    expect(screen.getByText("5.23MiB/s · ETA 00:42")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();

    // Update cached job to converting phase.
    queryClient.setQueryData(
      ["matches", MATCH_ID, "footage"],
      makeJob({ state: "converting", percent: 68 }),
    );
    expect(await screen.findByText("Converting to 60 fps 68%")).toBeTruthy();
  });

  it("renders error with hint, clickable link, and expandable stderr", async () => {
    vi.mocked(getMatchFootage).mockResolvedValue(
      makeJob({
        state: "error",
        error: "yt-dlp is not installed or not on PATH",
        hint: "Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation) and ensure it is on PATH.",
        stderr_tail: "FileNotFoundError: yt-dlp",
        requested_url: SAMPLE_URL,
      }),
    );
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("yt-dlp is not installed");
    const link = screen.getByRole("link", {
      name: "https://github.com/yt-dlp/yt-dlp#installation",
    });
    expect(link.getAttribute("href")).toBe("https://github.com/yt-dlp/yt-dlp#installation");
    expect(screen.getByText("Raw output (stderr)")).toBeTruthy();
    expect(screen.getByText("FileNotFoundError: yt-dlp")).toBeTruthy();
    // Retry form remains available underneath.
    expect(screen.getByRole("button", { name: "Fetch" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Video URL").value).toBe(SAMPLE_URL);
  });

  it("rechecks the Match when a job can have finished before the Workspace's first poll", async () => {
    const { invalidateSpy } = renderPanel();

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["matches", MATCH_ID], exact: true });
    });
  });

  it("invalidates Match queries when an active job completes so Workspace remounts ready", async () => {
    vi.mocked(getMatchFootage).mockResolvedValue(makeJob({ state: "converting", percent: 90 }));
    const { queryClient, invalidateSpy } = renderPanel();

    expect(await screen.findByText("Converting to 60 fps 90%")).toBeTruthy();

    // Simulate job finishing (transitions converting -> idle).
    queryClient.setQueryData(["matches", MATCH_ID, "footage"], makeJob({ state: "idle" }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["matches", MATCH_ID], exact: true });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["matches"], exact: true });
    });
  });
});
