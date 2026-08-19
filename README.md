# Statiq Assessments

The candidate-facing assessment app. Candidates log in with a Gmail magic
link, complete role-specific tasks, and submit — timestamps and answers
flow automatically to the People Team via Notion and Slack.

Full plan and design decisions: see the **Specs** page in the "Assessment
App" section of the Statiq Notion (People Team Hub).

## What lives where

This repo holds interface code only — no candidate data. See the Specs
page, section 4 ("What lives where"), for the full breakdown. Short
version:

- **This repo (GitHub Pages)** — the app's interface, safe to redeploy
  anytime
- **Firebase** — magic-link login, and live in-progress state while a
  candidate is actively working (autosave)
- **Notion** — `Assessment_Access` (who can log in), `Assessment_Roles`
  (task instructions), `Assessment_Submissions` (finished work)
- **Cloudflare Worker** — the only thing allowed to talk to Notion's API
  directly, since the app itself can't hold that secret safely

## Status

Early scaffolding — not yet functional. Currently wiring: Firebase auth,
Firestore rules, and the real Notion-backed login flow (replacing the
prototype's fake data).

## Local development

Nothing to install yet — this is a static site. Once the app shell is in
place, open `index.html` directly or serve the folder with any static
server.
