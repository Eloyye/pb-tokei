import { useQuery, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, isRetryable } from "../api/client";
import { waitUntilSaved } from "../lib/unsavedChanges";
import { useOpenRallyLogPicker } from "../shell/rallyLog";

export function useReportQuery<T>(
  key: QueryKey,
  read: (signal: AbortSignal) => Promise<T>,
  placeholderData?: UseQueryOptions<T>["placeholderData"],
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      // Annotate can still be flushing its last edit when a report opens.
      await waitUntilSaved();
      signal.throwIfAborted();
      return read(signal);
    },
    gcTime: 0,
    placeholderData,
    refetchOnMount: "always",
    retry: (failures, error) => failures < 3 && isRetryable(error),
  });
}

export function ReportLoadError({
  error,
  retry,
  index,
}: {
  error: Error;
  retry: () => void;
  index?: "/players" | "/teams";
}) {
  const openPicker = useOpenRallyLogPicker();
  const status = error instanceof ApiError ? error.status : undefined;
  const conflict = status === 409;
  return (
    <p className="match-report notice error" role="alert">
      {error.message}{" "}
      {status === 404 && index ? (
        <Link to={index} className="button">
          {index === "/players" ? "Back to Players" : "Back to Teams"}
        </Link>
      ) : (
        <button type="button" className="button" onClick={conflict ? openPicker : retry}>
          {conflict ? "Choose a Rally Log" : "Retry"}
        </button>
      )}
    </p>
  );
}
