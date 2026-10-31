import { DiscoveryLimitExceeded, SourceConnectionError } from "../connections/adapters/types.js"
import type { ConnectionsService } from "../connections/service.js"
import { AppError } from "../shared/http/errors.js"
import type { ManifestsRepository, RunRef } from "./repository.js"
import type { RefreshRunner, StopReason } from "./runner.js"
import type {
  ConnectionManifest,
  ManifestObjectDetail,
  ManifestRefresh,
  RefreshTrigger,
} from "./schemas.js"

/** A refresh that runs longer than this is stopped and recorded as failed. */
export const MAX_REFRESH_MINUTES = 3
/** Objects listed per manifest request; a search narrows larger manifests. */
export const MAX_LISTED_OBJECTS = 2_500

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  )
}

const UNEXPECTED_FAILURE =
  "The refresh failed unexpectedly. Try again; if it keeps failing, check the backend logs."

/** The safe, user-facing reason a run failed, or null when the error is unexpected. */
function failureMessage(error: unknown, stop: AbortSignal, deadline: AbortSignal): string | null {
  if (stop.aborted) return "The backend stopped during this refresh. Start it again."
  if (deadline.aborted) {
    return `The refresh took longer than ${MAX_REFRESH_MINUTES} minutes and was stopped. Try again, or select fewer schemas.`
  }
  if (
    error instanceof SourceConnectionError ||
    error instanceof DiscoveryLimitExceeded ||
    error instanceof AppError
  ) {
    return error.message
  }
  return null
}

/**
 * Browses published metadata and runs refreshes. A refresh collects all of a
 * source's metadata first and publishes it in one transaction, so a failed or
 * cancelled run leaves the previous metadata exactly as it was.
 */
export class ManifestsService {
  constructor(
    private readonly manifests: ManifestsRepository,
    private readonly connections: ConnectionsService,
    private readonly runner: RefreshRunner,
  ) {}

  async browse(
    workspaceId: string,
    connectionId: string,
    search: string | undefined,
  ): Promise<ConnectionManifest> {
    const connection = await this.connections.get(workspaceId, connectionId)
    const [objects, lastPublished] = await Promise.all([
      this.manifests.listObjects(workspaceId, connectionId, {
        schemas: connection.schemas,
        search,
        limit: MAX_LISTED_OBJECTS + 1,
      }),
      this.manifests.lastPublished(workspaceId, connectionId),
    ])
    const listed = objects.slice(0, MAX_LISTED_OBJECTS)
    return {
      connectionId,
      schemas: connection.schemas.map((name) => ({
        name,
        objects: listed.filter((object) => object.schema === name),
      })),
      lastPublished,
      truncated: objects.length > MAX_LISTED_OBJECTS,
    }
  }

  async object(
    workspaceId: string,
    connectionId: string,
    objectId: string,
  ): Promise<ManifestObjectDetail> {
    const detail = await this.manifests.getObject(workspaceId, connectionId, objectId)
    if (!detail) throw AppError.notFound("Table or view not found")
    return detail
  }

  async latestRefresh(workspaceId: string, connectionId: string): Promise<ManifestRefresh | null> {
    await this.connections.get(workspaceId, connectionId)
    return this.manifests.latestRefresh(workspaceId, connectionId)
  }

  async refresh(workspaceId: string, connectionId: string, id: string): Promise<ManifestRefresh> {
    const refresh = await this.manifests.getRefresh(workspaceId, connectionId, id)
    if (!refresh) throw AppError.notFound("Refresh not found")
    return refresh
  }

  /** Queues a refresh and returns at once; progress is read from the run. */
  async startRefresh(
    workspaceId: string,
    connectionId: string,
    userId: string | null,
    trigger: RefreshTrigger,
  ): Promise<ManifestRefresh> {
    await this.connections.get(workspaceId, connectionId)
    let refresh: ManifestRefresh
    try {
      refresh = await this.manifests.createRefresh({
        workspaceId,
        connectionId,
        trigger,
        triggeredBy: userId,
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const active = await this.manifests.activeRefresh(workspaceId, connectionId)
      throw AppError.conflict("A refresh is already running for this source.", {
        refreshId: active?.id ?? null,
      })
    }
    const run = { id: refresh.id, workspaceId, connectionId }
    this.runner.start(refresh.id, (signal) => this.execute(run, signal))
    return refresh
  }

  /** Records the cancellation first, so nothing can publish afterwards, then stops the work. */
  async cancelRefresh(
    workspaceId: string,
    connectionId: string,
    id: string,
  ): Promise<ManifestRefresh> {
    const run = { id, workspaceId, connectionId }
    const cancelled = await this.manifests.finish(run, { status: "cancelled", error: null })
    if (!cancelled) {
      await this.refresh(workspaceId, connectionId, id)
      throw AppError.conflict("This refresh has already finished.")
    }
    this.runner.abort(id, "cancelled")
    return cancelled
  }

  /**
   * Starts discovery after a source is created or its schemas or settings
   * change, replacing a refresh that is still reading the old selection.
   * It never fails the save that triggered it.
   */
  async refreshAfterSave(event: {
    workspaceId: string
    connectionId: string
    userId: string
    trigger: Exclude<RefreshTrigger, "manual">
  }): Promise<void> {
    const { workspaceId, connectionId } = event
    try {
      const active = await this.manifests.activeRefresh(workspaceId, connectionId)
      if (active) await this.cancelRefresh(workspaceId, connectionId, active.id).catch(() => {})
      await this.startRefresh(workspaceId, connectionId, event.userId, event.trigger)
    } catch (error) {
      console.error(`Could not start a metadata refresh for source ${connectionId}`, error)
    }
  }

  private async execute(run: RunRef, stop: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(MAX_REFRESH_MINUTES * 60_000)
    const signal = AbortSignal.any([stop, deadline])
    try {
      signal.throwIfAborted()
      if (!(await this.manifests.markRunning(run))) return
      const metadata = await this.connections.discoverMetadata(run.workspaceId, run.connectionId, {
        signal,
        // Progress is informative: a failed write must not fail the refresh.
        onProgress: (progress) =>
          this.manifests.recordProgress(run, progress).catch((error: unknown) => {
            console.error(`Could not record progress for manifest refresh ${run.id}`, error)
          }),
      })
      signal.throwIfAborted()
      const total = metadata.objects.length
      await this.manifests.recordProgress(run, {
        phase: "publishing",
        objectsDone: total,
        objectsTotal: total,
      })
      await this.manifests.publish(run, metadata)
    } catch (error) {
      // A user cancel was recorded when it was requested.
      if (stop.aborted && (stop.reason as StopReason) === "cancelled") return
      let message = failureMessage(error, stop, deadline)
      if (message === null) {
        // Source errors are mapped to safe messages above, so this is our own storage or code.
        console.error(`Manifest refresh ${run.id} failed`, error)
        message = UNEXPECTED_FAILURE
      }
      await this.manifests
        .finish(run, { status: "failed", error: message.slice(0, 500) })
        .catch((finishError: unknown) => {
          console.error(`Could not record the outcome of manifest refresh ${run.id}`, finishError)
        })
    }
  }
}
