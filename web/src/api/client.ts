import createClient from "openapi-fetch";
import type { paths } from "./schema";

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
