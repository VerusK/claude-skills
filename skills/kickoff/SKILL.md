---
name: kickoff
description: Scope new implementation work or an explicit design or feasibility session. Classifies spike, bounded, or architectural work, settles open decisions, and writes architectural specs. Use for kickoff, brainstorming, or before a new implementation plan; ordinary questions and read-only audits use their own workflow.
---

# Kickoff

Turn an idea into a spec through a decision-tree interview. Routine questions
with concrete options are judged by TypeSafe first; where the judge is not
confident, confidently picks a different option than your recommendation, or
is unavailable, your recommendation is taken without asking. Only owner
questions (irreversible, money, security or access, low-confidence) and
open-ended ones reach the user.

**Announce at start:** "Using kickoff to scope this task."

An approved design from earlier in this conversation is already approval.
For bounded work, use it and proceed to `test-driven-development`
(`verus-skills:test-driven-development` when installed as a plugin) without
repeating the interview. Honor the user's authorized scope throughout.

<HARD-GATE>
Do not write code, scaffold, or invoke implementation skills until the user has
approved the design (bounded, spike), or until the written spec has passed
`spec-review` (architectural).
</HARD-GATE>

## 1. Classify

Say the classification out loud before the first question:

- **Spike** — a feasibility question; output is an answer, code is throwaway.
- **Bounded** — a well-scoped change to a flow that already exists in this repo.
- **Architectural** — new project, new subsystem, or changed interfaces. Full process.

When in doubt, take the heavier path. Hidden complexity found later upgrades the path; say so.

## 2. Explore context (facts are your job)

Before asking anything, read: repo layout, docs, recent commits, existing specs in
`docs/specs/`. Any question that a file or command can answer is never asked;
dispatch an explorer subagent for broad lookups — Claude Code: `subagent_type` = `verus-explorer` (`verus-skills:verus-explorer` when installed as a plugin), unnamed, in the background, no `model` parameter. For Codex, follow [the runtime adapter](../../references/runtime.md): prepend the matching role body to the task prompt and dispatch in fresh context with the native subagent tool. Keep asking
the rest of the frontier meanwhile.

## 3. The decision tree

Model the design as a tree: every decision branches into the decisions that hang
off it. The **frontier** is every decision whose prerequisites are settled.

Work in **rounds**. Each round:

1. List the frontier. A question that depends on another open question waits for the next round.
2. For each frontier question write 2–6 options with one-line trade-offs and your recommendation.
3. Sort each question. An **owner question** is asked, never judged: its answer is irreversible or expensive to undo once shipped (deleting or migrating data, a public API, schema, file format or published name others will depend on), it costs money (a paid service, new infrastructure, licences), it touches security or access (credentials, permissions, secrets, who can reach what), or your recommendation is low-confidence — you cannot name the repo fact or user rule that decides it. Everything else is a **routine question** and is never asked: naming, defaults, minor options, taste in internal details, and design choices that a later commit can reverse. The user's rule: they pick the recommended option anyway.
4. Run every routine question through the judge (open-ended questions with no sensible options are asked directly) — read `judge.md` in this skill's directory and follow it exactly. Build `context` as a structured object, not prose: `goal` (one sentence), `decisions` (everything settled in earlier rounds), `facts` (repo evidence with file paths and short excerpts), `constraints` (the user's rules), `consequences` (one entry per option id, each naming what concretely happens or breaks — file, behaviour, test — if that option is chosen; equal specificity and length for every id, no comparative or preference language; a map detailed only for some options is a defect, rewrite the question before judging). Your recommendation goes in `recommended` and is never part of `context` — the judge must not see your pick.
5. Accepted questions: print their decision blocks, add them to the running **Decisions** list (question, options with percentages, choice, confidence, sufficiency).
6. Unaccepted routine questions, and routine questions the judge could not answer: take your recommendation without asking. Print each decision block — when the judge was unavailable, the question in the format below with the line `TypeSafe judge unavailable: <stderr line>` in place of the judge's block — followed by `➡️ Recommended: <id>, because <reason>`, and add it to the **Decisions** list marked `recommended`. Never re-run a question to get it accepted. Owner questions and open-ended ones are asked all in one message, numbered, each with its options, your recommendation and the reason it is the user's call (`irreversible`, `money`, `security/access`, `low confidence`); wait for the answers.
7. Recompute the frontier and repeat. The interview ends when the frontier is empty.

Format for questions shown to the user:

```
❓ **Q1 — <title>**: <question body>
<decision block from the judge, if any>
  A. <option> — <trade-off>
  B. <option> — <trade-off>
➡️ Recommended: A, because <reason>
```

Open-ended questions (no sensible options) are asked directly, one per message, and never judged.

## 4. Paths

**Spike:** frame the question and the probe in 2–3 sentences, get a nod, investigate as cheaply as correctness allows, report a recommendation. Anything built is labeled throwaway. Stop.

**Bounded:** after the tree is settled, present a short design in chat (approach, files touched, how to test) plus the Decisions list. STOP and wait for an explicit yes. Then hand off to `test-driven-development` (`verus-skills:test-driven-development` when installed as a plugin) for the change itself; no plan document.

**Architectural:** after the tree is settled:

1. Propose 2–3 approaches with trade-offs and a recommendation (this is itself a judge-able question).
2. Draft the design in sections (architecture, components, data flow, error handling, testing) straight through, without stopping between them: do not ask whether a section is right, do not wait for a nod, do not print the sections for approval one by one. Checking the design is the job of the external Codex review in `spec-review`; the user is asked to approve the reviewed spec only when that review does not come back clear. A gap you find while drafting is a new frontier question — run it through the tree (section 3), not through a "does this look right?" check-in.
3. Write the spec to `docs/specs/YYYY-MM-DD-<topic>-design.md` with these sections: Goal, Non-goals, Design (the drafted sections), Testing, **Decisions** (every decision block, auto-accepted ones marked `auto`, ones that fell back to your recommendation marked `recommended`, user-answered ones marked `user`).
4. Self-review the spec: no placeholders, no contradictions, one interpretation per requirement, scoped for a single plan. Fix inline.
5. Commit the spec. Tell the user: "Spec written and committed to `<path>`. Sending it to an external review; if it comes back clear I go straight on to the plan."
6. Invoke `spec-review` (`verus-skills:spec-review` when installed as a plugin) with the spec path. It revises the spec and hands off to the plan — on its own when the review is clear, after the user's approval when it is not. Invoke nothing else.

## 5. Reporting decisions

Every time the judge accepts an answer, or an unaccepted one falls back to your
recommendation, the user must see it in chat immediately, as the `block` from the judge. Never summarize several accepted decisions into
one line. The Decisions section of the spec is the durable copy.

## Red flags

| Thought | Reality |
|---|---|
| "This question is obvious, skip the judge" | Obvious questions are exactly what the judge is for. Run it. |
| "The judge said just below the threshold, close enough" | Below threshold is not `auto`: record it as `recommended`, print the block. No rounding. |
| "The judge is down, I'd better ask the user" | Routine question: take the recommendation, print it with `TypeSafe judge unavailable`, record it `recommended`. Only owner questions are asked. |
| "Naming and defaults are the user's taste, I'll ask" | They are routine. The user picks the recommendation anyway: take it, print the block. |
| "The judge would accept this security choice" | Owner questions are never judged. Ask. |
| "Routine, so no need to print it" | Every decision is printed and recorded, routine ones included. |
| "Jev is 0.99 sure of another option, I'll switch my recommendation" | Then nothing independent agreed. Keep your pick, record it as `recommended`; both picks are in the block. |
| "Jev disagreed, I'd better ask the user" | The user's rule: take the recommendation, print the block, keep going. |
| "Too simple to need approval" | Simple means a short design, not no design. |
| "I'll show this design section and ask before the next one" | Architectural designs are drafted straight through; the Codex spec review checks them and the user approves once, after it. |
| "I'll batch the accepted decisions later" | Print each block as it happens. |
