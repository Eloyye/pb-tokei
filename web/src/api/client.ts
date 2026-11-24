import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

const api = createClient<paths>();

export type Match = Awaited<ReturnType<typeof listMatches>>[number];
export type MatchDetail = Awaited<ReturnType<typeof getMatch>>;

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
/** Live play from one Camera View, `start_frame` to `end_frame` inclusive. */
export type PlaySegment = Schemas["PlaySegmentIO"];
export type CalibrationOut = Schemas["CalibrationOut"];
/** A Calibration's own fields, without its fit: what is edited and saved. */
export type Calibration = Pick<
  CalibrationOut,
  "camera_view" | "effective_from_frame" | "reference_frame" | "landmarks"
>;

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
      body: calibrations.map(({ effective_from_frame, reference_frame, landmarks }) => ({
        effective_from_frame,
        reference_frame,
        landmarks,
      })),
    },
  );
  if (data === undefined) throw apiError(response, error);
  return data;
}

export function matchVideoUrl(matchId: string): string {
  return `/api/matches/${encodeURIComponent(matchId)}/video`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function apiError(response: Response, body: unknown): ApiError {
  const detail =
    typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
  const message = typeof detail === "string" ? detail : `${response.status} ${response.statusText}`;
  return new ApiError(response.status, message);
}
