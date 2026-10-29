import { EmptyState } from "@/shared/ui/states.tsx"

export function PlaceholderPage({
  title,
  emptyTitle,
  description,
}: {
  title: string
  emptyTitle: string
  description: string
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <EmptyState title={emptyTitle} description={description} />
    </div>
  )
}
