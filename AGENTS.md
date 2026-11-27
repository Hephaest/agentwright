# AGENTS.md

Rules for editing the agentwright skills in `plugins/agentwright/skills/`. To use the skills, start from `agent-overview`.

## Skills

- **Name** — `agent-<stage>-<topic>`, lowercase with hyphens, equal to the folder name. Stages are `plan`, `build`, `host` and `harden`; add a stage only when none fits.
- **Description** — one clause for what the skill does, then when to use it, then at most one pointer to a sibling skill. Double-quoted, 250 characters or fewer.
- **Standalone** — a skill never refers to where it is stored or to a collection around it. It may name a sibling skill.
- **Vendor-neutral core** — name concepts such as "model call" and "tool result". A vendor's field name belongs in a dated "Vendor notes" block that covers at least two vendors.
- **Sourced** — every quotation and every figure attributed to a vendor or author links to its source. Mark what cannot be traced as UNVERIFIED, or remove it.
- **Honest code** — code is a sketch against a small neutral interface. Never say it is tested unless it was run.
- **Size** — a `SKILL.md` stays under 500 lines. Move lookup material to `references/` and templates to `assets/`.
- **Structure** — a lead paragraph, the main sections, then one closing section per role: a Checklist, Anti-patterns or Troubleshooting.

## Changes

- When a skill is added, renamed or removed, update the routing table in `agent-overview` and the skill table in `README.md` in the same change.
- Do not copy SDK or API documentation into a skill; it goes stale.
- On every release, set the same new `version` in `plugins/agentwright/.claude-plugin/plugin.json` and `plugins/agentwright/plugin.json`, then tag the commit `v<version>`.
- Run `claude plugin validate .` before committing.
