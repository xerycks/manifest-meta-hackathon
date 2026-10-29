import { useQuery } from "@tanstack/react-query"

import { apiRequest } from "./client.ts"

export interface HealthResult {
  status: "ok"
  service: string
  uptimeSeconds: number
  storage: "configured" | "not-configured"
}

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => apiRequest<HealthResult>("/api/health", { signal }),
    retry: 1,
  })
}
