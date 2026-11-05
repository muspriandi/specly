# 04 · Accessibility checklist

Target: WCAG 2.2 AA.

## Quick wins
- [ ] **Skip link** and `<main id="main">` target ([head.ejs](../../views/partials/head.ejs)).
- [ ] **Focus visibility:** several controls use `focus:outline-none` + a 50 % alpha ring (`.btn`). Use `focus-visible:ring-2 ring-offset-2` with full-opacity brand colour.
- [ ] **Contrast:** `text-slate-500` on `bg-slate-50`/white is ~4.6:1 (borderline); on `slate-900` dark cards is lower. Use `slate-600` / `slate-400` for body-level meta text. Check the badge colours in dark mode (V4) and the viewer's `text-[#0a9d4a]`, `text-[#c98a00]` on white (amber fails 4.5:1).
- [ ] **Colour is not the only signal:** method, status code and Active/Disabled rely on colour; text is present for methods/codes, but add icon/word for user status and request decisions.
- [ ] **Emoji lock** → SVG with `role="img" aria-label="Access required"`.
- [ ] **Forms:** `aria-invalid`, `aria-describedby` for error and hint text, `autocomplete` tokens (present on some; add on forgot/reset), error summary receives focus.
- [ ] **Tables:** `<th scope="col">`, visually hidden `<caption>`; search results table gets a header row.
- [ ] **Icon-only or ambiguous buttons:** copy buttons need `aria-label="Copy request"`; announce "Copied" via `aria-live="polite"`.

## Viewer
- Build DOM with proper landmarks: sidebar `<nav aria-label="Requests">`, content `<main>`/`<section aria-labelledby>`, examples `<aside aria-label="Example">`. Currently `<aside>` is used for the sidebar too.
- Sidebar items: mark current with `aria-current="page"`.
- Response code buttons: `aria-pressed` for the selected one.
- Language/status `<select>`s have `aria-label` already; keep. If converted to tabs, use `role="tablist"` with arrow-key navigation.
- Code blocks: `tabindex="0"` so keyboard users can scroll overflowing `<pre>`.
- After `hashchange`, move focus to the `<h1>` (`tabindex="-1"`) and update `document.title`; otherwise screen-reader users get no feedback on navigation.
- Respect `prefers-reduced-motion` for skeleton/animation.

## Dialogs and menus
- Use native `<dialog>` (`showModal()`): focus trap, `Esc`, returns focus. Label with `aria-labelledby`.
- User/Admin dropdown: button with `aria-expanded`, `aria-controls`; close on `Esc`/outside click.

## Touch
- Minimum 40–44 px targets: sidebar rows (`py-1.5` ≈ 32 px) and `btn-sm` (≈ 28 px) fall short on mobile; raise at `max-sm`.

## Testing
- Run axe DevTools / Lighthouse on: login, home, viewer (an endpoint with body), admin users.
- Keyboard-only pass: tab order across header → sidebar → content → examples.
- Zoom to 200 % and 320 px width; no horizontal page scroll (tables scroll within their own container, already the case).
- Screen reader smoke test (VoiceOver): login error, request access, viewer navigation.
