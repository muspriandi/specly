# 05 · Implementation roadmap

Sizes: S ≤ ½ day · M ≈ 1–2 days · L ≈ 3+ days. Each phase ships independently.

## Phase 1: consistency & quick wins (≈ 2 days)
| Item | Size | Addresses |
|---|---|---|
| Single brand accent; remove orange from viewer and `.md a` | S | V1 |
| Unified method colour tokens, shared by `method.ejs` and `postman-view.js` | S | V2 |
| Badge variants with dark-mode pairs | S | V4 |
| Nav `aria-current` styling, skip link, focus-visible rings | S | N2, a11y |
| Table headers on search; `scope`/captions | S | H3 |
| SVG lock icon replacing emoji | S | V5 |
| Busy state on submit buttons (small JS in `app.js`) | S | F4 |
| Password show/hide + rule hint | S | F1 |

## Phase 2: navigation & feedback (≈ 4 days)
| Item | Size | Addresses |
|---|---|---|
| Header redesign: Admin menu, user menu, pending-count badge | M | N1, N4, A6 |
| Toast component and copy-feedback | S | A1 |
| `<dialog>` confirm replacing `window.confirm` (keep `data-confirm`) | M | A2 |
| Empty states with actions | S | A-series |
| Field-level validation styling and error focus | M | F2 |
| Request-access dialog on locked cards | M | H2 |

## Phase 3: viewer upgrade (≈ 1–2 weeks, the highest-value phase)
| Item | Size | Addresses |
|---|---|---|
| Responsive layout: sidebar drawer, tabbed examples below `xl` | L | W2 |
| Sidebar: method pills, remembered folder state, scroll-into-view, `/` shortcut | M | W1, W7, W9 |
| URL copy button, labelled server select, language tabs | M | W5 |
| Schema field tables for body/response | L | W6 |
| Selected-state for response rows; no scroll jump on pane updates | S | W4, W8 |
| Skeleton + retry error state | S | W3 |
| Focus management and title update on route change | S | a11y |
| Overview folder cards | M | W10 |

## Phase 4: scale & admin polish (≈ 1 week)
| Item | Size |
|---|---|
| Home filter/sort chips, recent items | M |
| Global search `⌘K` with live dropdown and match highlighting | L |
| Admin tables: sort, filter, pagination (Users, Audit) | L |
| Blueprint upload tabs + validation/diff summary | M |
| Invite email chips | M |
| Theme toggle, no-flash script | S |

## Success measures
- Time to find a specific endpoint in a 100-endpoint spec (target: under 10 s using filter/search).
- Viewer usable at 375 px wide: examples reachable without leaving the page.
- Lighthouse accessibility ≥ 95 on the five key pages.
- Admin: zero native `confirm()` dialogs; every action gives visible success feedback.

## Notes / assumptions
- Changes to `postman-view.js` should keep its rule of inserting text via text nodes (the code comments cite CSP/XSS reasons); new components must follow the `h()` helper.
- Tailwind classes are discovered by scanning `public/` and `views/`; new dynamic class names must appear literally in source.
- The CSP blocks inline handlers; dialogs/menus should be wired through `public/app.js`.

## Implementation status
Done: Phases 1–3 in full, and Phase 4 including the server-backed items: type-ahead search (`GET /search/suggest`), bulk approve/reject on Requests (`POST /manage/requests/bulk`), and a dry-run validation + diff preview on the blueprint form (`POST /manage/blueprints/preview`).
Not done: Audit column sorting (the log already has server-side paging and filters, so client-side sorting would only reorder one page).
