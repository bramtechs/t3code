import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GiteaCli from "./GiteaCli.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";

/** Verbatim from `tea logins list -o json`; `default` is the string "true", not a boolean. */
const LOGINS_JSON = `[
  {
    "name": "git.example.test",
    "url": "https://git.example.test",
    "ssh_host": "git.example.test",
    "user": "bram",
    "default": "true"
  }
]`;

function makeProvider(gitea: Partial<GiteaCli.GiteaCli["Service"]>) {
  return GiteaSourceControlProvider.make.pipe(Effect.provide(Layer.mock(GiteaCli.GiteaCli)(gitea)));
}

it.effect("maps Gitea pull request summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Gitea provider",
          url: "https://git.example.test/owner/repo/pulls/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open" as const,
          isCrossRepository: true,
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({ cwd: "/repo", reference: "42" });

    assert.deepStrictEqual(changeRequest, {
      provider: "gitea",
      number: 42,
      title: "Add Gitea provider",
      url: "https://git.example.test/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds repository context while retaining Gitea CLI causes", () =>
  Effect.gen(function* () {
    const cause = new GiteaCli.GiteaCliCommandError({
      operation: "execute",
      command: "tea",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({ createRepository: () => Effect.fail(cause) });

    const error = yield* provider
      .createRepository({ cwd: "/repo", repository: "owner/repo", visibility: "private" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "gitea",
        operation: "createRepository",
        command: "tea",
        repository: "owner/repo",
        detail: "Gitea CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Gitea pull requests through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GiteaCli.GiteaCli["Service"]["createPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: { owner: "owner", refName: "feature/provider" },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

/**
 * `tea` reads no default branch, so the caller is told nothing rather than guessed at — it falls
 * back to the branch's own upstream and then to `main`.
 */
it.effect("reports no default branch, which tea cannot answer", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({});
    assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo" }), null);
  }),
);

it("reports the default login as the authenticated account", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: LOGINS_JSON,
    stderr: "",
  });

  assert.deepStrictEqual(
    { status: auth.status, account: auth.account, host: auth.host },
    {
      status: "authenticated",
      account: Option.some("bram"),
      host: Option.some("git.example.test"),
    },
  );
});

it("reports an installed tea with no logins as unauthenticated", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "[]",
    stderr: "",
  });

  assert.strictEqual(auth.status, "unauthenticated");
});

/**
 * The case that matters most for Gitea: a self-hosted install under a domain that names neither
 * Gitea nor anything else, recognised only because `tea` already holds a login for it.
 */
it("claims an unrecognised remote when tea holds a login for that host", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "Git.Example.Test",
        baseUrl: "https://Git.Example.Test",
      },
      remoteName: "origin",
      remoteUrl: "https://Git.Example.Test/owner/repo.git",
    },
    auth: { exitCode: ChildProcessSpawner.ExitCode(0), stdout: LOGINS_JSON, stderr: "" },
  });

  assert.deepStrictEqual(provider, {
    kind: "gitea",
    name: "Gitea Self-Hosted",
    baseUrl: "https://Git.Example.Test",
  });
});

it("leaves an unrecognised remote alone when tea holds no login for that host", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "someone-elses.example.test",
        baseUrl: "https://someone-elses.example.test",
      },
      remoteName: "origin",
      remoteUrl: "https://someone-elses.example.test/owner/repo.git",
    },
    auth: { exitCode: ChildProcessSpawner.ExitCode(0), stdout: LOGINS_JSON, stderr: "" },
  });

  assert.strictEqual(provider, null);
});

it("matches a login whose SSH host differs from its web URL", () => {
  const logins = GiteaCli.parseGiteaLogins(
    `[{"name":"fly","url":"https://code.example.test","ssh_host":"ssh.example.test","user":"bram","default":"true"}]`,
  );

  assert.deepStrictEqual(GiteaCli.giteaLoginHosts(logins[0]!), [
    "code.example.test",
    "ssh.example.test",
    "fly",
  ]);
});

it("takes the pull request index from a number, a Gitea URL, or a #reference", () => {
  assert.deepStrictEqual(
    [
      GiteaCli.parsePullRequestIndex("42"),
      GiteaCli.parsePullRequestIndex("https://git.example.test/owner/repo/pulls/42"),
      GiteaCli.parsePullRequestIndex("#42"),
    ],
    ["42", "42", "42"],
  );
});
