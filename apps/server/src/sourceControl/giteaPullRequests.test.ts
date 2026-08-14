import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { decodeGiteaPullRequestJson, decodeGiteaPullRequestListJson } from "./giteaPullRequests.ts";

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  assert.equal(Result.isSuccess(result), true, "expected the decode to succeed");
  return (result as Result.Success<A, unknown>).success;
}

/**
 * Verbatim from `tea pulls list --state all -o json -f index,title,state,url,head,base,updated`
 * against Gitea 1.27.1. Every value is a string, including the index, because the listing is
 * rendered by `tea`'s table printer rather than marshalled from the API struct.
 */
const LIST_JSON = `[
  {
    "index": "1",
    "title": "Probe PR for tea JSON shape",
    "state": "open",
    "url": "https://gitea.example.test/bram/probe/pulls/1",
    "head": "probe-branch",
    "base": "main",
    "updated": "2026-08-13T19:11:56Z"
  }
]`;

/** Verbatim from `tea pulls 1 -o json` on the same request: a marshalled struct, not the table. */
const DETAIL_JSON = `{
  "id": 4,
  "index": 1,
  "title": "Probe PR for tea JSON shape",
  "state": "open",
  "created": "2026-08-13T19:11:55Z",
  "updated": "2026-08-13T19:11:56Z",
  "labels": [],
  "user": "bram",
  "body": "Sampling tea output formats.",
  "assignees": [],
  "url": "https://gitea.example.test/bram/probe/pulls/1",
  "base": "main",
  "head": "probe-branch",
  "headSha": "33a6b14d954ad9c227d377e088a77ec350df44c3",
  "diffUrl": "https://gitea.example.test/bram/probe/pulls/1.diff",
  "mergeable": true,
  "hasMerged": false,
  "mergedAt": null,
  "closedAt": null,
  "reviews": [],
  "comments": []
}`;

it("reads the string-valued listing tea's table printer produces", () => {
  const records = expectSuccess(decodeGiteaPullRequestListJson(LIST_JSON));

  assert.deepStrictEqual(records, [
    {
      number: 1,
      title: "Probe PR for tea JSON shape",
      url: "https://gitea.example.test/bram/probe/pulls/1",
      baseRefName: "main",
      headRefName: "probe-branch",
      state: "open",
      updatedAt: DateTime.make("2026-08-13T19:11:56Z"),
      isCrossRepository: false,
    },
  ]);
});

it("reads the numeric index the pull request detail marshals", () => {
  const record = expectSuccess(decodeGiteaPullRequestJson(DETAIL_JSON));

  assert.deepStrictEqual(record, {
    number: 1,
    title: "Probe PR for tea JSON shape",
    url: "https://gitea.example.test/bram/probe/pulls/1",
    baseRefName: "main",
    headRefName: "probe-branch",
    state: "open",
    updatedAt: DateTime.make("2026-08-13T19:11:56Z"),
    isCrossRepository: false,
  });
});

/**
 * The two shapes disagree about a merged request, and the detail is the one that has to be read
 * carefully: the listing says `"merged"` outright, while the detail keeps Gitea's own spelling of
 * `"closed"` and records the merge separately. Reading the detail's `state` alone would report
 * every merged request as closed.
 */
it("calls a merged request merged in the listing, which says so", () => {
  const records = expectSuccess(
    decodeGiteaPullRequestListJson(
      `[{"index":"1","title":"Merged","state":"merged","url":"u","head":"h","base":"main","updated":"2026-08-13T19:12:39Z"}]`,
    ),
  );

  assert.strictEqual(records[0]?.state, "merged");
});

it("calls a merged request merged in the detail, which says closed and records the merge apart", () => {
  const record = expectSuccess(
    decodeGiteaPullRequestJson(
      `{"index":1,"title":"Merged","state":"closed","url":"u","head":"h","base":"main","updated":"2026-08-13T19:12:39Z","hasMerged":true,"mergedAt":"2026-08-13T19:12:39Z","closedAt":"2026-08-13T19:12:39Z"}`,
    ),
  );

  assert.strictEqual(record?.state, "merged");
});

it("keeps a genuinely closed request closed", () => {
  const record = expectSuccess(
    decodeGiteaPullRequestJson(
      `{"index":1,"title":"Closed","state":"closed","url":"u","head":"h","base":"main","updated":"2026-08-13T19:12:24Z","hasMerged":false,"mergedAt":null,"closedAt":"2026-08-13T19:12:24Z"}`,
    ),
  );

  assert.strictEqual(record?.state, "closed");
});

it("reads a fork's branch as owner and ref, the spelling Gitea uses in both directions", () => {
  const record = expectSuccess(
    decodeGiteaPullRequestJson(
      `{"index":7,"title":"From a fork","state":"open","url":"u","head":"contributor:feature/x","base":"main","updated":"2026-08-13T19:11:56Z"}`,
    ),
  );

  assert.deepStrictEqual(
    {
      headRefName: record?.headRefName,
      isCrossRepository: record?.isCrossRepository,
      headRepositoryOwnerLogin: record?.headRepositoryOwnerLogin,
    },
    {
      headRefName: "feature/x",
      isCrossRepository: true,
      headRepositoryOwnerLogin: "contributor",
    },
  );
});

it("treats the empty string the table printer writes for an absent date as no date", () => {
  const records = expectSuccess(
    decodeGiteaPullRequestListJson(
      `[{"index":"3","title":"No date","state":"open","url":"u","head":"h","base":"main","updated":""}]`,
    ),
  );

  assert.deepStrictEqual(records[0]?.updatedAt, Option.none());
});

it("drops an unreadable entry rather than emptying the whole listing", () => {
  const records = expectSuccess(
    decodeGiteaPullRequestListJson(
      `[{"nonsense":true},{"index":"2","title":"Real","state":"open","url":"u","head":"h","base":"main","updated":"2026-08-13T19:11:56Z"}]`,
    ),
  );

  assert.deepStrictEqual(
    records.map((record) => record.number),
    [2],
  );
});

it("rejects an index that is not a positive number", () => {
  const record = expectSuccess(
    decodeGiteaPullRequestJson(
      `{"index":"0","title":"Bad","state":"open","url":"u","head":"h","base":"main","updated":""}`,
    ),
  );

  assert.strictEqual(record, null);
});

it("fails on output that is not JSON at all", () => {
  assert.equal(Result.isSuccess(decodeGiteaPullRequestListJson("not json")), false);
});
