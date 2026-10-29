import assert from "node:assert/strict"
import test from "node:test"

import { workspacePath } from "../src/shared/api/workspace-scope.ts"

test("workspacePath scopes endpoints under the workspace id", () => {
  assert.equal(
    workspacePath("ws-123", "/settings/description"),
    "/api/v1/workspaces/ws-123/settings/description",
  )
  assert.equal(workspacePath("ws-123", "settings"), "/api/v1/workspaces/ws-123/settings")
})

test("workspacePath encodes ids so they cannot escape their segment", () => {
  assert.equal(
    workspacePath("../other", "/settings"),
    "/api/v1/workspaces/..%2Fother/settings",
  )
})
