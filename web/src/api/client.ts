import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

const api = createClient<paths>();

/**
 * The Rally Log this tab loaded its data from, named in every request so that once the app has
 * switched Rally Log (in another tab, say) the server answers 409 instead of reading or saving
 * the wrong file. Null until the tab learns which Rally Log is open.
 */
let tabRallyLog: string | null = null;
const tabRallyLogListeners = new Set<() => void>();

api.use({
  onRequest({ request }) {
    if (tabRallyLog !== null) request.headers.set("X-Rally-Log", encodeURIComponent(tabRallyLog));
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

export async function getMatch(matchId: string) {
  const { data, error, response } = await api.GET("/api/matches/{match_id}", {
    params: { path: { match_id: matchId } },
  });
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
export type UnmappedRangeOut = Schemas["UnmappedRangeOut"];
export type FootageJobOut = Schemas["FootageJobOut"];
export type FootageJobState = Schemas["FootageJobState"];
export type FootageJobSummaryOut = Schemas["FootageJobSummaryOut"];
export type FetchFootageIn = Schemas["FetchFootageIn"];
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a failed request may succeed if tried again: not a 4xx (a 422, a deleted Match). */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

function apiError(response: Response, body: unknown): ApiError {
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
  const message = typeof detail === "string" ? detail : `${response.status} ${response.statusText}`;
  return new ApiError(response.status, message);
}
