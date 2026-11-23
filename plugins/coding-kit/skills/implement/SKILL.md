---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

<!-- From mattpocock/skills (skills/engineering/implement) at 6d6a5b9072f4, MIT License, Copyright (c) 2026 Matt Pocock. Updated by Coding Kit. -->

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Call the Skill tool with "coding-kit:tdd" where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, call the Skill tool with "coding-kit:code-review" to review the work.

Commit your work to the current branch.
