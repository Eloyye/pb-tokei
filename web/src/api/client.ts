import createClient from "openapi-fetch";
import type { components, operations, paths } from "./schema";

const api = createClient<paths>();
const RALLY_LOG_HEADER = "X-Rally-Log";

/**
 * The Rally Log this tab loaded its data from, named in every request so that once the app has
 * switched Rally Log (in another tab, say) the server answers 409 instead of reading or saving
 * the wrong file. Null until the tab learns which Rally Log is open.
 */
let tabRallyLog: string | null = null;
const tabRallyLogListeners = new Set<() => void>();

api.use({
  onRequest({ request }) {
    if (tabRallyLog !== null && !request.headers.has(RALLY_LOG_HEADER)) {
      request.headers.set(RALLY_LOG_HEADER, encodeURIComponent(tabRallyLog));
    }
    return request;
  },
});

export function getTabRallyLog(): string | null {
  return tabRallyLog;
}

export function subscribeTabRallyLog(listener: () => void): () => void {
  tabRallyLogListeners.add(listener);
  return () => tabRallyLogListeners.delete(listener);
}

function setTabRallyLog(path: string | null) {
  if (path === tabRallyLog) return;
  tabRallyLog = path;
  for (const listener of tabRallyLogListeners) listener();
}

export type RallyLogInfo = Schemas["RallyLogOut"];
export type RecentRallyLog = Schemas["RecentRallyLogOut"];
export type Match = Awaited<ReturnType<typeof listMatches>>[number];
export type MatchDetail = Awaited<ReturnType<typeof getMatch>>;
export type CreateMatchIn = Schemas["CreateMatchIn"];
export type UpdateMatchIn = Schemas["UpdateMatchIn"];
export type ReplacePlayerIn = Schemas["ReplacePlayerIn"];
export type UpdatePlayerIn = Schemas["UpdatePlayerIn"];
export type UpdateTournamentIn = Schemas["UpdateTournamentIn"];
export type UpdateFranchiseIn = Schemas["UpdateFranchiseIn"];
export type MergeIn = Schemas["MergeIn"];
export type PlayerEditOut = Schemas["PlayerEditOut"];
export type TournamentEditOut = Schemas["TournamentEditOut"];
export type FranchiseEditOut = Schemas["FranchiseEditOut"];
export type DeletedMatchOut = Schemas["DeletedMatchOut"];
export type Handedness = Schemas["Handedness"];
export type Tour = Schemas["Tour"];
export type Roster = Awaited<ReturnType<typeof getRoster>>;
export type OperatorTime = Schemas["OperatorTimeOut"];
export type OperatorSessionIn = Schemas["OperatorSessionIn"];

export const STALE_MATCH_MESSAGE = "This Match was edited elsewhere; reload";

export interface ExactNameConflict {
  id: string;
  name: string;
}

function rallyLogHeaders(rallyLog?: string | null): Record<string, string> | undefined {
  const path = rallyLog === undefined ? tabRallyLog : rallyLog;
  return path === null ? undefined : { [RALLY_LOG_HEADER]: encodeURIComponent(path) };
}

/** The Rally Log the app has open. A tab that hasn't loaded one yet takes it as its own. */
export async function getRallyLog(): Promise<RallyLogInfo> {
  const { data, error, response } = await api.GET("/api/rally-log");
  if (data === undefined) throw apiError(response, error);
  if (tabRallyLog === null) setTabRallyLog(data.path);
  return data;
}

/** Switches the app to another Rally Log, or with `create` to a new empty one, for this tab. */
export async function openRallyLog(path: string, create: boolean): Promise<RallyLogInfo> {
  const { data, error, response } = await api.POST("/api/rally-log", { body: { path, create } });
  if (data === undefined) throw apiError(response, error);
  setTabRallyLog(data.path);
  return data;
}

export async function listMatches() {
  const { data, error, response } = await api.GET("/api/matches");
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getRoster(rallyLog: string) {
  const { data, error, response } = await api.GET("/api/roster", {
    headers: { [RALLY_LOG_HEADER]: encodeURIComponent(rallyLog) },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function createMatch(body: CreateMatchIn, rallyLog: string) {
  const { data, error, response } = await api.POST("/api/matches", {
    body,
    headers: { [RALLY_LOG_HEADER]: encodeURIComponent(rallyLog) },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getMatch(matchId: string, options?: { rallyLog?: string | null }) {
  const { data, error, response } = await api.GET("/api/matches/{match_id}", {
    params: { path: { match_id: matchId } },
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function updateMatch(
  matchId: string,
  body: UpdateMatchIn,
  options?: { rallyLog?: string | null },
): Promise<MatchDetail> {
  const { data, error, response } = await api.PATCH("/api/matches/{match_id}", {
    params: { path: { match_id: matchId } },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function deleteMatch(
  matchId: string,
  options?: { rallyLog?: string | null },
): Promise<DeletedMatchOut> {
  const { data, error, response } = await api.DELETE("/api/matches/{match_id}", {
    params: { path: { match_id: matchId } },
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function replaceMatchPlayer(
  matchId: string,
  body: ReplacePlayerIn,
  options?: { rallyLog?: string | null },
): Promise<MatchDetail> {
  const { data, error, response } = await api.POST("/api/matches/{match_id}/replace-player", {
    params: { path: { match_id: matchId } },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function updatePlayer(
  playerId: string,
  body: UpdatePlayerIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<PlayerEditOut> {
  const { data, error, response } = await api.PATCH("/api/players/{player_id}", {
    params: {
      path: { player_id: playerId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function mergePlayer(
  playerId: string,
  body: MergeIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<PlayerEditOut> {
  const { data, error, response } = await api.POST("/api/players/{player_id}/merge", {
    params: {
      path: { player_id: playerId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function updateTournament(
  tournamentId: string,
  body: UpdateTournamentIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<TournamentEditOut> {
  const { data, error, response } = await api.PATCH("/api/tournaments/{tournament_id}", {
    params: {
      path: { tournament_id: tournamentId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function mergeTournament(
  tournamentId: string,
  body: MergeIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<TournamentEditOut> {
  const { data, error, response } = await api.POST("/api/tournaments/{tournament_id}/merge", {
    params: {
      path: { tournament_id: tournamentId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function updateFranchise(
  franchiseId: string,
  body: UpdateFranchiseIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<FranchiseEditOut> {
  const { data, error, response } = await api.PATCH("/api/franchises/{franchise_id}", {
    params: {
      path: { franchise_id: franchiseId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function mergeFranchise(
  franchiseId: string,
  body: MergeIn,
  options?: { dryRun?: boolean; rallyLog?: string | null },
): Promise<FranchiseEditOut> {
  const { data, error, response } = await api.POST("/api/franchises/{franchise_id}/merge", {
    params: {
      path: { franchise_id: franchiseId },
      query: options?.dryRun ? { dry_run: true } : undefined,
    },
    body,
    headers: rallyLogHeaders(options?.rallyLog),
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getMatchReport(
  matchId: string,
  signal?: AbortSignal,
): Promise<Schemas["MatchReport"]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/report", {
    params: { path: { match_id: matchId } },
    cache: "no-store",
    signal,
  });
  if (data === undefined) throw apiError(response, error);
  // openapi-fetch widens the schema's fixed-size tuples to arrays.
  return data as Schemas["MatchReport"];
}

export async function listPlayers(signal?: AbortSignal) {
  const { data, error, response } = await api.GET("/api/players", { cache: "no-store", signal });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function listTeams(signal?: AbortSignal): Promise<Schemas["TeamListEntry"][]> {
  const { data, error, response } = await api.GET("/api/teams", { cache: "no-store", signal });
  if (data === undefined) throw apiError(response, error);
  return data as Schemas["TeamListEntry"][];
}

export type TeamMatchFilters = NonNullable<operations["getTeam"]["parameters"]["query"]>;
export type PlayerMatchFilters = NonNullable<operations["getPlayer"]["parameters"]["query"]>;
export type LeaderboardQuery = NonNullable<operations["getLeaderboard"]["parameters"]["query"]>;

export async function getPlayerReport(
  playerId: string,
  filters: PlayerMatchFilters,
  signal?: AbortSignal,
): Promise<Schemas["PlayerReport"]> {
  const { data, error, response } = await api.GET("/api/players/{player_id}", {
    params: { path: { player_id: playerId }, query: filters },
    cache: "no-store",
    signal,
  });
  if (data === undefined) throw apiError(response, error);
  return data as Schemas["PlayerReport"];
}

export async function getTeamReport(
  teamId: string,
  filters: TeamMatchFilters,
  signal?: AbortSignal,
): Promise<Schemas["TeamReport"]> {
  const { data, error, response } = await api.GET("/api/teams/{team_id}", {
    params: { path: { team_id: teamId }, query: filters },
    cache: "no-store",
    signal,
  });
  if (data === undefined) throw apiError(response, error);
  return data as Schemas["TeamReport"];
}

export async function getLeaderboard(
  query: LeaderboardQuery,
  signal?: AbortSignal,
): Promise<Schemas["Leaderboard"]> {
  const { data, error, response } = await api.GET("/api/leaderboard", {
    params: { query },
    cache: "no-store",
    signal,
  });
  if (data === undefined) throw apiError(response, error);
  return data as Schemas["Leaderboard"];
}

export async function upsertOperatorSession(
  matchId: string,
  sessionId: string,
  body: OperatorSessionIn,
  options?: { keepalive?: boolean; rallyLog?: string },
): Promise<OperatorTime> {
  const rallyLog = options?.rallyLog ?? tabRallyLog;
  const { data, error, response } = await api.PUT(
    "/api/matches/{match_id}/operator-sessions/{session_id}",
    {
      params: { path: { match_id: matchId, session_id: sessionId } },
      body,
      headers: rallyLog === null ? undefined : { [RALLY_LOG_HEADER]: encodeURIComponent(rallyLog) },
      keepalive: options?.keepalive,
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

type Schemas = components["schemas"];
export type CameraView = Schemas["CameraView"];
export type Landmark = Schemas["Landmark"];
export type PlacedLandmark = Schemas["PlacedLandmarkIO"];
/** Live play from one Camera View, `start_frame` to `end_frame` inclusive. */
export type PlaySegment = Schemas["PlaySegmentIO"];
export type CalibrationOut = Schemas["CalibrationOut"];
export type LandmarkErrorOut = Schemas["LandmarkErrorOut"];
export type CameraMotionOut = Schemas["CameraMotionOut"];
export type CameraMotionSpanOut = Schemas["CameraMotionSpanOut"];
export type CameraMotionStatus = Schemas["CameraMotionStatus"];
export type CameraMotionFramesOut = Schemas["CameraMotionFramesOut"];
export type Lens = Schemas["LensOut"];
export type UnmappedRangeOut = Schemas["UnmappedRangeOut"];
export type FootageJobOut = Schemas["FootageJobOut"];
export type FootageJobState = Schemas["FootageJobState"];
export type FootageJobSummaryOut = Schemas["FootageJobSummaryOut"];
export type FetchFootageIn = Schemas["FetchFootageIn"];
export type MatchPlayer = Schemas["MatchPlayerOut"];
export type AnchorKind = Schemas["AnchorKind"];
export type Certainty = Schemas["Certainty"];
export type Zone = Schemas["Zone"];
export type DeviceKind = Schemas["DeviceKind"];
export type PlayerAnchor = Schemas["PlayerAnchorIO"];
export type TeamEnd = Schemas["TeamEndIO"];
export type TrackPlayersIn = Schemas["TrackPlayersIn"];
export type PlayerTrackingStatus = Schemas["PlayerTrackingStatus"];
export type PlayerTrackingSpanOut = Schemas["PlayerTrackingSpanOut"];
export type PlayerTrackingOut = Schemas["PlayerTrackingOut"];
export type TrackedPlayerOut = Schemas["TrackedPlayerOut"];
export type FrameDetectionOut = Schemas["FrameDetectionOut"];
export type PlayerTrackingFrameOut = Schemas["PlayerTrackingFrameOut"];
export type PlayerTrackingFramesOut = Schemas["PlayerTrackingFramesOut"];
export type Game = Schemas["GameIO"];
export type Rally = Schemas["RallyIO"];
export type Shot = Schemas["ShotIO"];
export type ObservationGap = Schemas["GapIO"];
export type RallyEntry = Shot | ObservationGap;
export type Score = Schemas["ScoreIO"];
export type CourtPoint = Schemas["CourtPointIO"];
export type ShotPosition = Schemas["PlayerPositionIO"];
export type ShotError = Schemas["ErrorIO"];
export type Challenge = Schemas["ChallengeIO"];
export type RallyStatus = Schemas["RallyStatus"];
export type RefereeCall = Schemas["RefereeCall"];
export type Ruling = Schemas["Ruling"];
export type WinnerSource = Schemas["WinnerSource"];
export type ShotClass = Schemas["ShotClass"];
export type ContactKind = Schemas["ContactKind"];
export type ErrorKind = Schemas["ErrorKind"];
export type Parity = Schemas["Parity"];
/** A Calibration's own fields, without its fit: what is edited and saved. */
export type Calibration = Pick<
  CalibrationOut,
  "camera_view" | "effective_from_frame" | "reference_frame" | "landmarks" | "not_visible"
>;

/** A Calibration's own fields, dropping the fit the server computed. */
export function toCalibration({
  camera_view,
  effective_from_frame,
  reference_frame,
  landmarks,
  not_visible,
}: CalibrationOut): Calibration {
  return { camera_view, effective_from_frame, reference_frame, landmarks, not_visible };
}

export async function getPlaySegments(matchId: string): Promise<PlaySegment[]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/play-segments", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function replacePlaySegments(
  matchId: string,
  segments: PlaySegment[],
): Promise<PlaySegment[]> {
  const { data, error, response } = await api.PUT("/api/matches/{match_id}/play-segments", {
    params: { path: { match_id: matchId } },
    body: segments,
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getCalibrations(matchId: string): Promise<CalibrationOut[]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/calibrations", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

/** Replaces one Camera View's Calibrations; the others are left as they are. */
export async function replaceCalibrations(
  matchId: string,
  cameraView: CameraView,
  calibrations: Calibration[],
): Promise<CalibrationOut[]> {
  const { data, error, response } = await api.PUT(
    "/api/matches/{match_id}/calibrations/{camera_view}",
    {
      params: { path: { match_id: matchId, camera_view: cameraView } },
      // The Camera View is in the path, not the body.
      body: calibrations.map(({ camera_view: _view, ...fields }) => fields),
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

/** The video's URL, naming this tab's Rally Log as a `<video>` element can't send headers. */
export function matchVideoUrl(matchId: string): string {
  const url = `/api/matches/${encodeURIComponent(matchId)}/video`;
  return tabRallyLog === null ? url : `${url}?rally_log=${encodeURIComponent(tabRallyLog)}`;
}

export async function getMatchFootage(matchId: string): Promise<FootageJobOut> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/footage", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function fetchMatchFootage(
  matchId: string,
  body: FetchFootageIn,
): Promise<FootageJobOut> {
  const { data, error, response } = await api.POST("/api/matches/{match_id}/footage/fetch", {
    params: { path: { match_id: matchId } },
    body,
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function cancelMatchFootage(matchId: string): Promise<FootageJobOut> {
  const { data, error, response } = await api.POST("/api/matches/{match_id}/footage/cancel", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getCameraMotion(matchId: string): Promise<CameraMotionOut> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/camera-motion", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function trackCameraMotion(matchId: string): Promise<CameraMotionOut> {
  const { data, error, response } = await api.POST("/api/matches/{match_id}/camera-motion/track", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getCameraMotionFrames(
  matchId: string,
  startFrame: number,
  endFrame: number,
): Promise<CameraMotionFramesOut> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/camera-motion/frames", {
    params: {
      path: { match_id: matchId },
      query: { start_frame: startFrame, end_frame: endFrame },
    },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getPlayerAnchors(matchId: string): Promise<PlayerAnchor[]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/player-anchors", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function replacePlayerAnchors(
  matchId: string,
  anchors: PlayerAnchor[],
): Promise<PlayerAnchor[]> {
  const { data, error, response } = await api.PUT("/api/matches/{match_id}/player-anchors", {
    params: { path: { match_id: matchId } },
    body: anchors,
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getTeamEnds(matchId: string): Promise<TeamEnd[]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/team-ends", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function replaceTeamEnds(matchId: string, teamEnds: TeamEnd[]): Promise<TeamEnd[]> {
  const { data, error, response } = await api.PUT("/api/matches/{match_id}/team-ends", {
    params: { path: { match_id: matchId } },
    body: teamEnds,
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getGames(matchId: string): Promise<Game[]> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/games", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

/** Replaces all of a Match's Games, Rallies, Shots and Observation Gaps. */
export async function replaceGames(matchId: string, games: Game[]): Promise<Game[]> {
  const { data, error, response } = await api.PUT("/api/matches/{match_id}/games", {
    params: { path: { match_id: matchId } },
    body: games,
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getPlayerTracking(matchId: string): Promise<PlayerTrackingOut> {
  const { data, error, response } = await api.GET("/api/matches/{match_id}/player-tracking", {
    params: { path: { match_id: matchId } },
  });
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function trackPlayers(
  matchId: string,
  body?: Partial<TrackPlayersIn>,
): Promise<PlayerTrackingOut> {
  const payload: TrackPlayersIn = {
    priority_frame: body?.priority_frame ?? null,
    device: body?.device ?? "auto",
    wait: body?.wait ?? false,
  };
  const { data, error, response } = await api.POST(
    "/api/matches/{match_id}/player-tracking/track",
    {
      params: { path: { match_id: matchId } },
      body: payload,
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function cancelPlayerTracking(matchId: string): Promise<PlayerTrackingOut> {
  const { data, error, response } = await api.POST(
    "/api/matches/{match_id}/player-tracking/cancel",
    {
      params: { path: { match_id: matchId } },
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

export async function getPlayerTrackingFrames(
  matchId: string,
  startFrame: number,
  endFrame: number,
): Promise<PlayerTrackingFramesOut> {
  const { data, error, response } = await api.GET(
    "/api/matches/{match_id}/player-tracking/frames",
    {
      params: {
        path: { match_id: matchId },
        query: { start_frame: startFrame, end_frame: endFrame },
      },
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly conflict?: ExactNameConflict,
  ) {
    super(message);
  }
}

/** Whether a failed request may succeed if tried again: not a 4xx (a 422, a deleted Match). */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

/** Whether a workspace save failed because the Match was edited or deleted elsewhere. */
export function isStaleMatchError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404) return true;
  if (error.status === 422) {
    return error.message.startsWith(STALE_MATCH_MESSAGE) || error.message.includes("not in Match");
  }
  return false;
}

function apiError(response: Response, body: unknown): ApiError {
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
  const message = typeof detail === "string" ? detail : `${response.status} ${response.statusText}`;
  let conflict: ExactNameConflict | undefined;
  if (
    typeof body === "object" &&
    body !== null &&
    "existing_id" in body &&
    typeof body.existing_id === "string" &&
    "existing_name" in body &&
    typeof body.existing_name === "string"
  ) {
    conflict = { id: body.existing_id, name: body.existing_name };
  }
  return new ApiError(response.status, message, conflict);
}
