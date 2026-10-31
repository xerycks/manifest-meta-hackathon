import { formatRelativeTime } from "../lib/relative-time.ts"
import { Button } from "./button.tsx"
import { Markdown } from "./markdown.tsx"

export interface ConflictField {
  label: string
  /** The newer saved value ("" when they cleared it). */
  value: string
  markdown?: boolean
}

/**
 * Shown when a save was rejected because someone saved a newer version while
 * this editor was open. The draft stays in the form; the user saves their
 * version on top of the newer one or takes the newer one instead.
 */
export function ConflictNotice({
  by,
  at,
  fields,
  saving,
  onKeepMine,
  onTakeTheirs,
}: {
  by: string | null
  at: string | null
  /** The fields they changed, with their saved values. */
  fields: ConflictField[]
  saving: boolean
  onKeepMine: () => void
  onTakeTheirs: () => void
}) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm"
    >
      <div>
        <p className="font-medium text-(--warning)">
          {by ?? "Someone"} saved a newer version
          {at && (
            <>
              {" "}
              <time dateTime={at} title={new Date(at).toLocaleString()}>
                {formatRelativeTime(at)}
              </time>
            </>
          )}
        </p>
        <p className="mt-0.5 leading-6">
          Your draft is still in the form. Save your version on top of theirs (fields you did not
          change take their value), or use their version instead.
        </p>
      </div>
      {fields.length > 0 ? (
        <dl className="space-y-2 rounded-md border border-(--warning-border) bg-white px-3 py-2">
          {fields.map((field) => (
            <div key={field.label}>
              <dt className="text-xs font-medium text-(--muted)">Their {field.label.toLowerCase()}</dt>
              <dd className="mt-0.5">
                {!field.value.trim() ? (
                  <span className="text-(--muted) italic">(empty)</span>
                ) : field.markdown ? (
                  <Markdown>{field.value}</Markdown>
                ) : (
                  <span className="break-words whitespace-pre-wrap">{field.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="leading-6">They did not change any of the fields in this form.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onKeepMine} disabled={saving}>
          {saving ? "Saving…" : "Save my version"}
        </Button>
        <Button variant="secondary" onClick={onTakeTheirs} disabled={saving}>
          Use their version
        </Button>
      </div>
    </div>
  )
}
