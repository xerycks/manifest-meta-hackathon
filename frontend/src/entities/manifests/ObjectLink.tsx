import { Link } from "react-router-dom"

import { objectHref } from "./links.ts"

/** A link to a table or view of the same source, marked when it is no longer in the source. */
export function ObjectLink({
  connectionId,
  end,
}: {
  connectionId: string
  end: { objectId: string; schema: string; name: string; present: boolean }
}) {
  return (
    <Link
      to={objectHref(connectionId, end.objectId)}
      className="rounded-sm font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
    >
      {end.schema}.{end.name}
      {!end.present && " (removed)"}
    </Link>
  )
}
