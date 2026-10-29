import { Link } from "react-router-dom"

export function NotFoundPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="leading-7 text-(--muted)">
        That address does not match a Manifest page.{" "}
        <Link to="/" className="font-medium text-(--accent) underline underline-offset-4">
          Go back home
        </Link>
        .
      </p>
    </div>
  )
}
