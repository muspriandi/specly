# 03 · Screen-by-screen recommendations

## Global header ([views/partials/head.ejs](../../views/partials/head.ejs))
**Now:** logo · search · Home · 5 admin links · "Sign out (Name)".
**Proposed:**
```
[Specly]  [ Search ⌘K ........... ]        APIs   Admin ▾   (3)  [AB ▾]
                                                  ├ Blueprints
                                                  ├ Users
                                                  ├ Invites
                                                  ├ Requests  (3)
                                                  └ Audit log
                                                              user menu: name/email, theme, Sign out
```
- Group admin links under one "Admin" menu (or a left sub-nav on `/manage/*` pages), cutting the top bar to ~4 items.
- `aria-current="page"` styling for the active link.
- Pending-requests count badge (A6) from a cheap `COUNT(*)` in the existing locals middleware.
- User menu shows name + email + role, with Sign out inside. Header no longer breaks on long names.
- `⌘K / Ctrl+K` focuses search; `/` too when not typing.
- Add skip link: `<a href="#main" class="sr-only focus:not-sr-only">Skip to content</a>`.

## Login / forgot / reset / accept-invite
- Centre vertically, add the wordmark + one-line value statement ("Your team's API docs, in one place").
- Show/hide password; live rule hints ("8+ characters") on set-password screens; match-check on confirm field.
- Field-level errors with `aria-describedby`; focus first invalid field.
- Submit button: `aria-busy` + "Signing in…".
- Dev-login banner: amber, with a ⚠ and "development only".
- After "Send reset link", show the check-mail state with a "Resend in 60 s" affordance (UI only).

## Home ([views/home.ejs](../../views/home.ejs), [bp-card.ejs](../../views/partials/bp-card.ejs))
- Header row: title, count, **filter chips** (All · My access · Locked), sort select (Name / Updated), and a view toggle if lists grow.
- Card: put title as the full-card link (stretched link), a lock **icon** with text "Access required", `updated 3 days ago`, endpoint count with method mini-bar (e.g. 6 GET · 3 POST).
- Locked cards: replace the inline input + button with a single **Request access** button opening a small dialog (message field, Send). Keeps the grid tidy and fixes H2.
- Pending state: show date requested; Rejected: show the reason if the model has one, plus "Request again".
- Admin empty state: illustration/icon, "Add your first blueprint", button. Guest empty state: "No APIs are shared with you yet".

## Search ([views/search.ejs](../../views/search.ejs))
- Add table header (Method · Path · Summary · API); make rows fully clickable.
- Highlight the matched substring with `<mark>`.
- Group endpoint results by blueprint with a count, collapsed after 5 ("Show 12 more").
- Empty query: show recent searches (localStorage) and example chips (`/tasks`, `POST`).
- No results: suggest clearing filters or checking spelling; show the query.
- Optional: results-as-you-type dropdown in the header search (top 5), `Enter` for full page.

## Viewer ([public/postman-view.js](../../public/postman-view.js), [views/viewer.ejs](../../views/viewer.ejs))
This is the product's core; most value is here.

1. **Layout/responsive (W2).** Under `lg`: collapse the sidebar into a "Requests ▾" button opening a drawer; under `xl`: show examples as a tabbed block (`Details | Example`) beneath the URL bar, rather than dropping/stacking them.
2. **Sidebar.** Method pill instead of coloured text for scanability; folder expand/collapse state remembered; "Collapse all"; filter keeps folder state; `scrollIntoView({block:'nearest'})` on active item; show result count while filtering; `/` focuses the filter.
3. **Request header.** Breadcrumb `Folder / Name`, method pill, the full URL with a **copy** button, server selector as a labelled control ("Server") rather than a bare select.
4. **Authorization** as a small card with a lock icon and scheme name, not a sentence.
5. **Schema tables.** Request-body and response schemas rendered as expandable field tables (name, type, required, description, enum, default) beneath the example. Reuses `keyCell`.
6. **Responses.** Make the table row selection visible (selected row tint + `aria-pressed`), colour status by class (2xx/4xx/5xx) with an icon not colour alone.
7. **Right pane.** Pin language tabs (cURL · JS · Python · …) instead of a select, one click vs two; "Copied" toast; line-wrap toggle; response headers if documented.
8. **Anchor links.** Heading hover shows a `#` copy-link; fix W8 so selecting a response code doesn't scroll.
9. **Overview.** Replace the duplicate request table with folder cards (name, description, count, method mix); keep "Base URL" with copy.
10. **Loading / error.** Skeleton for sidebar + content; error card with *Retry* and a link back to Home.
11. **View toggle.** Make "Collection / Swagger UI" a two-option segmented control with the current one selected.
12. **Print / share.** Optional "Copy link" and print stylesheet that hides sidebars.

## Admin
Shared patterns first, then screens.

- Left sub-nav or tabs on all `/manage/*` pages + page header with title, short description, primary action right-aligned. Breadcrumbs on nested pages.
- **Tables:** sortable headers, client-side filter input, pagination (25/page) for Users and Audit; sticky header; row hover.
- **Row actions:** collapse "History · Edit · Delete" into an overflow menu on narrow screens; keep Delete visually separated and red.
- **Feedback:** toast after actions; for Approve/Reject, animate the row out and show "Approved · Undo" for 5 s if feasible, else toast only.
- **Confirm dialog** naming the target (A2).

Screen specifics:
- **Blueprints:** show validation summary after upload ("OpenAPI 3.0.3 · 14 endpoints · 3 folders") and a diff summary vs previous version (added/removed endpoints). Form: Upload / Paste **tabs**; drag-and-drop zone; syntax-highlighted/line-numbered editor optional.
- **Versions:** timeline list with note, author, date, and "View" / "Download" actions.
- **Users:** Status as badge (Active green / Disabled grey, dimmed row); role help text as a tooltip or inline legend above the table; role `<select>` with one-line description beneath.
- **Invites:** chip input for emails (paste a list → chips, invalid ones flagged) replacing the textarea; result card uses icons plus text, not just colour.
- **Requests:** two tabs (Pending (n) / History), message shown in full on expand, bulk-approve checkbox column.
- **Audit:** filters (actor, action, date range), monospace diff/details in a collapsible row, CSV export.
