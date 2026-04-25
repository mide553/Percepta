# Percepta — Perceptual UI Auditor

Percepta analyses live websites for perceptual and optical design issues that standard DOM-based tools can't detect. Paste a URL, run an audit, and get structured findings with plain-language explanations and design book references.

---

## What it does

Percepta uses Puppeteer to open a live page in a headless browser, extracts every visible element's computed styles and geometry, and runs a rule-based analysis engine across 30+ perceptual checks. An optional Gemini AI layer rewrites the findings in plain language and enriches them with relevant design knowledge and illustrative book images.

**Checks include:**

- **Readability** — APCA-based text contrast per size tier; harsh all-max contrast; tiny text
- **Visual Weight** — quadrant density balance; left/right and top/bottom imbalance; diagonal axis
- **Visual Hierarchy** — heading size progression; font-weight range; focal-point dominance
- **Typography** — line length (too narrow / too wide); font-family proliferation; leading/letter-spacing
- **Colour Palette** — hue diversity; tonal range; simultaneous contrast; colour temperature shifts; grey tinting
- **Spacing & Layout** — overcrowded grid zones; inconsistent vertical gaps; edge margins; containment paradox
- **Interactive Targets** — touch target size (≥ 32 × 32 px); adjacent target separation; ghost buttons; CTA clustering
- **Icon & Image Size** — images and SVG icons below minimum recognisable size
- **Layout Order** — column alignment; grid fragmentation; centred/right-aligned body text
- **Heading Structure** — missing H1; skipped levels; heading proximity to content; excessive levels
- **Elevation Consistency** — shadow vs. z-index mismatches; upward light direction
- Cookie/GDPR popup dismissal before screenshot so results reflect the actual UI

---

## Tech stack

- [SvelteKit](https://kit.svelte.dev/) (Svelte 5, `$state` / `$derived` reactivity)
- [Puppeteer](https://pptr.dev/) — headless Chromium for screenshots and DOM extraction
- [Gemini 2.5 Flash](https://ai.google.dev/) — AI prose rewriting and image selection (optional)
- Vite, plain CSS custom properties for theming

---

## Getting started

### Prerequisites

- Node.js 18 or later
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (free tier is sufficient)

### Setup

```bash
# 1. Clone the repo
git clone <repo-url>
cd percepta/app

# 2. Install dependencies
#    (Puppeteer downloads Chromium automatically — takes a minute on first install)
npm install

# 3. Configure environment
cp .env.example .env
# Open .env and set your key:
#   GEMINI_API_KEY=your-gemini-key-here

# 4. Start the dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

### Build for production

```bash
npm run build
npm run preview
```

---

## Project structure

```
src/
  routes/
    +page.svelte          # Main UI
    api/analyse/
      +server.js          # Puppeteer + Gemini API route
  lib/
    analysis/
      algorithmic.js      # Rule-based perceptual analysis engine
    ai/
      prompt.js           # Gemini system prompts
      bookImages.js       # Design book image catalog
      bookKnowledge.js    # Design knowledge excerpts per category
    ui/
      constants.js        # Category colours, severity labels, loading steps
static/                   # Background SVGs, favicon
```

---

## Modes

| Mode | Description |
|---|---|
| **Algorithmic** | Algorithmic findings rewritten in plain language by Gemini, with book image references |
| **AI Vision** | *(coming soon)* Screenshot sent directly to Gemini for vision-based analysis |

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes (for AI modes) | Google Gemini API key |


## App UI

[UI](app/static/percepta.jpg)