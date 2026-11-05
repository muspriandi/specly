# 02 · Design system recommendations

Goal: one accent, one set of semantic colours, every component with all states. Implement in [src/input.css](../../src/input.css) using Tailwind v4 `@theme` tokens so views and `postman-view.js` share them.

## Tokens

```css
@theme {
  --color-brand-50:  oklch(0.97 0.02 275);
  --color-brand-600: oklch(0.51 0.23 277);   /* current indigo-600 */
  --color-brand-500: oklch(0.58 0.21 277);
  --color-brand-400: oklch(0.68 0.17 277);

  /* HTTP methods: ONE source of truth */
  --color-m-get:    #16a34a;
  --color-m-post:   #2563eb;
  --color-m-put:    #d97706;
  --color-m-patch:  #7c3aed;
  --color-m-delete: #dc2626;

  /* Semantic */
  --color-ok: #16a34a; --color-warn: #d97706; --color-bad: #dc2626; --color-info: var(--color-brand-600);
}
```

**Decision:** drop orange from the viewer; use the brand colour for links/active states. Orange then carries no meaning and "warn" is amber only.

**Method colours:** adopt the REST-convention palette above (GET green, POST blue, PUT amber, PATCH violet, DELETE red) everywhere, and generate classes (`.m-get`, `.m-post`…) so `method.ejs` and `postman-view.js` both use them instead of two lookup tables.

## Typography
- Keep system sans; set `font-feature-settings: "cv11", "ss01"` only if you adopt Inter. Not required.
- Scale: page title `text-2xl/semibold`, section `text-lg`, label/meta `text-xs uppercase tracking-wide` (already the `th` style; reuse as `.eyebrow`).
- Monospace for paths, keys, codes: already done; keep `tabular-nums` on counts and dates.

## Spacing & layout
- Container: `max-w-6xl` for content pages, `max-w-7xl` for the viewer (already). Add `px-4 sm:px-6`.
- 4-pt rhythm: cards `p-5`, table cells `px-4 py-3`, section gaps `mt-8`.

## Components to add or fix

| Component | Change |
|---|---|
| `.badge` | Variants `.badge-ok/-warn/-bad/-info/-neutral` with light + dark colours; remove inline colour classes in views. |
| `.btn` | Add `-secondary`, `-danger`, `disabled:opacity-50`, and `[aria-busy=true]` spinner. Min height 36 px (44 px on touch). |
| `.field` | Add `.field-error` (red border + ring) and helper-text slot (`.hint`, `.error-text`). |
| Nav link | `.nav-link` + `[aria-current=page]` style (brand colour, bottom border or pill). |
| Empty state | `.empty` block: icon, one sentence, primary action. Use on Home, Blueprints, Requests, Invites, Search. |
| Toast | Small `role=status` region at bottom-right for "Saved", "Copied", "Request approved"; replaces top flash for action feedback. |
| Dialog | Replace `window.confirm` with `<dialog>`: title names the target ("Delete *Task API*?"), consequence text, red confirm button. Still driven by `data-confirm` so no view changes. |
| Skeleton | `animate-pulse` placeholders for viewer load and card grid. |
| Icon set | Inline SVG sprite (lock, search, copy, check, chevron, external, user). Removes emoji reliance. |
| Table | `.table` wrapper: sticky header, hover row, `scope=col` on `th`, caption (sr-only). |

## Dark mode
- Replace per-view `border-emerald-500 text-emerald-600` with semantic classes that carry `dark:` pairs once.
- Code panes (`#212121`) are always dark; keep, but ensure the surrounding card header matches (`#2b2b2b`), which it does.
- Respect `prefers-color-scheme` (current) **and** add a manual toggle in the user menu (store in localStorage, apply `class="dark"` before paint to avoid flash).
