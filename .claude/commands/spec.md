---
description: Write a spec for a feature before any code is written
argument-hint: <feature description>
---

Write a spec for this feature: $ARGUMENTS

Read CLAUDE.md and the files this feature touches first. Do not write or edit any code yet.

Cover:

1. What the user sees and does, step by step
2. Changes to `shared/types.d.ts` (data shapes, REST responses, socket events)
3. Server changes: routes, socket handlers, SQL and schema changes
4. Client changes: components and state
5. Edge cases: not logged in, the wrong user, the other person offline, several open tabs, duplicate or retried requests, empty and oversized input
6. Security: does it touch auth, link previews, images or secrets?
7. Tests to add to `server/test/` (`chat.test.ts` or `demo.test.ts`)
8. How to split it into small commits

End with open questions, then wait for my approval before implementing.
