# 01 · Audit

## What works well
- Consistent `card`/`field`/`btn`/`badge` component layer in [src/input.css](../../src/input.css).
- Dark mode throughout, including code panes.
- Viewer: three-pane layout (folders → request → example) is familiar to anyone who has used Postman/Stoplight; hash-based deep links; language choice persisted.
- Search form is available on every page; access-request flow is inline on the card.
- Destructive actions are confirmed (`data-confirm`).

## Findings

Severity: **H** blocks or misleads users · **M** friction · **L** polish.

### Visual consistency
| # | Sev | Finding | Where |
|---|---|---|---|
| V1 | M | Two accent colours: indigo (app chrome, buttons) vs orange (viewer links, active sidebar item, markdown links). Feels like two products. | `postman-view.js`, `.md a` in input.css |
| V2 | M | Three method palettes: `partials/method.ejs` (solid blue GET / green POST / amber PUT), viewer text colours (green GET / amber POST / blue PUT). **GET is blue on search results and green in the viewer.** Same verb, different colour. | `method.ejs`, `postman-view.js` METHOD_COLOR |
| V3 | L | Brand wordmark is plain text; no favicon/logo; login card is a bare white box on grey. | `head.ejs`, `login.ejs` |
| V4 | L | Badge colours are hard-coded per view (`border-emerald-500 text-emerald-600`) with no dark variants → low contrast on dark. | `users.ejs`, `requests.ejs`, `bp-card.ejs` |
| V5 | L | Emoji 🔒 used as the locked indicator; renders differently per OS and has only a `title` for meaning. | `bp-card.ejs` |

### Navigation & orientation
| # | Sev | Finding |
|---|---|---|
| N1 | H | Admin sees 9 flat links + sign-out in one wrapping row; on tablet widths it wraps to two lines and pushes content down. Admin and reader tasks are mixed. |
| N2 | M | No active-page state in the nav (`Home`, `Users`… all look identical). |
| N3 | M | No breadcrumbs on admin sub-pages (versions, edit forms); user relies on "Cancel" links. |
| N4 | M | Sign-out button reads "Sign out (Full Name)" and doubles as the identity display; long names break the header. |
| N5 | L | Viewer has two "back" affordances (nav Home + "← All APIs"). Fine, but the view switch ("Collection view / Swagger UI view") reads as a link, not a toggle. |

### Viewer (core product)
| # | Sev | Finding |
|---|---|---|
| W1 | H | **Sidebar filter only searches loaded operations by name/path/method and has no keyboard shortcut**; users of a 100-endpoint API must scroll. |
| W2 | H | **Mobile/tablet:** below `lg` the sidebar stacks above the content, so a reader scrolls past the whole endpoint list before seeing the request. Right pane (examples) only appears at `xl`; below that the examples are not rendered *anywhere* in the layout beyond being stacked after — verify. |
| W3 | M | "Loading documentation…" is plain text; failures show a red box with no retry. No skeleton. |
| W4 | M | Response status codes in the table are buttons that change the right pane, but nothing indicates they're interactive (no hover affordance beyond underline, no selected state in the table). |
| W5 | M | Request page lacks a copy button for the full URL and the path; the URL bar is read-only text. |
| W6 | M | Body schema is shown only as an example; no field-level table (type, required, description) like params get. |
| W7 | M | Sidebar `<details>` always `open`; no collapse-all, and open state resets on every filter keystroke. |
| W8 | L | Scroll jumps to top on every hash change, including when only the right pane state changes. |
| W9 | L | Active sidebar item isn't scrolled into view after deep-link load. |
| W10 | L | Overview "Requests" table repeats the sidebar; could show per-folder counts/descriptions instead. |

### Home, search, cards
| # | Sev | Finding |
|---|---|---|
| H1 | M | Home has no sort/filter, no "recently viewed". Fine at 5 blueprints, poor at 50. |
| H2 | M | Locked cards put the request form inline with a free-text field and button squeezed in one row; at 320 px the input is ~120 px wide. |
| H3 | M | Search page: results are not grouped/highlighted; no match highlighting; empty-query page shows instructions only. Endpoint table has no header row. |
| H4 | L | Description is regex-stripped markdown, truncated at 220 chars server-side *and* `line-clamp-3` client-side. |

### Forms & auth
| # | Sev | Finding |
|---|---|---|
| F1 | M | No show/hide password toggle; no password rules shown on accept-invite/reset until the server rejects. |
| F2 | M | Errors are one banner at the top; fields aren't marked invalid (`aria-invalid`, red border) and focus isn't moved. |
| F3 | M | Blueprint form: file input and paste textarea are both visible; "uploaded file wins" is explained in small print *after* the textarea. Should be tabs: Upload / Paste. No client-side validation preview (title/version/endpoints detected). |
| F4 | L | Submit buttons never show a busy state → double submits on slow SMTP/DB. |
| F5 | L | Dev-login banner ("admin / admin") is styled as a normal info alert; make it visibly a dev-only warning. |

### Admin
| # | Sev | Finding |
|---|---|---|
| A1 | M | Success of admin actions only appears as a flash at the top of the next page; after approving a request the row disappears with no inline confirmation or undo. |
| A2 | M | Native `confirm()` for destructive actions: not themable, names no target ("Delete this user?"). |
| A3 | M | Tables have no sorting, pagination or filtering (audit log especially). |
| A4 | L | Users "Status" is plain text; disabled users look identical to active ones. |
| A5 | L | Role explanation sits under the table, away from the Role column and the form where it's needed. |
| A6 | L | Pending-request count isn't surfaced in the nav → admins must visit Requests to discover work. |
