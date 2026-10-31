import { AppError } from "../shared/http/errors.js"
import { isUniqueViolation } from "../shared/postgres/errors.js"
import type { VersionedSave } from "../shared/postgres/versioned.js"
import type { ColumnEnd, ManifestEditsRepository, ManifestScope } from "./editor-repository.js"
import {
  typesCompatible,
  type ColumnPatch,
  type CreateRelationshipInput,
  type ObjectPatch,
  type UpdateRelationshipInput,
} from "./editor-schemas.js"
import type { ManifestColumn, ManifestObject, ManifestRelationship } from "./schemas.js"

/** Manual relationships per source. */
export const MAX_MANUAL_RELATIONSHIPS = 1_000

const RELATIONSHIP_NOT_FOUND = "Relationship not found"
const DUPLICATE_RELATIONSHIP = "This relationship already exists."

/** The saved record, or the error that tells the editor why it was not saved. */
function savedRecord<T>(result: VersionedSave<T>, thing: string, notFound: string): T {
  if (result.status === "missing") throw AppError.notFound(notFound)
  if (result.status === "stale") throw AppError.stale(thing, result.current)
  return result.record
}

const endLabel = (end: ColumnEnd) => `${end.schema}.${end.objectName}.${end.name}`

/**
 * Edits the meaning people attach to discovered metadata: labels and
 * descriptions on tables, views, and columns, remarks on foreign keys, and
 * manual relationships between columns of the same source.
 */
export class ManifestEditorService {
  constructor(private readonly edits: ManifestEditsRepository) {}

  async updateObject(
    scope: ManifestScope,
    objectId: string,
    input: ObjectPatch,
    userId: string,
  ): Promise<ManifestObject> {
    const { version, ...changes } = input
    const result = await this.edits.updateObject(scope, objectId, version, changes, userId)
    return savedRecord(result, "table", "Table or view not found")
  }

  async updateColumn(
    scope: ManifestScope,
    columnId: string,
    input: ColumnPatch,
    userId: string,
  ): Promise<ManifestColumn> {
    const { version, ...changes } = input
    const result = await this.edits.updateColumn(scope, columnId, version, changes, userId)
    return savedRecord(result, "column", "Column not found")
  }

  async createRelationship(
    scope: ManifestScope,
    input: CreateRelationshipInput,
    userId: string,
  ): Promise<ManifestRelationship> {
    const { from, to } = await this.linkableEnds(scope, input.fromColumnId, input.toColumnId)
    if ((await this.edits.countManualRelationships(scope)) >= MAX_MANUAL_RELATIONSHIPS) {
      throw AppError.conflict(
        `A source can have at most ${MAX_MANUAL_RELATIONSHIPS} manual relationships. Remove one first.`,
      )
    }
    await this.rejectForeignKeyDuplicate(scope, from, to)
    let id: string
    try {
      id = await this.edits.insertManualRelationship(scope, {
        from,
        to,
        remark: input.remark ?? null,
        userId,
      })
    } catch (error) {
      throw isUniqueViolation(error) ? AppError.conflict(DUPLICATE_RELATIONSHIP) : error
    }
    const created = await this.edits.relationship(scope, id)
    if (!created) throw new Error("A created relationship could not be read back")
    return created
  }

  /** Foreign keys only take a remark; manual relationships can also move to other columns. */
  async updateRelationship(
    scope: ManifestScope,
    id: string,
    input: UpdateRelationshipInput,
    userId: string,
  ): Promise<ManifestRelationship> {
    const existing = await this.edits.relationship(scope, id)
    if (!existing) throw AppError.notFound(RELATIONSHIP_NOT_FOUND)
    let ends: { from: ColumnEnd; to: ColumnEnd } | undefined
    if (input.fromColumnId && input.toColumnId) {
      if (existing.origin !== "manual") {
        throw AppError.validation(
          "Foreign keys come from the source, so only their remark can change.",
        )
      }
      ends = await this.linkableEnds(scope, input.fromColumnId, input.toColumnId)
      await this.rejectForeignKeyDuplicate(scope, ends.from, ends.to)
    }
    try {
      const result = await this.edits.updateRelationship(
        scope,
        id,
        input.version,
        { ...(ends ? { ends } : {}), remark: input.remark },
        userId,
      )
      return savedRecord(result, "relationship", RELATIONSHIP_NOT_FOUND)
    } catch (error) {
      throw isUniqueViolation(error) ? AppError.conflict(DUPLICATE_RELATIONSHIP) : error
    }
  }

  async deleteRelationship(scope: ManifestScope, id: string): Promise<void> {
    const existing = await this.edits.relationship(scope, id)
    if (!existing) throw AppError.notFound(RELATIONSHIP_NOT_FOUND)
    if (existing.origin !== "manual") {
      throw AppError.conflict(
        "Foreign keys come from the source and cannot be removed here. Add a remark instead.",
      )
    }
    if (!(await this.edits.deleteManualRelationship(scope, id))) {
      throw AppError.notFound(RELATIONSHIP_NOT_FOUND)
    }
  }

  /** Both columns exist in this source, are still present, and hold comparable values. */
  private async linkableEnds(
    scope: ManifestScope,
    fromColumnId: string,
    toColumnId: string,
  ): Promise<{ from: ColumnEnd; to: ColumnEnd }> {
    const ends = await this.edits.columnEnds(scope, [fromColumnId, toColumnId])
    const from = ends.find((end) => end.columnId === fromColumnId)
    const to = ends.find((end) => end.columnId === toColumnId)
    if (!from) {
      throw AppError.validation("Choose a column of a table or view in this source.", {
        field: "fromColumnId",
      })
    }
    if (!to) {
      throw AppError.validation("Choose a column of a table or view in this source to refer to.", {
        field: "toColumnId",
      })
    }
    if (from.columnId === to.columnId) {
      throw AppError.validation("Choose two different columns.", { field: "toColumnId" })
    }
    for (const [end, field] of [
      [from, "fromColumnId"],
      [to, "toColumnId"],
    ] as const) {
      if (!end.present) {
        throw AppError.validation(
          `${endLabel(end)} is no longer in the source. Choose another column.`,
          { field },
        )
      }
    }
    if (!typesCompatible(from, to)) {
      throw AppError.validation(
        `${endLabel(from)} (${from.dataType}) and ${endLabel(to)} (${to.dataType}) hold different kinds of values, so one cannot refer to the other.`,
        { field: "toColumnId" },
      )
    }
    return { from, to }
  }

  private async rejectForeignKeyDuplicate(
    scope: ManifestScope,
    from: ColumnEnd,
    to: ColumnEnd,
  ): Promise<void> {
    if (await this.edits.foreignKeyLinks(scope, from, to)) {
      throw AppError.conflict(
        "A foreign key in the source already links these columns. Add a remark to it instead.",
      )
    }
  }
}
