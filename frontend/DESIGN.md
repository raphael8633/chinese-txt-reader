---
name: Raph Reader Night Shelf
description: "Personal zh-Hant long-form TXT/web novel reader PWA. Chrome stays dark and quiet; the reading surface belongs to the user's own theme settings."
colors:
  canvas: "#000000"          # html/body/#root
  surface: "neutral-900"     # dialogs, cards
  surfaceDeep: "neutral-950" # panels, inputs
  hover: "neutral-800"
  border: "neutral-700"      # default; neutral-800 for subtle dividers
  text: "neutral-100"        # primary; neutral-300/400 secondary/meta, neutral-500 disabled hints
  primaryAction: "emerald-500 fill, neutral-950 text, hover emerald-400"
  positiveOutline: "emerald-700 border, emerald-100 text, hover bg emerald-950"
  confirmInfo: "cyan-700 border, cyan-900/40 bg, cyan-100 text, hover cyan-900/60"
  warning: "amber-700 border, amber-950 bg (alerts), amber-100 text"
  destructive: "red-700/800 border, red-900/40 or red-950 bg, red-100/200 text"
  toggleOn: "teal-500"          # ReaderSettingsPanel switch only; existing exception, do not spread
typography:
  ui: "Tailwind default sans; text-sm body, text-xs meta, text-base dialog titles (font-semibold)"
  reading: "User-controlled (fontSize, lineHeight, letterSpacing, fontWeight, colors) — never hard-code in reader view"
shape:
  radius: "rounded (4px) default; rounded-lg only for dialog shells; rounded-full only for pills/dots"
  spacing: "px-3 py-2 buttons, gap-2 rows, p-4 dialogs, p-3 alert boxes"
  touch: "min-h-11 on mobile, sm:min-h-9"
---

## Principles
- Chrome serves the text: no gradients, no glows, no decorative illustration, no shadow except dialog `shadow-xl`.
- Color carries meaning, never decoration: emerald = create/primary, cyan = confirm/info, amber = caution, red = destructive/error. Everything else is neutral.
- Outline buttons by default (`border` + transparent bg + hover tint); only the single primary action on a screen is filled.
- Copy is zh-Hant; keep English technical labels (TXT, PWA, URL) as-is.

## Components
- Dialog: `fixed inset-0 bg-black/60` backdrop → `max-w-sm rounded-lg border-neutral-700 bg-neutral-900 p-4`; Escape closes; confirm in cyan, destructive confirm in red.
- Alert banner: `role="alert" rounded border p-3` with warning or destructive palette; action buttons inside use the same hue outline.
- Panels (settings, chapters): reuse `PanelOverlay` + sticky tabs; do not create new modal patterns.

## Don't
- Don't add a new hue (indigo/violet/rose) or Tailwind theme tokens without updating this file.
- Don't use rounded-xl/2xl cards, card grids with hero headers, or "dashboard" stat tiles.
- Don't style the reading viewport with fixed colors or fonts — it must follow user settings.
