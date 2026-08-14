import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";

import {
  TrimmedNonEmptyString,
  type SourceControlRepositoryVisibility,
  type VcsError,
} from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { decodeGiteaPullRequestJson, decodeGiteaPullRequestListJson } from "./giteaPullRequests.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The fields the list is asked for, in `tea`'s own names — its table printer keys the JSON by
 * them, so this string is also the shape of every object that comes back.
 */
const PULL_REQUEST_LIST_FIELDS = "index,title,state,url,head,base,updated";

/**
 * How many requests are read before narrowing to the branch. `tea pulls list` has no head-branch
 * filter of its own — unlike `glab mr list --source-branch` — so the branch's requests have to be
 * picked out of a page of them here. This bounds that page: a branch whose request is older than
 * the hundredth most recently touched one on the repository will not be found.
 */
const PULL_REQUEST_FETCH_LIMIT = 100;

const giteaCliExecutionErrorContext = {
  operation: Schema.Literal("execute"),
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

const giteaCliDecodeErrorContext = {
  command: Schema.Literal("tea"),
  cwd: Schema.String,
  cause: Schema.Defect(),
};

export class GiteaCliUnavailableError extends Schema.TaggedErrorClass<GiteaCliUnavailableError>()(
  "GiteaCliUnavailableError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI (`tea`) is required but not available on PATH.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaCliAuthenticationError extends Schema.TaggedErrorClass<GiteaCliAuthenticationError>()(
  "GiteaCliAuthenticationError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI has no login for this host. Run `tea login add` and retry.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestNotFoundError extends Schema.TaggedErrorClass<GiteaPullRequestNotFoundError>()(
  "GiteaPullRequestNotFoundError",
  {
    ...giteaCliExecutionErrorContext,
    reference: Schema.String,
  },
) {
  get detail(): string {
    return `Pull request ${this.reference} was not found. Check the number or URL and try again.`;
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "tea";
      readonly cwd: string;
      readonly reference: string;
    },
    error: VcsError,
  ): GiteaCliError {
    if (error._tag === "VcsProcessExitError" && error.failureKind === "not-found") {
      return new GiteaPullRequestNotFoundError({ ...context, cause: error });
    }

    return GiteaCliCommandError.fromVcsError(
      {
        operation: context.operation,
        command: context.command,
        cwd: context.cwd,
      },
      error,
    );
  }
}

export class GiteaCliCommandError extends Schema.TaggedErrorClass<GiteaCliCommandError>()(
  "GiteaCliCommandError",
  giteaCliExecutionErrorContext,
) {
  get detail(): string {
    return "Gitea CLI command failed.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }

  static fromVcsError(
    context: {
      readonly operation: "execute";
      readonly command: "tea";
      readonly cwd: string;
    },
    error: VcsError,
  ): GiteaCliError {
    return Match.valueTags(error, {
      VcsProcessSpawnError: (cause) => new GiteaCliUnavailableError({ ...context, cause }),
      VcsProcessExitError: (cause) => {
        switch (cause.failureKind) {
          case "authentication":
            return new GiteaCliAuthenticationError({ ...context, cause });
          case "not-found":
          case "rate-limited":
          case "command-failed":
          case undefined:
            return new GiteaCliCommandError({ ...context, cause });
        }
      },
      VcsProcessTimeoutError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessStdinWriteError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessOutputReadError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessOutputLimitError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsProcessMissingExitCodeError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsRepositoryDetectionError: (cause) => new GiteaCliCommandError({ ...context, cause }),
      VcsUnsupportedOperationError: (cause) => new GiteaCliCommandError({ ...context, cause }),
    });
  }
}

export class GiteaPullRequestListDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestListDecodeError>()(
  "GiteaPullRequestListDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literal("listPullRequests"),
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid pull request list JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestDecodeError extends Schema.TaggedErrorClass<GiteaPullRequestDecodeError>()(
  "GiteaPullRequestDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literal("getPullRequest"),
    reference: Schema.String,
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid pull request JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaRepositoryDecodeError extends Schema.TaggedErrorClass<GiteaRepositoryDecodeError>()(
  "GiteaRepositoryDecodeError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository"]),
    repository: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return "Gitea CLI returned invalid repository JSON.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaRepositoryNotFoundError extends Schema.TaggedErrorClass<GiteaRepositoryNotFoundError>()(
  "GiteaRepositoryNotFoundError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literals(["getRepositoryCloneUrls", "createRepository"]),
    repository: Schema.String,
  },
) {
  get detail(): string {
    return `Repository ${this.repository} was not found on the Gitea instance.`;
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GiteaPullRequestBodyReadError extends Schema.TaggedErrorClass<GiteaPullRequestBodyReadError>()(
  "GiteaPullRequestBodyReadError",
  {
    ...giteaCliDecodeErrorContext,
    operation: Schema.Literal("createPullRequest"),
    bodyFile: Schema.String,
  },
) {
  get detail(): string {
    return "The pull request description file could not be read.";
  }

  override get message(): string {
    return `Gitea CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export const GiteaCliError = Schema.Union([
  GiteaCliUnavailableError,
  GiteaCliAuthenticationError,
  GiteaPullRequestNotFoundError,
  GiteaCliCommandError,
  GiteaPullRequestListDecodeError,
  GiteaPullRequestDecodeError,
  GiteaRepositoryDecodeError,
  GiteaRepositoryNotFoundError,
  GiteaPullRequestBodyReadError,
]);
export type GiteaCliError = typeof GiteaCliError.Type;
export const isGiteaCliError = Schema.is(GiteaCliError);

export interface GiteaPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

export interface GiteaRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface GiteaLogin {
  readonly name: string;
  readonly url: string;
  readonly sshHost: string | null;
  readonly user: string | null;
  readonly isDefault: boolean;
}

export class GiteaCli extends Context.Service<
  GiteaCli,
  {
    readonly execute: (input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly stdin?: string;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<VcsProcess.VcsProcessOutput, GiteaCliError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<ReadonlyArray<GiteaPullRequestSummary>, GiteaCliError>;

    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
    }) => Effect.Effect<GiteaPullRequestSummary, GiteaCliError>;

    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly repository: string;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createRepository: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly visibility: SourceControlRepositoryVisibility;
    }) => Effect.Effect<GiteaRepositoryCloneUrls, GiteaCliError>;

    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<void, GiteaCliError>;

    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, GiteaCliError>;
  }
>()("t3/sourceControl/GiteaCli") {}

/** `tea repos search`/`ls` print these four under exactly these keys, all as strings. */
const RawGiteaRepositorySchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  ssh: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeGiteaRepositoryList = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawGiteaRepositorySchema)),
);

/**
 * `tea logins list -o json` writes `default` as the string `"true"`, not as a boolean, because it
 * goes through the same table printer the listings do.
 */
const RawGiteaLoginSchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  ssh_host: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(Schema.String)),
  default: Schema.optional(Schema.NullOr(Schema.Union([Schema.Boolean, Schema.String]))),
});

const decodeGiteaLoginList = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(RawGiteaLoginSchema)),
);

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The logins `tea` holds, or none when it cannot be run or says something unreadable. Used both to
 * report whether Gitea is set up and to decide whether an unrecognised remote is a Gitea host, so
 * it never fails: "no logins" and "no `tea`" lead to the same answer at both call sites.
 */
export function parseGiteaLogins(raw: string): ReadonlyArray<GiteaLogin> {
  const decoded = decodeGiteaLoginList(raw.trim());
  if (decoded._tag !== "Success") {
    return [];
  }

  const logins: Array<GiteaLogin> = [];
  for (const entry of decoded.value) {
    const url = trimOptionalString(entry.url);
    if (url === null) continue;
    logins.push({
      name: entry.name,
      url,
      sshHost: trimOptionalString(entry.ssh_host),
      user: trimOptionalString(entry.user),
      isDefault:
        typeof entry.default === "boolean"
          ? entry.default
          : entry.default?.trim().toLowerCase() === "true",
    });
  }
  return logins;
}

/** The hostname a login serves, for matching a git remote against it. */
export function giteaLoginHosts(login: GiteaLogin): ReadonlyArray<string> {
  const hosts: Array<string> = [];
  try {
    hosts.push(new URL(login.url).hostname.toLowerCase());
  } catch {
    // A login whose URL will not parse still matches on its name and SSH host below.
  }
  for (const candidate of [login.sshHost, login.name]) {
    const host = trimOptionalString(candidate)?.toLowerCase().replace(/:\d+$/u, "");
    if (host !== undefined && host !== null && !hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * `tea` filters by open or closed only. A merged request is a closed one to Gitea, so both closed
 * and merged are asked for as closed and told apart afterwards by what the record itself says.
 */
function stateArgs(state: "open" | "closed" | "merged" | "all"): ReadonlyArray<string> {
  switch (state) {
    case "open":
      return ["--state", "open"];
    case "closed":
    case "merged":
      return ["--state", "closed"];
    case "all":
      return ["--state", "all"];
  }
}

function normalizeHeadSelector(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerBranch = /^[^:]+:(.+)$/.exec(trimmed);
  return ownerBranch?.[1]?.trim() || trimmed;
}

function sourceRefName(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeHeadSelector(input.headSelector);
}

/**
 * What `--head` is given: `owner:branch` when the branch lives in a fork, the bare branch
 * otherwise. This is the spelling Gitea uses in both directions, so it is also what a listed
 * request's `head` is compared against.
 */
function headArgument(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string {
  const refName = sourceRefName(input);
  const owner = input.source?.owner;
  return owner ? `${owner}:${refName}` : refName;
}

/** The index behind a reference the UI may hand over as a number or as a full request URL. */
export function parsePullRequestIndex(reference: string): string {
  const trimmed = reference.trim();
  if (/^\d+$/u.test(trimmed)) {
    return trimmed;
  }
  // Gitea writes the segment in the plural: /{owner}/{repo}/pulls/{index}
  const fromUrl = /\/pulls\/(\d+)(?:[/?#]|$)/u.exec(trimmed)?.[1];
  return fromUrl ?? trimmed.replace(/^#/u, "");
}

function parseRepositoryPath(repository: string): {
  readonly owner: string | null;
  readonly name: string;
} {
  const parts: Array<string> = [];
  for (const part of repository.split("/")) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  const name = parts.at(-1) ?? repository.trim();
  const owner = parts.length > 1 ? (parts.at(-2) ?? null) : null;
  return { owner, name };
}

function toSummaryWithOptionalUpdatedAt(record: GiteaPullRequestSummary): GiteaPullRequestSummary {
  const { updatedAt, ...summary } = record;
  return updatedAt !== undefined && Option.isSome(updatedAt) ? { ...summary, updatedAt } : summary;
}

export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;

  const run = (
    input: Parameters<GiteaCli["Service"]["execute"]>[0],
    mapError: (error: VcsError) => GiteaCliError,
  ) =>
    process
      .run({
        operation: "GiteaCli.execute",
        command: "tea",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      })
      .pipe(Effect.mapError(mapError));

  const execute: GiteaCli["Service"]["execute"] = (input) =>
    run(input, (error) =>
      GiteaCliCommandError.fromVcsError(
        { operation: "execute", command: "tea", cwd: input.cwd },
        error,
      ),
    );

  const executePullRequest = (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly args: ReadonlyArray<string>;
  }) =>
    run(input, (error) =>
      GiteaPullRequestNotFoundError.fromVcsError(
        {
          operation: "execute",
          command: "tea",
          cwd: input.cwd,
          reference: input.reference,
        },
        error,
      ),
    );

  const findRepository = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly operation: "getRepositoryCloneUrls" | "createRepository";
  }) => {
    const { owner, name } = parseRepositoryPath(input.repository);
    return execute({
      cwd: input.cwd,
      args: [
        "repos",
        "search",
        ...(owner === null ? [] : ["--owner", owner]),
        "--fields",
        "name,owner,url,ssh",
        "--limit",
        String(PULL_REQUEST_FETCH_LIMIT),
        "--output",
        "json",
        name,
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        decodeGiteaRepositoryList(raw.length === 0 ? "[]" : raw).pipe(
          Effect.mapError(
            (cause) =>
              new GiteaRepositoryDecodeError({
                operation: input.operation,
                command: "tea",
                cwd: input.cwd,
                repository: input.repository,
                cause,
              }),
          ),
        ),
      ),
      Effect.flatMap((entries) => {
        // `repos search` matches on substrings, so the exact repository is picked out rather than
        // trusting the first hit: searching "utils" finds "doomhowl-utils" too.
        const match = entries.find(
          (entry) =>
            entry.name.toLowerCase() === name.toLowerCase() &&
            (owner === null || entry.owner.toLowerCase() === owner.toLowerCase()),
        );
        if (match === undefined) {
          return Effect.fail(
            new GiteaRepositoryNotFoundError({
              operation: input.operation,
              command: "tea",
              cwd: input.cwd,
              repository: input.repository,
              cause: new Error("No repository matched the search."),
            }),
          );
        }

        return Effect.succeed({
          nameWithOwner: `${match.owner}/${match.name}`,
          url: trimOptionalString(match.url) ?? "",
          sshUrl: trimOptionalString(match.ssh) ?? "",
        } satisfies GiteaRepositoryCloneUrls);
      }),
    );
  };

  return GiteaCli.of({
    execute,
    listPullRequests: (input) => {
      const wantedHead = sourceRefName(input).toLowerCase();
      const limit = input.limit ?? 20;
      return execute({
        cwd: input.cwd,
        args: [
          "pulls",
          "list",
          ...stateArgs(input.state),
          "--fields",
          PULL_REQUEST_LIST_FIELDS,
          "--limit",
          String(PULL_REQUEST_FETCH_LIMIT),
          "--output",
          "json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGiteaPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GiteaPullRequestListDecodeError({
                        operation: "listPullRequests",
                        command: "tea",
                        cwd: input.cwd,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  const matching = decoded.success.filter(
                    (record) =>
                      record.headRefName.toLowerCase() === wantedHead &&
                      // Closed and merged are one query to `tea`; keep only the one asked for.
                      (input.state === "all" || record.state === input.state),
                  );
                  return Effect.succeed(
                    matching.slice(0, limit).map(toSummaryWithOptionalUpdatedAt),
                  );
                }),
              ),
        ),
      );
    },
    getPullRequest: (input) => {
      const index = parsePullRequestIndex(input.reference);
      return executePullRequest({
        cwd: input.cwd,
        reference: input.reference,
        args: ["pulls", index, "--output", "json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeGiteaPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded) || decoded.success === null) {
                return Effect.fail(
                  new GiteaPullRequestDecodeError({
                    operation: "getPullRequest",
                    command: "tea",
                    cwd: input.cwd,
                    reference: input.reference,
                    cause: Result.isSuccess(decoded)
                      ? new Error("The pull request record was missing required fields.")
                      : decoded.failure,
                  }),
                );
              }

              return Effect.succeed(toSummaryWithOptionalUpdatedAt(decoded.success));
            }),
          ),
        ),
      );
    },
    getRepositoryCloneUrls: (input) =>
      findRepository({ ...input, operation: "getRepositoryCloneUrls" }),
    createRepository: (input) => {
      const { owner, name } = parseRepositoryPath(input.repository);
      return execute({
        cwd: input.cwd,
        args: [
          "repos",
          "create",
          "--name",
          name,
          ...(owner === null ? [] : ["--owner", owner]),
          ...(input.visibility === "private" ? ["--private"] : []),
        ],
        // `repos create` prints a human summary and ignores `--output json`, so the created
        // repository is read back rather than parsed out of that.
      }).pipe(Effect.flatMap(() => findRepository({ ...input, operation: "createRepository" })));
    },
    createPullRequest: (input) =>
      // `tea pulls create` has no `--body-file`, so the description is read here and passed as an
      // argument. That is the one place this differs from `gh` and `glab`, and it bounds a
      // description by the platform's argument limit rather than by what Gitea accepts.
      fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(
          (cause) =>
            new GiteaPullRequestBodyReadError({
              operation: "createPullRequest",
              command: "tea",
              cwd: input.cwd,
              bodyFile: input.bodyFile,
              cause,
            }),
        ),
        Effect.flatMap((body) =>
          execute({
            cwd: input.cwd,
            args: [
              "pulls",
              "create",
              "--head",
              headArgument(input),
              "--base",
              input.target?.refName ?? input.baseBranch,
              "--title",
              input.title,
              "--description",
              body,
            ],
          }),
        ),
        Effect.asVoid,
      ),
    checkoutPullRequest: (input) => {
      const index = parsePullRequestIndex(input.reference);
      return executePullRequest({
        cwd: input.cwd,
        reference: input.reference,
        // `--branch` so a request that has never been checked out here gets a local branch
        // instead of a detached head.
        args: ["pulls", "checkout", "--branch", index],
      }).pipe(Effect.asVoid);
    },
  });
});

export const layer = Layer.effect(GiteaCli, make);
