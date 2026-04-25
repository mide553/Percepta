/**
 * Book knowledge extracted from "Refactoring UI" by Adam Wathan & Steve Schoger.
 * BOOK_KNOWLEDGE provides category-level text excerpts used to enrich the AI prompt.
 * Image selection is handled by the AI using the catalog in bookImages.js.
 */

export const BOOK_KNOWLEDGE = {
    'Readability': {
        excerpt: `Text contrast is one of the most important factors in readability. When using grey text on coloured backgrounds, reducing opacity is the wrong approach — instead, hand-pick a colour based on the background hue that achieves lower contrast naturally, so the result doesn't look washed out or dull.

Line length also has a major impact on reading comfort. For body text, aim for 45–75 characters per line (roughly 20–35 em). Lines that are too long force the eyes to travel further and make it harder to find the next line.

Line-height should be proportional to line length: longer lines need more vertical space between them (around 1.5–1.8× the font size), while short lines or large display text can sit closer together.`,
        images: ['image37.png', 'image113.jpeg', 'image122.png']
    },

    'Visual Weight': {
        excerpt: `When one area of a page feels visually heavier than another — a large image, a bold colour bar, or a dense text block — the eye is pulled there first, even if that isn't the most important content. The fix is almost never to make the lighter side bigger; it's to reduce the weight of the dominant element.

For a layout that feels lopsided because an image is too eye-catching, try lowering the image's contrast with a subtle overlay or desaturating it slightly. For a brightly coloured bar that competes with the main content, reduce its colour saturation so it no longer shouts.

When you want something to feel more prominent without changing its size, increase its contrast. When you want to de-emphasise a large or heavy element, reduce its contrast — the result is the same visual hierarchy shift without touching the layout.`,
        images: ['image42.png', 'image44.png', 'image53.png']
    },

    'Visual Hierarchy': {
        excerpt: `Visual hierarchy is about how important elements appear relative to one another. When everything competes for attention equally, the result feels noisy and chaotic. The key is to deliberately de-emphasise secondary and tertiary content so that the truly important information stands out on its own.

When you want to make something more prominent and it already can't be made larger or bolder without looking out of place, consider de-emphasising the elements competing with it instead. For buttons and actions, the primary action should be obvious, secondary actions clear but not prominent, and tertiary actions discoverable but unobtrusive.`,
        images: ['image31.png', 'image42.png', 'image58.png']
    },

    'Typography': {
        excerpt: `Most interfaces accumulate too many font sizes over time. Instead of choosing sizes ad hoc, define a type scale up front — a limited set of sizes you'll stick to. A hand-crafted scale (e.g. 12, 14, 16, 18, 20, 24, 30, 36, 48, 60, 72 px) is more practical than a mathematically derived modular scale, which produces fractional values and too few useful steps.

Letter-spacing should generally be left to the typeface designer. One exception: all-caps text often benefits from slightly increased letter-spacing (around 0.05–0.1 em) because all-caps letter sequences are less visually diverse and need extra breathing room between characters.`,
        images: ['image102.png', 'image104.jpeg', 'image137.png']
    },

    'Colour Palette': {
        excerpt: `Too few brightness levels is one of the most common palette problems. A good palette needs at least 8–10 shades per colour, covering the full range from near-white to near-black. If your design only uses 2–3 brightness levels, backgrounds, cards, borders, and text all blend together — nothing feels distinct.

Every hue has a different perceived brightness. Yellow appears much lighter than blue even at identical HSL lightness values. This means a palette of only cool hues (blues, greens, purples) will feel flat and cold. Introducing even one warm accent — a soft orange, gold, or terracotta — creates temperature contrast that makes the whole palette feel more dynamic and inviting.

Grey surfaces should not be pure neutral grey when a brand colour exists. Pure grey (#808080) looks disconnected from a blue or green primary colour. Instead, add a tiny amount of the primary hue's saturation to the greys — 5–10% saturation is often enough to make backgrounds and borders feel like they belong to the same design.`,
        images: ['image162.png', 'image171.png', 'image178.png']
    },

    'Spacing & Layout': {
        excerpt: `Start every design with more white space than you think you need, then remove it. Elements should only be given the minimum spacing they need — don't spread things out to fill available space; that only makes the design feel loose and unpolished.

Ambiguous spacing is one of the most common layout problems: when the space between two groups of elements is equal to the space within a group, it's unclear which elements belong together. The fix is to ensure the space between groups is always greater than the space within them — use the law of proximity deliberately.`,
        images: ['image63.jpeg', 'image96.jpeg', 'image97.png']
    },

    'Interactive Targets': {
        excerpt: `Interactive elements that are too close together cause accidental taps — especially on touchscreens. When two buttons or links are spaced less than 8px apart, users frequently hit the wrong one. Aim for at least 8px between adjacent targets; 12–16px for primary navigation and actions.

Small touch targets are equally problematic. Buttons and links should offer at least a 44×44px tappable area, even if the visible element is smaller. You can add invisible padding around an element to expand its tap zone without changing its visual appearance. As a button gets larger, its padding should grow proportionally — not just its width.

Spacing ambiguity compounds these problems: when the gap between two interactive groups equals the gap within a group, users can't tell which elements belong together. Always make inter-group spacing larger than intra-group spacing.`,
        images: ['image95.png', 'image97.png', 'image59.png']
    },

    'Icon & Image Size': {
        excerpt: `Most icons are designed to be used at small sizes (16–24 px). Scaling a small, detailed icon up to fill a large space doesn't look great — the icon was never meant to be displayed at that size. If large icons are needed, look for a version of the icon that was specifically drawn for larger sizes, or enclose the small icon in a shape (circle, rounded square) with a coloured background to give it visual weight without distorting it.

Avoid scaling down screenshots or interfaces — small font sizes become unreadable at a fraction of their original size. Use partial screenshots or annotated mockups instead.`,
        images: ['image232.png', 'image233.png', 'image234.png']
    },

    'Layout Order': {
        excerpt: `A 12-column grid can simplify layout decisions, but treating it as a religion leads to suboptimal designs. Not all elements should be fluid — sidebars and fixed-width components often work better with a set pixel width that never changes, rather than scaling proportionally with the viewport.

The order in which elements appear on screen should reflect their visual importance. If your layout forces users to encounter secondary information (navigation, sidebars, metadata) before the main content, consider restructuring the flow so the most important content appears first and supporting elements follow.`,
        images: ['image72.png', 'image79.png', 'image81.png']
    }
};
