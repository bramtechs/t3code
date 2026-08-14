import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as GiteaCli from "./GiteaCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlUnknownRemoteRefinementInput,
} from "./SourceControlProviderDiscovery.ts";

function toChangeRequest(summary: GiteaCli.GiteaPullRequestSummary): ChangeRequest {
  return {
    provider: "gitea",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state ?? "open",
    updatedAt: summary.updatedAt ?? Option.none(),
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}

/**
 * Gitea is set up per host rather than once: `tea logins list` is the whole answer, and a `tea`
 * with no login is as unusable as no `tea` at all.
 *
 * The default login is the account reported, since that is the one a command in a repository
 * `tea` does not recognise will reach for.
 */
function parseGiteaAuth(input: SourceControlAuthProbeInput) {
  const logins = GiteaCli.parseGiteaLogins(combinedAuthOutput(input));
  const login = logins.find((entry) => entry.isDefault) ?? logins[0];

  if (login !== undefined && login.user !== null) {
    return providerAuth({
      status: "authenticated",
      account: login.user,
      host: GiteaCli.giteaLoginHosts(login)[0],
    });
  }

  if (login !== undefined) {
    // A login without a user name is still a login; `tea` just did not say who it belongs to.
    return providerAuth({
      status: "authenticated",
      host: GiteaCli.giteaLoginHosts(login)[0],
    });
  }

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ??
        "Run `tea login add` to authenticate the Gitea CLI.",
    });
  }

  return providerAuth({
    status: "unauthenticated",
    detail: "No Gitea logins are configured. Run `tea login add` to add one.",
  });
}

/**
 * Whether an unrecognised remote is a Gitea host, answered by asking `tea` whether it holds a
 * login for it. This is how self-hosted Gitea is found at all: the hostname is usually the
 * admin's own — `git.example.com` — and says nothing, so the only honest evidence that Gitea is
 * behind it is that the operator has already told `tea` so.
 */
function refineUnknownGiteaRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase().replace(/:\d+$/u, "");
  const matched = GiteaCli.parseGiteaLogins(combinedAuthOutput(input.auth)).some((login) =>
    GiteaCli.giteaLoginHosts(login).includes(host),
  );

  if (!matched) {
    return null;
  }

  return {
    kind: "gitea",
    name: "Gitea Self-Hosted",
    baseUrl: input.context.provider.baseUrl,
  } as const;
}

export const discovery = {
  type: "cli",
  kind: "gitea",
  label: "Gitea",
  executable: "tea",
  versionArgs: ["--version"],
  // `logins list` rather than a `whoami`: it names every host `tea` can reach, which is both what
  // reports the setup and what recognises a self-hosted remote below.
  authArgs: ["logins", "list", "--output", "json"],
  parseAuth: parseGiteaAuth,
  refineUnknownRemote: refineUnknownGiteaRemote,
  installHint:
    "Install the Gitea command-line tool (`tea`) from https://gitea.com/gitea/tea or your package manager (for example `brew install tea`), then run `tea login add`.",
} satisfies SourceControlCliDiscoverySpec;

export const make = Effect.gen(function* () {
  const gitea = yield* GiteaCli.GiteaCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: "gitea",
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitea
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "gitea",
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      gitea.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return gitea
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source ? { source } : {}),
          ...(input.target ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "gitea",
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      gitea.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      gitea.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: "gitea",
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    // `tea` exposes no read of a repository's default branch — neither `repos ls` nor
    // `branches ls` says which one it is — so the caller is told nothing rather than guessed at.
    // It falls back to the branch's own upstream, and to `main` after that.
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: (input) =>
      gitea
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.force !== undefined ? { force: input.force } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "gitea",
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
  });
});

export const layer = Layer.effect(SourceControlProvider.SourceControlProvider, make);
