---
name: kickoff
description: Entry point for any new task. Classifies the task (spike / bounded / architectural), interviews the user through a decision tree with multiple-choice questions, auto-answers questions via the TypeSafe judge when confidence is high, and ends with a spec in docs/specs/. Use when starting a task, "let's build", "kickoff", "brainstorm", "grill me", or before writing any plan.
---

# Kickoff

Turn an idea into a spec through a decision-tree interview. Questions with
concrete options are judged by TypeSafe first; only low-confidence questions
reach the user.

**Announce at start:** "Using kickoff to scope this task."

<HARD-GATE>
Do not write code, scaffold, or invoke implementation skills until the user has
approved the design (bounded, spike) or the written spec (architectural).
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
dispatch an unnamed Explore subagent (`model: opus`, background) for broad lookups and keep asking
the rest of the frontier meanwhile.

## 3. The decision tree

Model the design as a tree: every decision branches into the decisions that hang
off it. The **frontier** is every decision whose prerequisites are settled.

Work in **rounds**. Each round:

1. List the frontier. A question that depends on another open question waits for the next round.
2. For each frontier question write 2–4 options with one-line trade-offs and your recommendation.
3. Run every question through the judge — read `judge.md` in this skill's directory and follow it exactly.
4. Accepted questions: print their decision blocks, add them to the running **Decisions** list (question, options with percentages, choice, confidence).
5. Unaccepted questions: ask them all in one message, numbered, each with its decision block, options and your recommendation. Wait for the answers.
6. Recompute the frontier and repeat. The interview ends when the frontier is empty.

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

**Bounded:** after the tree is settled, present a short design in chat (approach, files touched, how to test) plus the Decisions list. STOP and wait for an explicit yes. Then hand off to `test-driven-development` for the change itself; no plan document.

**Architectural:** after the tree is settled:

1. Propose 2–3 approaches with trade-offs and a recommendation (this is itself a judge-able question).
2. Present the design in sections (architecture, components, data flow, error handling, testing). Ask after each section whether it is right.
3. Write the spec to `docs/specs/YYYY-MM-DD-<topic>-design.md` with these sections: Goal, Non-goals, Design (the approved sections), Testing, **Decisions** (every decision block, auto-accepted ones marked `auto`, user-answered ones marked `user`).
4. Self-review the spec: no placeholders, no contradictions, one interpretation per requirement, scoped for a single plan. Fix inline.
5. Commit the spec. Tell the user: "Spec written and committed to `<path>`. Review it; when approved I will write the plan with `writing-plans`."
6. On approval invoke `writing-plans`. Invoke nothing else.

## 5. Reporting decisions

Every time the judge accepts an answer, the user must see it in chat immediately,
as the `block` from the judge. Never summarize several accepted decisions into
one line. The Decisions section of the spec is the durable copy.

## Red flags

| Thought | Reality |
|---|---|
| "This question is obvious, skip the judge" | Obvious questions are exactly what the judge is for. Run it. |
| "The judge said 0.69, close enough" | Below threshold means ask. No rounding. |
| "The judge is down, I'll pick my recommendation" | Judge down means ask the user. Always. |
| "Too simple to need approval" | Simple means a short design, not no design. |
| "I'll batch the accepted decisions later" | Print each block as it happens. |
