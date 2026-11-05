# Specly UI/UX Review

Written for: the Specly maintainers (developers who will implement the changes).

Review of the current UI (Tailwind v4 + EJS + a vanilla-JS "Postman-style" viewer). Findings are based on reading the views, `src/input.css`, and `public/postman-view.js`; nothing was run in a browser, so verify visual claims on screen.

| File | Contents |
|---|---|
| [01-audit.md](01-audit.md) | What works, and the problems found, by severity |
| [02-design-system.md](02-design-system.md) | Tokens, components, and states to standardise |
| [03-screen-recommendations.md](03-screen-recommendations.md) | Per-screen changes (home, viewer, search, auth, admin) |
| [04-accessibility.md](04-accessibility.md) | A11y checklist and fixes |
| [05-roadmap.md](05-roadmap.md) | Prioritised, sized implementation plan |

## Summary

The foundation is good: clean Tailwind component layer, dark mode, a three-pane viewer, localStorage for language preference. The weak spots are **inconsistency** (indigo for the app, orange for the viewer, three different method-colour palettes), **navigation** (a 9-item flat top bar, no active state, no breadcrumbs), **the viewer's discoverability** (no in-page search, no copy for path/URL, no auth/schema display) and **admin ergonomics** (no empty-state actions, no feedback after destructive/inline actions, unlabeled status).
