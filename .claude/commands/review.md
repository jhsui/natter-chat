---
description: Review the current diff before committing
---

Review the uncommitted changes (`git diff` and `git status`) against CLAUDE.md. Do not change any code; report only.

Check for:

1. Logic errors the tests would not catch: off-by-one, wrong user id, missing `await`, a race between tabs or sockets
2. Security: auth checks on every new route and socket event, parameterized SQL, nothing that weakens link-preview or image protections, no secrets in code or logs
3. Types: any `any`, `as` casts or `!` that hide a real problem
4. Missing tests, especially the not-logged-in and wrong-user cases
5. Anything in the diff that wasn't part of the agreed spec

List each finding with the file and line, how serious it is, and a suggested fix. Finish with whether it is ready to commit.
