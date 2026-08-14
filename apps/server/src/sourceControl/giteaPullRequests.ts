import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

export interface NormalizedGiteaPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

/**
 * One schema for both shapes `tea` answers with, because it answers with two.
 *
 * `tea pulls list -o json` is rendered by the table printer, so every value arrives as a string —
 * `"index": "1"`, `"mergeable": "true"` — and an absent value as `""` rather than as null.
 * `tea pulls <index> -o json` marshals the struct instead: `index` is a number, the author is
 * `user` rather than `author`, and there are fields the list never carries.
 *
 * Nothing here is required beyond what both shapes always have, and every value is read
 * defensively, so a `tea` that gains or renames a field costs at most that field.
 */
const GiteaPullRequestSchema = Schema.Struct({
  index: Schema.Union([Schema.Number, Schema.String]),
  title: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  base: Schema.String,
  head: Schema.String,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  updated: Schema.optional(Schema.NullOr(Schema.String)),
  // Detail only. The list prints a merged request as `state: "merged"`, but the detail keeps
  // Gitea's own spelling — `state: "closed"` with the merge recorded separately — so a merged
  // request read one way must not come back closed when read the other.
  hasMerged: Schema.optional(Schema.NullOr(Schema.Union([Schema.Boolean, Schema.String]))),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** The table printer stringifies booleans, so `true` arrives as `true` or as `"true"`. */
function isTrue(value: boolean | string | null | undefined): boolean {
  return typeof value === "boolean" ? value : value?.trim().toLowerCase() === "true";
}

function pullRequestNumber(index: number | string): number | null {
  const parsed = typeof index === "number" ? index : Number(index.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Empty strings and unparseable stamps become "no timestamp" rather than a decode failure: the
 * table printer writes an absent value as `""`, and a request is still worth showing without the
 * date it was last touched.
 */
function parseUpdatedAt(value: string | null | undefined): Option.Option<DateTime.Utc> {
  const trimmed = trimOptionalString(value);
  return trimmed === null ? Option.none() : DateTime.make(trimmed);
}

function normalizeGiteaPullRequestState(
  raw: Schema.Schema.Type<typeof GiteaPullRequestSchema>,
): "open" | "closed" | "merged" {
  if (isTrue(raw.hasMerged) || trimOptionalString(raw.mergedAt) !== null) {
    return "merged";
  }
  const state = raw.state?.trim().toLowerCase();
  if (state === "merged") return "merged";
  if (state === "closed") return "closed";
  return "open";
}

/**
 * Gitea names a fork's branch `owner:branch`, the same spelling `tea pulls create --head` takes.
 * A bare name is a branch in the repository itself.
 *
 * Only the owner is recovered, never the full `owner/repo`: neither shape carries the fork's
 * repository name, and inventing one from the base repository would be wrong exactly when the
 * fork was renamed.
 */
function parseHeadRef(head: string): {
  readonly refName: string;
  readonly ownerLogin: string | null;
} {
  const match = /^([^:/\s]+):(.+)$/u.exec(head.trim());
  const ownerLogin = trimOptionalString(match?.[1]);
  const refName = trimOptionalString(match?.[2]);
  return ownerLogin !== null && refName !== null
    ? { refName, ownerLogin }
    : { refName: head.trim(), ownerLogin: null };
}

export function normalizeGiteaPullRequestRecord(
  raw: Schema.Schema.Type<typeof GiteaPullRequestSchema>,
): NormalizedGiteaPullRequestRecord | null {
  const number = pullRequestNumber(raw.index);
  const title = trimOptionalString(raw.title);
  const baseRefName = trimOptionalString(raw.base);
  const head = parseHeadRef(raw.head);
  if (number === null || title === null || baseRefName === null || head.refName.length === 0) {
    return null;
  }

  return {
    number,
    title,
    url: trimOptionalString(raw.url) ?? "",
    baseRefName,
    headRefName: head.refName,
    state: normalizeGiteaPullRequestState(raw),
    updatedAt: parseUpdatedAt(raw.updated),
    isCrossRepository: head.ownerLogin !== null,
    ...(head.ownerLogin === null ? {} : { headRepositoryOwnerLogin: head.ownerLogin }),
  };
}

const decodeGiteaPullRequestArray = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeGiteaPullRequest = decodeJsonResult(GiteaPullRequestSchema);
const decodeGiteaPullRequestEntry = Schema.decodeUnknownExit(GiteaPullRequestSchema);

export const formatGiteaJsonDecodeError = formatSchemaError;

/**
 * Entries `tea` prints that this cannot read are dropped rather than failing the listing, which
 * is what keeps one malformed request from emptying the branch's whole list.
 */
export function decodeGiteaPullRequestListJson(
  raw: string,
): Result.Result<ReadonlyArray<NormalizedGiteaPullRequestRecord>, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGiteaPullRequestArray(raw);
  if (!Result.isSuccess(result)) {
    return Result.fail(result.failure);
  }

  const pullRequests: Array<NormalizedGiteaPullRequestRecord> = [];
  for (const entry of result.success) {
    const decodedEntry = decodeGiteaPullRequestEntry(entry);
    if (Exit.isFailure(decodedEntry)) {
      continue;
    }
    const normalized = normalizeGiteaPullRequestRecord(decodedEntry.value);
    if (normalized !== null) {
      pullRequests.push(normalized);
    }
  }
  return Result.succeed(pullRequests);
}

export function decodeGiteaPullRequestJson(
  raw: string,
): Result.Result<NormalizedGiteaPullRequestRecord | null, Cause.Cause<Schema.SchemaError>> {
  const result = decodeGiteaPullRequest(raw);
  return Result.isSuccess(result)
    ? Result.succeed(normalizeGiteaPullRequestRecord(result.success))
    : Result.fail(result.failure);
}
