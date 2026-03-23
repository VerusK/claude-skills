# Accessibility (a11y) Review

Review frontend code for accessibility issues. Apply only to UI code (JSX, TSX, HTML, CSS, Vue, Svelte).

## Semantic HTML

- Proper heading hierarchy (h1 > h2 > h3), one h1 per page
- Landmarks used (main, nav, aside, footer)
- Buttons for actions, links for navigation (not div/span)
- Form inputs have associated labels, fieldsets for grouped inputs
- Lists use ul/ol/dl, tables have headers (th) with scope

## Keyboard Navigation

- All interactive elements focusable, logical tab order
- Focus visible on all elements, no focus traps (except modals)
- Enter/Space activate buttons, Escape closes modals/popups
- Skip links provided, no mouse-only interactions
- Touch targets large enough (44x44px)

## ARIA

- aria-label for icon buttons, aria-labelledby for sections
- aria-describedby for instructions, aria-hidden for decorative content
- Correct roles for custom widgets (role="button", "alert", "dialog")
- States managed: aria-expanded, aria-selected, aria-checked, aria-disabled
- aria-live for dynamic content with appropriate politeness level

## Visual Design

- Text contrast >= 4.5:1 (normal), >= 3:1 (large text and UI elements)
- Color not sole indicator of state (errors have text/icon too)
- Text resizable to 200% without breaking layout
- prefers-reduced-motion respected, no flashing content (> 3/sec)

## Forms

- All inputs have visible labels, required fields indicated
- Error messages clear, associated with inputs, summary at form top
- Focus moves to error on submit
- Autocomplete attributes set, appropriate input types (email, tel)

## Images & Media

- Alt text for informative images, alt="" for decorative
- Complex images have long description
- Video has captions, transcripts available

## Critical Patterns

```
Issue: Missing form label
Bad:  <input type="text" placeholder="Email">
Fix:  <label for="email">Email</label><input id="email" type="text">

Issue: Non-focusable interactive element
Bad:  <div onclick="submit()">Submit</div>
Fix:  <button onclick="submit()">Submit</button>

Issue: Color-only error indication
Bad:  <span style="color: red">Error</span>
Fix:  <span role="alert">Error: Required field</span>

Issue: Missing alt text
Bad:  <img src="chart.png">
Fix:  <img src="chart.png" alt="Sales chart showing 20% growth">
```

## What to Report

For each issue:
- Location: file path and line number
- Issue: clear description
- Impact: which users are affected and how
- Fix: specific suggestion
- Severity: critical / warning / suggestion

Report problems only - no positive observations.
