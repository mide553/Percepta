/**
 * Percepta — DOM-based Perceptual Analysis Engine
 * Receives element data extracted by Puppeteer from the live page.
 *
 * Checks: text contrast (APCA), optical centering, visual focus, tonal range,
 * colour palette, text hierarchy, spacing rhythm, edge margins, vertical weight,
 * simultaneous contrast, grid alignment, colour temperature, line length,
 * grey tinting, interactive affordance, leading/line-height, font proliferation,
 * touch targets, heading hierarchy/proximity, elevation consistency, border overuse,
 * containment paradox, text on images, nav row gaps, content group separation,
 * layout column alignment.
 */

// ── Colour math ───────────────────────────────────────────────────────────────

function lin(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luma(r, g, b) {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function apcaLc(txtL, bgL) {
    const t = Math.max(0, txtL);
    const b = Math.max(0, bgL);
    return b >= t
        ? (Math.pow(b, 0.56) - Math.pow(t, 0.62)) * 1.14 * 100
        : (Math.pow(b, 0.57) - Math.pow(t, 0.56)) * 1.14 * 100;
}

function rgbToHsl(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
    return [h, s, l];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let _id = 0;
function nid() { return `F${String(++_id).padStart(3, '0')}`; }

function zoneDesc(x, y, vpW, vpH) {
    const h = x < vpW * 0.33 ? 'left' : x < vpW * 0.67 ? 'centre' : 'right';
    const v = y < vpH * 0.33 ? 'top' : y < vpH * 0.67 ? 'middle' : 'bottom';
    return `${v}-${h}`;
}

function toBBox(rect, vpW, vpH) {
    return [
        Math.round(Math.max(0, rect.y / vpH * 1000)),
        Math.round(Math.max(0, rect.x / vpW * 1000)),
        Math.round(Math.min(1000, (rect.y + rect.h) / vpH * 1000)),
        Math.round(Math.min(1000, (rect.x + rect.w) / vpW * 1000)),
    ];
}

// Return a quoted label for an element's textContent: short text is returned
// as-is; text over 60 chars is truncated with ellipsis. Falls back to null
// for elements with no meaningful text, so callers can use a zone fallback.
function elQ(el) {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length < 2) return null;
    // Filter out promo codes, CSS class names, slugs — no spaces + has digit + length > 5
    // e.g. 'pdrmztmb20', 'abc123', 'promo50' are not human-readable labels
    if (!t.includes(' ') && t.length > 5 && /[0-9]/.test(t)) return null;
    return t.length > 60 ? `'${t.slice(0, 57)}...'` : `'${t}'`;
}

// ── Public entry point ─────────────────────────────────────────────────────────

/**
 * @param {Array} elements  DOM element data extracted by Puppeteer
 * @param {number} vpW      viewport width in pixels
 * @param {number} vpH      viewport height in pixels
 */
export function analyseAlgorithmically(elements, vpW, vpH) {
    _id = 0;
    const findings = [];
    const strengths = [];
    const vis = elements.filter(e => e.rect.w >= 2 && e.rect.h >= 2);
    const textEls = vis.filter(e => e.isText && e.fontSize >= 9);

    // ── Density factors — visual weight is affected by local crowding ────────────────────
    // Per balance theory: density (how tightly packed elements are) contributes to
    // visual weight just as size, colour, and contrast do. An area with many closely
    // packed elements feels heavier than the same pixel area with sparse content.
    const densityFactor = new Map();
    {
        const radius = 200; // neighbourhood radius in pixels
        const counts = vis.map(el => {
            const cx = el.rect.x + el.rect.w / 2;
            const cy = el.rect.y + el.rect.h / 2;
            let n = 0;
            for (const other of vis) {
                if (other === el) continue;
                const dx = (other.rect.x + other.rect.w / 2) - cx;
                const dy = (other.rect.y + other.rect.h / 2) - cy;
                if (dx * dx + dy * dy <= radius * radius) n++;
            }
            return n;
        });
        const avg = counts.reduce((s, c) => s + c, 0) / Math.max(1, counts.length);
        // Normalise to 0.6–1.6: crowded areas carry up to 60% more weight, isolated areas 40% less
        vis.forEach((el, i) => {
            densityFactor.set(el, avg > 0 ? Math.max(0.6, Math.min(1.6, counts[i] / avg)) : 1.0);
        });
    }

    // ── CHECK 1 — Text Contrast ────────────────────────────────────────────────
    {
        // Size-dependent APCA minimum Lc values (simplified from APCA research):
        // under 14px: Lc 60 | 14-17px body: Lc 45 | 18-23px large: Lc 35 | 24px+ headlines: Lc 25
        const lcMin = (sz) => sz < 14 ? 60 : sz < 18 ? 45 : sz < 24 ? 35 : 25;

        const bodyFailing = [];
        const interactiveFailing = [];
        for (const el of textEls) {
            const fgL = luma(el.color[0], el.color[1], el.color[2]);
            const bgL = luma(el.bg[0], el.bg[1], el.bg[2]);
            if (Math.abs(fgL - bgL) < 0.01) continue;
            const lc = Math.abs(apcaLc(fgL, bgL));
            const needed = lcMin(el.fontSize);
            if (lc < needed) {
                if (el.isInteractive) interactiveFailing.push({ lc, needed, el });
                else bodyFailing.push({ lc, needed, el });
            }
        }

        let contrastFindingPushed = false;

        const bodyFailRatio = textEls.length > 0 ? bodyFailing.length / textEls.length : 0;
        if (bodyFailing.length > 0) {
            bodyFailing.sort((a, b) => a.lc - b.lc);
            const worst = bodyFailing[0];
            if (bodyFailRatio > 0.15 || worst.lc < 22) {
                const zone = zoneDesc(worst.el.rect.x + worst.el.rect.w / 2, worst.el.rect.y + worst.el.rect.h / 2, vpW, vpH);
                const deficit = Math.round(worst.needed - worst.lc);
                findings.push({
                    id: nid(),
                    category: 'Readability',
                    severity: bodyFailRatio > 0.30 || worst.lc < 18 ? 'critical' : 'warning',
                    element: `${bodyFailing.length} text area${bodyFailing.length !== 1 ? 's' : ''} that are hard to read due to low contrast between text and background (worst: ${zone})`,
                    issue: `${bodyFailing.length} text area${bodyFailing.length !== 1 ? 's' : ''} do not have enough contrast between the text colour and its background. The worst case is in the ${zone}. Smaller text needs more contrast than larger text — the smaller the letters, the darker they need to be against their background.`,
                    recommendation: `Darken the text or lighten the background in the ${zone} area, and apply the same fix to any other areas flagged. A simple check: can you read it comfortably at a glance without squinting?`,
                    boundingBox: toBBox(worst.el.rect, vpW, vpH),
                });
                contrastFindingPushed = true;
            }
        }

        if (interactiveFailing.length > 0) {
            interactiveFailing.sort((a, b) => a.lc - b.lc);
            const worst = interactiveFailing[0];
            const zone = zoneDesc(worst.el.rect.x + worst.el.rect.w / 2, worst.el.rect.y + worst.el.rect.h / 2, vpW, vpH);
            findings.push({
                id: nid(),
                category: 'Readability',
                severity: interactiveFailing.length > 3 || worst.lc < 30 ? 'warning' : 'info',
                element: `${interactiveFailing.length} button${interactiveFailing.length !== 1 ? 's' : ''} or link${interactiveFailing.length !== 1 ? 's' : ''} with text that is hard to read against their background (worst: ${zone})`,
                issue: `${interactiveFailing.length} button${interactiveFailing.length !== 1 ? 's' : ''} or link${interactiveFailing.length !== 1 ? 's' : ''} do not have enough contrast between their label text and their background colour. This matters most for interactive elements — users need to read them clearly to decide what to do next.`,
                recommendation: 'Make sure button and link labels are clearly readable against their own background — not just the page background. A coloured button still needs its label to stand out from that button colour.',
                boundingBox: toBBox(worst.el.rect, vpW, vpH),
            });
            contrastFindingPushed = true;
        }

        if (!contrastFindingPushed && textEls.length > 0) {
            strengths.push('Text and interactive elements have good contrast at all sizes — everything is easy to read.');
        }

        // Sub-check C: contrast tier diversity — is contrast being used as a hierarchy signal?
        // Good designs vary Lc across text tiers: headings darker, captions softer.
        if (textEls.length >= 6) {
            const lcValues = textEls.map(e => {
                const fgL = luma(e.color[0], e.color[1], e.color[2]);
                const bgL = luma(e.bg[0], e.bg[1], e.bg[2]);
                return Math.abs(apcaLc(fgL, bgL));
            }).filter(lc => lc > 10);
            if (lcValues.length >= 4) {
                const maxLc = Math.max(...lcValues);
                const minLc = Math.min(...lcValues);
                const lcRange = maxLc - minLc;
                if (lcRange < 12 && maxLc > 35) {
                    findings.push({
                        id: nid(),
                        category: 'Readability',
                        severity: 'info',
                        element: 'All text uses the same contrast level — contrast is not reinforcing hierarchy',
                        issue: `Every text element has a very similar contrast value (Lc range: just ${Math.round(lcRange)} units across all text). Good typographic hierarchy uses contrast variation: primary headings should have the strongest contrast, body text slightly less, and secondary captions/labels softer still. When all text sits at the same Lc level, the reader cannot use contrast as a quick guide to importance — they must read every element to understand its rank.`,
                        recommendation: 'Deliberately reduce the contrast of secondary text — timestamps, helper labels, footer copy — while keeping headings and primary body text at full contrast. Even a 10–15 Lc difference between tiers is perceivable and reinforces the reading hierarchy without hurting accessibility.',
                        boundingBox: [0, 0, 1000, 1000],
                    });
                } else if (lcRange >= 25 && maxLc >= 60) {
                    strengths.push('Contrast is used as a hierarchy tool — primary text is noticeably stronger than secondary and caption text, reinforcing the reading order.');
                }
            }
        }

        // Sub-check D: very small text (under 11px) with dangerously low contrast
        // At sub-11px sizes, APCA requires Lc 70+ — but even Lc 50 is borderline.
        {
            const tinyLowContrast = textEls.filter(e => {
                if (e.fontSize >= 11) return false;
                const fgL = luma(e.color[0], e.color[1], e.color[2]);
                const bgL = luma(e.bg[0], e.bg[1], e.bg[2]);
                return Math.abs(apcaLc(fgL, bgL)) < 50;
            });
            if (tinyLowContrast.length >= 2) {
                const zone = zoneDesc(
                    tinyLowContrast[0].rect.x + tinyLowContrast[0].rect.w / 2,
                    tinyLowContrast[0].rect.y + tinyLowContrast[0].rect.h / 2,
                    vpW, vpH
                );
                findings.push({
                    id: nid(),
                    category: 'Readability',
                    severity: tinyLowContrast.length >= 4 ? 'warning' : 'info',
                    element: `${tinyLowContrast.length} tiny text element${tinyLowContrast.length !== 1 ? 's' : ''} (under 11px) with insufficient contrast — worst area: ${zone}`,
                    issue: `${tinyLowContrast.length} text element${tinyLowContrast.length !== 1 ? 's' : ''} combine very small size (under 11px) with low contrast. Sub-11px text requires Lc 70+ to remain readable — these elements fall well below that. The combination makes them effectively invisible to many users, particularly at non-ideal screen angles, in bright environments, or for anyone with even mild visual impairment.`,
                    recommendation: 'If this text carries meaning, increase contrast to Lc 70+ and set the font size to at least 12px. If it is purely decorative, mark it `aria-hidden="true"` and reduce its visual presence intentionally. Never combine font sizes below 10px with low contrast — the result is reliably unreadable.',
                    boundingBox: toBBox(tinyLowContrast[0].rect, vpW, vpH),
                });
            }
        }

        // Sub-check E: near-maximum contrast on almost everything — no tonal warmth
        // Pure black on pure white everywhere is visually clinical and removes all hierarchy cues.
        {
            const nearMaxContrast = textEls.filter(e => {
                const fgL = luma(e.color[0], e.color[1], e.color[2]);
                const bgL = luma(e.bg[0], e.bg[1], e.bg[2]);
                return Math.abs(apcaLc(fgL, bgL)) > 88;
            });
            const maxContrastRatio = textEls.length > 0 ? nearMaxContrast.length / textEls.length : 0;
            if (maxContrastRatio > 0.80 && nearMaxContrast.length >= 10) {
                findings.push({
                    id: nid(),
                    category: 'Readability',
                    severity: 'info',
                    element: `${Math.round(maxContrastRatio * 100)}% of text is at near-maximum contrast — the interface may feel harsh or lack tonal depth`,
                    issue: `Most text uses contrast values above Lc 88 — approaching absolute black-on-white. While high contrast aids readability, a design where every text element is at maximum contrast has no tonal warmth or depth and offers no visual cues to differentiate importance levels. There is no soft-grey caption, no dimmer helper text — everything competes at the same intensity.`,
                    recommendation: 'Introduce softer contrast tiers for secondary text: body text at Lc ~80 (#1a1a1a on white), captions and labels at Lc ~55 (#6b7280 on white). This creates perceptible hierarchy while keeping primary content sharp. The contrast range itself becomes a design language.',
                    boundingBox: [0, 0, 1000, 1000],
                });
            }
        }
    }

    // ── CHECK 2 — Optical Centering ────────────────────────────────────────────
    {
        let wx = 0, wy = 0, wTotal = 0, leftW = 0, rightW = 0;
        for (const el of vis) {
            // Images and CSS background-image elements: their background colour in the DOM
            // is the parent's colour (usually white), not the actual image pixels.
            // Use an estimated mid-tone luminance so photos and hero sections register
            // with meaningful visual weight instead of near-zero.
            const bgL = (el.tag === 'img' || el.hasBackgroundImage) ? 0.35 : luma(el.bg[0], el.bg[1], el.bg[2]);
            const area = el.rect.w * el.rect.h;
            // Multiply by density factor: packed areas feel heavier (balance theory)
            const w = area * (1 - bgL) * (densityFactor.get(el) ?? 1.0);
            const cx = el.rect.x + el.rect.w / 2;
            const cy = el.rect.y + el.rect.h / 2;
            wx += cx * w; wy += cy * w; wTotal += w;
            if (cx < vpW / 2) leftW += w; else rightW += w;
        }
        const comX = wTotal > 0 ? wx / wTotal : vpW / 2;
        const comY = wTotal > 0 ? wy / wTotal : vpH / 2;
        const dxN = (comX - vpW / 2) / vpW;
        const dyN = (comY - vpH / 2) / vpH;
        const offsetMag = Math.sqrt(dxN * dxN + dyN * dyN);
        // Pre-compute lr ratio so we can avoid duplicating the same message below.
        const lrTotal = leftW + rightW;
        const lrRatio = lrTotal > 0 ? Math.abs(leftW - rightW) / lrTotal : 0;
        // Only emit the center-of-mass finding when the imbalance is primarily vertical
        // OR when the left-right ratio check won't fire for the same issue.
        const offsetPrimarilyHorizontal = Math.abs(dxN) > Math.abs(dyN) * 0.7;
        if (offsetMag > 0.10 && !(offsetPrimarilyHorizontal && lrRatio > 0.40)) {
            const parts = [];
            if (Math.abs(dxN) > 0.06) parts.push(dxN > 0 ? 'right' : 'left');
            if (Math.abs(dyN) > 0.06) parts.push(dyN > 0 ? 'downward' : 'upward');
            findings.push({
                id: nid(),
                category: 'Visual Weight',
                severity: offsetMag > 0.20 ? 'warning' : 'info',
                element: `Visual weight sits toward the ${parts.join(' and ')}`,
                issue: `The heavier elements (darker blocks, large images, dense text) are concentrated toward the ${parts.join(' and ')} of the page. This is sometimes a deliberate design choice (split layouts, dark sidebars, hero images) and can look great. Worth checking it feels intentional rather than accidental.`,
                recommendation: 'If this asymmetry is intentional, no action needed — it can create strong visual interest. If it feels unplanned, consider whether the heavier side is drawing attention away from your most important content.',
                boundingBox: [
                    Math.max(0, Math.round((comY / vpH - 0.08) * 1000)),
                    Math.max(0, Math.round((comX / vpW - 0.08) * 1000)),
                    Math.min(1000, Math.round((comY / vpH + 0.08) * 1000)),
                    Math.min(1000, Math.round((comX / vpW + 0.08) * 1000)),
                ],
            });
        } else {
            strengths.push('The page is visually centred — no obvious leaning to one side.');
        }
        if (lrRatio > 0.40) {
            const heavy = leftW > rightW ? 'left' : 'right';
            const light = heavy === 'left' ? 'right' : 'left';

            // Detect split-screen layout: heavy side has a large image/box, light side
            // has text elements spread vertically. In this case the imbalance is structural
            // and intentional — text columns perceptually balance image panels even when
            // raw area weight differs, because spatial distribution creates counterweight.
            const heavyHalf = vis.filter(e => (e.rect.x + e.rect.w / 2) < vpW / 2 === (heavy === 'left'));
            const lightHalf = vis.filter(e => (e.rect.x + e.rect.w / 2) < vpW / 2 === (heavy === 'right'));
            const heavyHasLargeImage = heavyHalf.some(e =>
                (e.tag === 'img' || e.hasBackgroundImage) &&
                e.rect.w * e.rect.h > vpW * vpH * 0.15
            );
            const lightTextEls = lightHalf.filter(e => e.isText && e.rect.w > 40);
            const lightTextSpan = lightTextEls.length >= 3
                ? Math.max(...lightTextEls.map(e => e.rect.y + e.rect.h)) - Math.min(...lightTextEls.map(e => e.rect.y))
                : 0;
            const isSplitLayout = heavyHasLargeImage && lightTextSpan > vpH * 0.30;

            findings.push({
                id: nid(),
                category: 'Visual Weight',
                severity: isSplitLayout ? 'info' : (lrRatio > 0.60 ? 'warning' : 'info'),
                element: isSplitLayout
                    ? `Split layout — image on the ${heavy} side, text column on the ${light}`
                    : `Noticeably more visual weight on the ${heavy} side`,
                issue: isSplitLayout
                    ? `The ${heavy} side carries a large image or content block while the ${light} side has a text column. This is a common and effective split-screen composition — a text column spread vertically creates perceptual counterweight even when raw area weight differs. Worth checking visually that neither side feels dominant enough to steal focus from the main message.`
                    : `The ${heavy} side holds significantly more visual weight than the ${light}. This could be intentional (split-screen, sidebar) or an accidental imbalance. Check that it feels deliberate rather than unplanned.`,
                recommendation: isSplitLayout
                    ? `No fix needed if this is intentional. If one side feels too dominant, try increasing whitespace around the lighter column or reducing the image's visual contrast with a subtle overlay.`
                    : `If the imbalance is planned, no fix needed. If it surprised you, check whether a large dark container or image on the ${heavy} side can be lightened or resized without breaking the design intent.`,
                boundingBox: heavy === 'left' ? [0, 0, 1000, 500] : [0, 500, 1000, 1000],
            });
        } else {
            strengths.push('Left–right visual weight is well balanced.');
        }
    }

    // ── CHECK 2b — Top/Bottom Balance and Quadrant Distribution ───────────────
    {
        // Top vs bottom weight — measures the vertical axis analogue of left/right balance.
        // Uses proportional area splitting: an element that spans the midline contributes
        // weight to each half in proportion to how much of its area falls there.
        // This avoids the bias caused by large elements whose centre falls just above or
        // below the midline being assigned entirely to one half.
        let topW2 = 0, botW2 = 0;
        const qWeights = [0, 0, 0, 0]; // [top-left, top-right, bottom-left, bottom-right]
        const midX = vpW / 2;
        const midY = vpH / 2;
        for (const el of vis) {
            const bgL = (el.tag === 'img' || el.hasBackgroundImage) ? 0.35 : luma(el.bg[0], el.bg[1], el.bg[2]);
            const w = el.rect.w * el.rect.h * (1 - bgL) * (densityFactor.get(el) ?? 1.0);
            if (w <= 0) continue;

            // Proportional top/bottom split
            const elTop = el.rect.y;
            const elBot = el.rect.y + el.rect.h;
            const h = Math.max(1, el.rect.h);
            const topFracY = elBot <= midY ? 1 : (elTop >= midY ? 0 : (midY - elTop) / h);
            topW2 += w * topFracY;
            botW2 += w * (1 - topFracY);

            // Proportional quadrant split (horizontal + vertical)
            const elLeft = el.rect.x;
            const elRight = el.rect.x + el.rect.w;
            const ww = Math.max(1, el.rect.w);
            const leftFracX = elRight <= midX ? 1 : (elLeft >= midX ? 0 : (midX - elLeft) / ww);
            qWeights[0] += w * leftFracX * topFracY;           // top-left
            qWeights[1] += w * (1 - leftFracX) * topFracY;     // top-right
            qWeights[2] += w * leftFracX * (1 - topFracY);     // bottom-left
            qWeights[3] += w * (1 - leftFracX) * (1 - topFracY); // bottom-right
        }

        // Sub-check A: top/bottom imbalance
        const tbTotal = topW2 + botW2;
        const tbRatio = tbTotal > 0 ? Math.abs(topW2 - botW2) / tbTotal : 0;
        if (tbRatio > 0.52) {
            const heavy = topW2 > botW2 ? 'top' : 'bottom';
            findings.push({
                id: nid(),
                category: 'Visual Weight',
                severity: tbRatio > 0.65 ? 'warning' : 'info',
                element: `Strong top–bottom imbalance — the ${heavy} half of the page carries significantly more visual weight`,
                issue: `The ${heavy} half of the viewport carries ${Math.round(tbRatio * 100)}% more visual weight than the opposite half. ${heavy === 'top' ? 'Top-heavy layouts can feel claustrophobic or unstable — as if the page is pressing down. This is common with large hero sections and dense navigation bars, but if unintentional it may push important below-the-fold content into visual obscurity.' : 'Bottom-heavy layouts are unusual and often unintentional. When the dominant visual mass sits in the lower half, critical content arrives too late in the user journey — most visitors form their first impression before scrolling reaches the bottom of the page.'}`,
                recommendation: heavy === 'top'
                    ? 'If the top section is a hero or heavy navigation, balance it by making the mid-page content strongly prominent with a bold section break, vivid background, or high-contrast headline. If the imbalance is purely the navigation, consider a lighter header background.'
                    : 'Move your most critical content higher. Check whether any unnecessarily large images, dark footer areas, or dense card grids near the bottom can be lightened or resized. The first viewport should carry more visual weight than the bottom.',
                boundingBox: heavy === 'top' ? [0, 0, 500, 1000] : [500, 0, 1000, 1000],
            });
        } else if (tbRatio <= 0.20) {
            strengths.push('Top-to-bottom weight distribution is balanced — visual mass is spread through the vertical axis without either half dominating.');
        }

        // Sub-check B: quadrant concentration
        const qTotal = qWeights.reduce((s, v) => s + v, 0);
        if (qTotal > 0) {
            const qShares = qWeights.map(w => w / qTotal);
            const maxShare = Math.max(...qShares);
            const maxIdx = qShares.indexOf(maxShare);
            const qNames = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
            const oppositeNames = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

            // True problem: one quadrant dominates AND the diagonally opposite corner is near-empty.
            // A 60% corner with 20% in the opposite quadrant is a strong asymmetric layout, not a flaw.
            const oppositeIdx = [3, 2, 1, 0][maxIdx];
            const oppositeShare = qShares[oppositeIdx];
            if (maxShare > 0.68 && oppositeShare < 0.12) {
                findings.push({
                    id: nid(),
                    category: 'Visual Weight',
                    severity: maxShare > 0.72 ? 'warning' : 'info',
                    element: `${Math.round(maxShare * 100)}% of visual weight in the ${qNames[maxIdx]} quadrant with almost nothing in the opposite corner`,
                    issue: `The ${qNames[maxIdx]} quadrant holds ${Math.round(maxShare * 100)}% of the page's visual weight while the diagonally opposite ${oppositeNames[maxIdx]} corner carries only ${Math.round(oppositeShare * 100)}%. The issue is not the concentration itself — asymmetric layouts are perfectly valid — but the absence of any counterbalancing mass in the opposite corner. Without something to anchor the opposing side, the composition has nothing to stabilise against the dominant pull, which can read as unfinished or visually unstable.`,
                    recommendation: `Add a visually prominent element in the ${oppositeNames[maxIdx]} area to create diagonal counterbalance — a pull quote, a contrasting panel, a strong image, or a bold typographic block. The counterbalancing element does not need to match the dominant weight; it just needs to anchor the opposite corner.`,
                    boundingBox: [
                        maxIdx >= 2 ? 500 : 0,
                        maxIdx % 2 === 1 ? 500 : 0,
                        maxIdx >= 2 ? 1000 : 500,
                        maxIdx % 2 === 1 ? 1000 : 500,
                    ],
                });
            } else {
                // Sub-check C: diagonal axis imbalance (TL+BR vs TR+BL)
                const diag1 = qShares[0] + qShares[3]; // top-left + bottom-right
                const diag2 = qShares[1] + qShares[2]; // top-right + bottom-left
                const diagImbalance = Math.abs(diag1 - diag2);
                if (diagImbalance > 0.38) {
                    const heavyDiag = diag1 > diag2 ? 'top-left / bottom-right' : 'top-right / bottom-left';
                    findings.push({
                        id: nid(),
                        category: 'Visual Weight',
                        severity: 'info',
                        element: `Diagonal weight imbalance — the ${heavyDiag} axis carries disproportionate visual weight`,
                        issue: `The ${heavyDiag} diagonal holds ${Math.round(diagImbalance * 100)} percentage points more visual weight than the opposing diagonal. Diagonal balance — where opposite quadrants counterweight each other — is a key composition principle in both print and digital design. An unplanned diagonal tilt gives the layout a subtle sense of "sliding" in one direction, which users may experience as unease or asymmetry without being able to identify the cause.`,
                        recommendation: 'Check whether large dark containers, images, or dense text blocks on the heavy diagonal can be lightened, reduced, or offset by introducing slightly heavier elements in the lighter diagonal corners. Even a modestly prominent element in the lighter corner significantly improves perceived stability.',
                        boundingBox: [0, 0, 1000, 1000],
                    });
                } else {
                    strengths.push('Quadrant and diagonal balance is good — visual weight is distributed across all four corners without a dominant pull in any single direction.');
                }
            }
        }
    }

    // ── CHECK 3 — Visual Focus ─────────────────────────────────────────────────
    {
        const largeBgs = vis.filter(e => e.rect.w > vpW * 0.4 && e.rect.h > vpH * 0.1);
        const pageBgL = largeBgs.length > 0
            ? largeBgs.reduce((s, e) => s + luma(e.bg[0], e.bg[1], e.bg[2]), 0) / largeBgs.length
            : 0.95;
        const scored = vis
            .filter(e => e.rect.w < vpW * 0.95)
            .map(e => {
                // Same image fix: treat img and CSS background-image elements as mid-tone
                // so photos and hero sections register as focal points, not invisible white areas.
                const fgL = (e.tag === 'img' || e.hasBackgroundImage) ? 0.35 : luma(e.bg[0], e.bg[1], e.bg[2]);
                const contrast = Math.abs(fgL - pageBgL);
                const area = (e.rect.w * e.rect.h) / (vpW * vpH);
                // Density boosts focal score: a crowded element draws more attention
                return { e, score: contrast * Math.sqrt(area) * (densityFactor.get(e) ?? 1.0) };
            })
            .filter(s => s.score > 0.01)
            .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {
            const top = scored[0];
            const competing = scored.filter(s => s.score > top.score * 0.75).length;
            const dominanceRatio = scored.length > 1 ? top.score / scored[1].score : 999;
            if (competing >= 12) {
                // Detect mosaic / crystallographic balance: consistent element sizes across
                // competing areas suggests an intentional grid or listing layout (e.g. product
                // cards, image galleries) where no single element dominating is by design.
                const competingEls = scored.filter(s => s.score > top.score * 0.75);
                const areas = competingEls.map(s => s.e.rect.w * s.e.rect.h);
                const avgArea = areas.reduce((s, a) => s + a, 0) / Math.max(1, areas.length);
                const stdArea = Math.sqrt(areas.reduce((s, a) => s + (a - avgArea) ** 2, 0) / Math.max(1, areas.length));
                const isMosaic = avgArea > 0 && (stdArea / avgArea) < 0.45;
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: competing >= 18 && !isMosaic ? 'warning' : 'info',
                    element: isMosaic
                        ? `Mosaic balance detected: ${competing} areas share equal visual weight with consistent element sizes`
                        : `No clear focal point: ${competing} areas pull attention equally`,
                    issue: isMosaic
                        ? `${competing} areas of the page carry similar visual weight and have consistent element sizes — this is the pattern you see in product grids and image galleries. No single element dominates here; the uniform layout itself creates structure and rhythm. This works well for browsing surfaces where people scan rather than follow one specific path.`
                        : `${competing} different areas of the page stand out at almost the same level, with no single spot clearly dominating. When everything looks equally important, people do not know where to look first and have to scan the whole page to understand it.`,
                    recommendation: isMosaic
                        ? 'For mosaic layouts, ensure consistency across the grid — equal card sizes, uniform spacing, and aligned rows — so the equal-weight distribution reads as deliberate structure rather than accidental clutter. If this page is also meant to drive a specific action (sign-up, purchase), consider adding a hero or pinned element with clearly higher visual weight above the grid to serve as an entry point before the mosaic begins.'
                        : 'Pick one area as the main focus — your headline, main button, or key information. Make everything else slightly less prominent: lighter backgrounds, smaller type, or less vivid colour.',
                    boundingBox: toBBox(top.e.rect, vpW, vpH),
                });
            } else if (competing <= 4 && dominanceRatio > 1.3) {
                strengths.push('There is a clear focal point — one area stands out right away, making it easy to know where to look first.');
            }

            // Sub-check B: moderate competition zone (5–11 areas) — not mosaic, not clear hierarchy
            if (competing >= 5 && competing < 12) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: competing >= 8 ? 'warning' : 'info',
                    element: `${competing} areas with similar visual weight — too many to leave a clear focal point`,
                    issue: `There are ${competing} zones on the page that pull attention at nearly the same level. This is not consistent enough to read as an intentional mosaic grid, but far too many for a clear focal-point hierarchy. Visitors must broadly scan the entire page before they can identify what to do first. Every additional element competing at near-equal weight adds cognitive load — the brain works harder and first-impression clarity suffers.`,
                    recommendation: 'Identify the single most important action or piece of content and deliberately increase its visual dominance: make it larger, put it on a higher-contrast background, or surround it with more white space. Simultaneously reduce the weight of 2–3 competing elements by slightly decreasing their size, lightening their background, or reducing saturation.',
                    boundingBox: toBBox(top.e.rect, vpW, vpH),
                });
            }

            // Sub-check C: weak focal point — one element leads but by a very small margin
            if (competing <= 4 && scored.length >= 2) {
                const dominanceRatio2 = scored[0].score / scored[1].score;
                if (dominanceRatio2 >= 1.05 && dominanceRatio2 < 1.40) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: `Focal point exists but with only ${dominanceRatio2.toFixed(2)}× dominance over the second element`,
                        issue: `There is a leading element, but it is only ${dominanceRatio2.toFixed(2)}× more visually prominent than the next strongest — a very small margin. At this dominance ratio, many users will split attention between the two rather than immediately locking onto the primary. The hierarchy is technically present but perceptually weak: visitors experience mild uncertainty during the critical first glance.`,
                        recommendation: `Strengthen the primary element's dominance: increase its size by 15–20%, add more surrounding white space to isolate it, place it on a more contrasting background, or increase its text weight. A dominance ratio of 1.6× or higher is where hierarchy becomes unambiguous at a glance. Simultaneously, reduce the second element's weight slightly so the gap widens.`,
                        boundingBox: toBBox(scored[0].e.rect, vpW, vpH),
                    });
                }
            }

            // Sub-check D: focal point location analysis
            // Per F-pattern and Z-pattern research, the upper half (preferably upper-left
            // or upper-centre) is the strongest entry position for a focal element.
            if (competing <= 6) {
                const focal = scored[0].e;
                const focalX = focal.rect.x + focal.rect.w / 2;
                const focalY = focal.rect.y + focal.rect.h / 2;
                const xRatio = focalX / vpW;
                const yRatio = focalY / vpH;
                if (yRatio > 0.62) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: 'Primary focal point is in the lower portion of the visible page',
                        issue: `The most visually dominant element sits ${Math.round(yRatio * 100)}% down the viewport. Users form their first impression within the visible area before scrolling — content in the lower half is statistically less likely to be seen on first load. When the dominant visual anchor is near the bottom, the page entry hierarchy is effectively inverted: the eye lands first on lesser content and may never reach the primary.`,
                        recommendation: 'Move the most important element — your headline, CTA, or hero image — to above the midpoint of the first viewport. If the current layout constraints prevent this, consider restructuring to lead with value before scrolling is required.',
                        boundingBox: toBBox(focal.rect, vpW, vpH),
                    });
                } else if (xRatio > 0.72 && yRatio >= 0.15) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: 'Primary focal point is toward the far right side of the layout',
                        issue: `The dominant element is positioned in the rightmost zone of the page (${Math.round(xRatio * 100)}% from the left). In left-to-right reading cultures, the eye enters from the upper-left. A dominant element on the far right takes advantage of the eye's rightward sweep but is missed by visitors who scan and disengage before completing the sweep.`,
                        recommendation: 'If the right-dominant positioning is intentional (e.g. right-side CTA paired with left-side body text), add a strong left-side entry point — a headline or subheading — that leads the eye toward the right. If unintentional, shifting the dominant element leftward increases its first-glance prominence.',
                        boundingBox: toBBox(focal.rect, vpW, vpH),
                    });
                } else if (yRatio < 0.40 && xRatio >= 0.10 && xRatio <= 0.75) {
                    strengths.push('The primary focal point sits in the upper portion of the layout — well-positioned in the F-pattern entry zone where eyes naturally land first.');
                }
            }
        }
    }

    // ── CHECK 4 — Tonal Range ──────────────────────────────────────────────────
    {
        const BANDS = 10;
        const hist = new Array(BANDS).fill(0);
        const seen = new Set();
        const lumaValues = [];
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const key = `${Math.round(c[0] / 20)},${Math.round(c[1] / 20)},${Math.round(c[2] / 20)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const L = luma(c[0], c[1], c[2]);
                    hist[Math.min(BANDS - 1, Math.floor(L * BANDS))]++;
                    lumaValues.push(L);
                }
            }
        }
        const total = seen.size;
        const threshold = Math.max(2, total * 0.03);
        const populated = hist.filter(c => c > threshold).length;

        // Sub-check A: too few tonal bands — critical to warning based on severity
        if (populated <= 1) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'critical',
                element: 'Almost no variation in brightness across the page — everything appears as one flat shade',
                issue: 'The entire page uses one brightness level with almost no light or dark variation. This makes it impossible to tell backgrounds from panels, panels from text, or content from decoration. Without any brightness range the page has no sense of depth or structure.',
                recommendation: 'Introduce at least three distinct brightness levels: a light background, a slightly darker surface for cards or panels, and dark text. Even a small step in brightness between layers makes a big difference to readability.',
                boundingBox: [0, 0, 1000, 1000],
            });
        } else if (populated <= 2) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: `Very few shades of light and dark — only ${populated} different brightness levels across the whole design`,
                issue: `The design uses only ${populated} brightness levels. This pushes backgrounds, cards, borders, and text into the same narrow range, making it hard to tell page regions apart visually. Without enough brightness variation, only size and colour can separate sections from each other.`,
                recommendation: 'Add at least 2 more brightness levels to create separation between layers. Typical designs use: very light (background ~95%), light (card ~90%), mid (borders ~70%), dark (body text ~20%), very dark (headings ~10%). That five-step range covers almost all separation needs.',
                boundingBox: [0, 0, 1000, 1000],
            });
        }

        // Sub-check B: bands present but all clustered in the mid-range (no true darks or lights)
        if (populated >= 3) {
            const darkBands = hist.slice(0, 3).filter(c => c > threshold).length;   // 0–30%
            const lightBands = hist.slice(7, 10).filter(c => c > threshold).length; // 70–100%
            const midBands = hist.slice(3, 7).filter(c => c > threshold).length;    // 30–70%
            if (darkBands === 0 && lightBands <= 1 && midBands >= 3) {
                findings.push({
                    id: nid(),
                    category: 'Colour Palette',
                    severity: 'info',
                    element: 'All shades are mid-grey — no near-black text or near-white backgrounds',
                    issue: 'The palette has some variety, but every shade sits in the middle brightness range with no deep darks or near-whites. There are no dark enough tones for strong headings or body text, and no light enough tones for clean open backgrounds. A palette stuck in the middle can feel flat or muddy.',
                    recommendation: 'Anchor the palette at both ends: use at least one very light shade for large backgrounds and at least one near-black shade for body text and headings. The other values can stay in the mid-range.',
                    boundingBox: [0, 0, 1000, 1000],
                });
            } else if (darkBands >= 2 && lightBands >= 2) {
                strengths.push('The palette spans from near-black to near-white, giving strong tonal contrast for clear depth and hierarchy.');
            }
        }

        // Sub-check C: check whether key semantic layers actually use different bands
        if (populated >= 3) {
            const bgLumaVals = vis.filter(e => e.rect.w > vpW * 0.3).map(e => luma(e.bg[0], e.bg[1], e.bg[2]));
            const textLumaVals = textEls.map(e => luma(e.color[0], e.color[1], e.color[2]));
            if (bgLumaVals.length >= 5 && textLumaVals.length >= 5) {
                const medianBg = bgLumaVals.sort((a, b) => a - b)[Math.floor(bgLumaVals.length / 2)];
                const medianText = textLumaVals.sort((a, b) => a - b)[Math.floor(textLumaVals.length / 2)];
                const separation = Math.abs(medianBg - medianText);
                if (separation < 0.12) {
                    findings.push({
                        id: nid(),
                        category: 'Colour Palette',
                        severity: 'warning',
                        element: `Text and background are almost the same brightness (only ${Math.round(separation * 100)}% difference)`,
                        issue: `Text and background colours are only ${Math.round(separation * 100)} percentage points apart in brightness on the median element. Even if the page uses a range of shades elsewhere, the most important contrast — text on its background — is too weak, which makes reading noticeably harder.`,
                        recommendation: 'Make the text noticeably darker (or lighter) than its background. The basic rule: light background → very dark text, dark background → very light text. There should be a clear, obvious brightness difference between the two.',
                        boundingBox: [0, 0, 1000, 1000],
                    });
                }
            }
        }

        // Sub-check D: palette has good tonal range — positive signal
        if (populated >= 7) {
            strengths.push('Good range of light and dark shades — different parts of the page feel distinct and easy to tell apart.');
        }

        // Sub-check E: dark-background design with incorrectly dark text
        // Dark mode UI must use light text — dark text on a dark background is invisible.
        {
            const largeBgSample = vis.filter(e => e.rect.w > vpW * 0.3 && e.rect.h > vpH * 0.05);
            const bgLumasSample = largeBgSample.map(e => luma(e.bg[0], e.bg[1], e.bg[2]));
            if (bgLumasSample.length >= 3) {
                const medBg = bgLumasSample.slice().sort((a, b) => a - b)[Math.floor(bgLumasSample.length / 2)];
                if (medBg < 0.12) {
                    // Dark-background design detected
                    const darkTextOnDark = textEls.filter(e => luma(e.color[0], e.color[1], e.color[2]) < 0.20);
                    if (darkTextOnDark.length >= 3) {
                        findings.push({
                            id: nid(),
                            category: 'Colour Palette',
                            severity: 'critical',
                            element: `Dark-background design — ${darkTextOnDark.length} text element${darkTextOnDark.length !== 1 ? 's' : ''} use near-black text (invisible on dark surfaces)`,
                            issue: `This page uses a dark background (median luminance: ${Math.round(medBg * 100)}%), but ${darkTextOnDark.length} text elements use near-black text colour — which becomes invisible against the dark surface. On dark-background designs, body text must be near-white, a light neutral, or a light tint of the brand colour. Near-black text on a dark background produces zero or negative contrast, making those elements completely unreadable.`,
                            recommendation: 'Audit all text colour assignments on dark surfaces. Set body text to at least #cccccc (80% lightness) and headings to #ffffff or your lightest brand tint. Only use dark text on intentional light-background insets — cards, modals, input fields — never on the primary dark surface.',
                            boundingBox: toBBox(darkTextOnDark[0].rect, vpW, vpH),
                        });
                    } else {
                        strengths.push('Dark-background design uses appropriately light text — the tonal inversion is handled correctly throughout.');
                    }
                }
            }
        }

        // Sub-check F: monotonous section backgrounds — all large areas the same brightness
        // When sections share the same background, there is no visual signal that a new
        // content area has begun, making the page feel flat and hard to navigate.
        {
            const largeSectionBgs = vis
                .filter(e =>
                    e.rect.w > vpW * 0.4 &&
                    e.rect.h > vpH * 0.06 &&
                    !(e.tag === 'img' || e.hasBackgroundImage)
                )
                .map(e => Math.round(luma(e.bg[0], e.bg[1], e.bg[2]) * 10));
            if (largeSectionBgs.length >= 7) {
                const shadeCounts = {};
                largeSectionBgs.forEach(b => { shadeCounts[b] = (shadeCounts[b] || 0) + 1; });
                const topBucket = Math.max(...Object.values(shadeCounts));
                const monotonyRatio = topBucket / largeSectionBgs.length;
                if (monotonyRatio > 0.82) {
                    findings.push({
                        id: nid(),
                        category: 'Colour Palette',
                        severity: 'info',
                        element: `${Math.round(monotonyRatio * 100)}% of page sections share the same background brightness — no visual breaks between areas`,
                        issue: `Almost all large section backgrounds fall into the same brightness bucket. When backgrounds are monotonous, there is no visual signal to mark where one content area ends and another begins. Users must read headings to know they entered a new section rather than perceiving the break instinctively. This is one of the most common reasons a page feels "flat" or "hard to navigate" even when the typography is considered good.`,
                        recommendation: 'Alternate section backgrounds using at least three distinct brightness levels: your primary background, a slightly tinted surface (2–5% lighter or darker) for alternating sections, and a bold accent background for the main CTA section. Even a minimal brightness variation creates immediately perceivable section breaks.',
                        boundingBox: [0, 0, 1000, 1000],
                    });
                } else if (monotonyRatio <= 0.50 && largeSectionBgs.length >= 7) {
                    strengths.push('Page sections use varied background brightnesses — different areas are visually distinct, making it easy to perceive section breaks at a glance.');
                }
            }
        }
    }


    // ── CHECK 5 — Colour Palette ───────────────────────────────────────────────
    {
        const HUE_BINS = 12;
        const hueBins = new Array(HUE_BINS).fill(0);
        let chromaticCount = 0, totalColors = 0;
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
                totalColors++;
                if (s > 0.15 && l > 0.05 && l < 0.95) {
                    hueBins[Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS))]++;
                    chromaticCount++;
                }
            }
        }
        const chromaticRatio = totalColors > 0 ? chromaticCount / totalColors : 0;
        const hueThreshold = Math.max(1, chromaticCount * 0.05);
        const dominantHues = hueBins.filter(c => c > hueThreshold).length;

        // Sort bins to find which hue family dominates
        const sortedHueBins = [...hueBins].sort((a, b) => b - a);
        const topHueShare = chromaticCount > 0 ? sortedHueBins[0] / chromaticCount : 0;

        // Sub-check A: too little colour
        if (chromaticRatio < 0.03) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: 'Almost no colour used — the design is nearly entirely grey',
                issue: `Only ${Math.round(chromaticRatio * 100)}% of the colour values on this page carry any chromatic hue. Without colour, users cannot distinguish interactive elements from static content at a glance, and there are no visual cues to guide attention. Buttons, links, status badges, and alerts all rely on colour to be understood quickly.`,
                recommendation: 'Introduce at least one primary colour for interactive elements (buttons, links) and consider semantic colours for feedback states (green for success, amber for warning, red for error). Even a single consistent accent colour transforms navigability.',
                boundingBox: [0, 0, 1000, 1000],
            });
        } else if (chromaticRatio < 0.08) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: `Minimal colour usage — only ${Math.round(chromaticRatio * 100)}% of palette values are chromatic`,
                issue: 'The design uses very little colour. This can read as refined or functional, but risks making interactive elements blend into the grey palette. Users scanning quickly may not immediately spot buttons or links.',
                recommendation: 'Check that all interactive elements (buttons, links, form controls) are clearly distinguishable from their surroundings without relying on hover states. A small, consistent accent colour for interactive elements goes a long way.',
                boundingBox: [0, 0, 1000, 1000],
            });
        }

        // Sub-check C: too many hues — colour overload
        if (dominantHues > 7) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: `Colour overload — ${dominantHues} hue families compete for attention`,
                issue: `There are ${dominantHues} distinct colour families on the page. When this many hues are in use simultaneously, colour loses its ability to carry meaning. Users cannot tell which colour means "clickable", which means "warning", and which is just decoration. The cognitive load of parsing so many colours erodes trust in the design.`,
                recommendation: 'Limit the palette to a primary brand colour, 1–2 neutral tones, and 3 semantic colours (success green, error red, warning amber). Every colour should answer the question: what does this colour tell the user? If the answer is unclear, remove it.',
                boundingBox: [0, 0, 1000, 1000],
            });
        }

        // Sub-check D: balanced, well-structured palette — positive signal
        if (dominantHues >= 2 && dominantHues <= 4 && chromaticRatio > 0.05 && chromaticRatio < 0.60) {
            strengths.push(`Colour is used purposefully — ${dominantHues} hue families keep the palette focused and every colour can carry distinct meaning.`);
        }

        // Sub-check E: button colour consistency
        // All solid-background buttons should share one hue family to create a consistent
        // 'clickable' signal. Multiple hue families erode the visual language of interactivity.
        {
            const solidButtons = vis.filter(e => e.tag === 'button' && e.rect.w > 40 && e.rect.h > 20);
            if (solidButtons.length >= 3) {
                const buttonChromatic = solidButtons
                    .map(e => { const [h, s, l] = rgbToHsl(e.bg[0], e.bg[1], e.bg[2]); return { h, s, l }; })
                    .filter(c => c.s > 0.15 && c.l > 0.1 && c.l < 0.9);
                if (buttonChromatic.length >= 3) {
                    const hueFamilies = new Set(buttonChromatic.map(c => Math.floor(c.h * 12)));
                    if (hueFamilies.size >= 3) {
                        findings.push({
                            id: nid(),
                            category: 'Colour Palette',
                            severity: hueFamilies.size >= 4 ? 'warning' : 'info',
                            element: `Buttons use ${hueFamilies.size} different colour families — no consistent "clickable" visual language`,
                            issue: `Buttons across the page appear in ${hueFamilies.size} distinct hue families. When buttons come in many colours, colour loses its ability to signal interactivity. Users rely on colour consistency to quickly spot what is clickable — a blue button, a red button, and a green button all require a separate recognition decision. This cognitive overhead erodes the instant affordance that a unified button language provides.`,
                            recommendation: 'Standardise to one primary colour (your brand colour) for primary actions, and one neutral or second-tier colour for secondary actions. Reserve semantically distinct colours for specific states: red for destructive actions, green for confirmations, amber for warnings — not for unrelated primary buttons.',
                            boundingBox: toBBox(solidButtons[0].rect, vpW, vpH),
                        });
                    } else if (hueFamilies.size === 1) {
                        strengths.push('All solid buttons share the same colour family — a consistent visual language makes every button instantly recognisable as clickable.');
                    }
                }
            }
        }

        // Sub-check F: accent colour overuse
        // An accent works because it is rare. When more than ~25% of elements
        // carry a saturated colour, it loses its signal value.
        {
            const accentEls = vis.filter(e => {
                const [, s, l] = rgbToHsl(e.bg[0], e.bg[1], e.bg[2]);
                return s > 0.50 && l > 0.25 && l < 0.75;
            });
            const accentRatio = vis.length > 0 ? accentEls.length / vis.length : 0;
            if (accentRatio > 0.25 && dominantHues <= 3 && accentEls.length >= 8) {
                findings.push({
                    id: nid(),
                    category: 'Colour Palette',
                    severity: 'info',
                    element: `Saturated accent colour appears on ${Math.round(accentRatio * 100)}% of elements — likely overused`,
                    issue: `The most saturated colour family is applied to ${Math.round(accentRatio * 100)}% of visible elements. Accent colours communicate emphasis because they are rare — the eye treats them as signals. When a quarter or more of the page carries vivid colour, the accent loses its special status and can no longer reliably draw attention to the most important interactive elements or key content.`,
                    recommendation: 'Reserve your most saturated colour for 5–10% of elements at most: CTAs, active states, and key highlights. Reduce the saturation of decorative borders, hover backgrounds, dividers, and secondary icons to a tinted neutral instead of the full accent hue. The scarcity of the accent is what gives it power.',
                    boundingBox: [0, 0, 1000, 1000],
                });
            }
        }
    }

    // ── CHECK 6 — Text Hierarchy ───────────────────────────────────────────────────
    {
        if (textEls.length >= 4) {
            const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

            // Sub-check A: heading level size progression
            const headingGroups = {};
            for (const tag of HEADING_TAGS) {
                const els = vis.filter(e => e.tag === tag && e.rect.w > 30);
                if (els.length > 0) headingGroups[tag] = Math.max(...els.map(e => e.fontSize));
            }
            const presentLevels = HEADING_TAGS.filter(t => t in headingGroups);

            if (presentLevels.length >= 2) {
                // Check size ratio between each adjacent heading level
                const scaleViolations = [];
                for (let i = 0; i < presentLevels.length - 1; i++) {
                    const larger = headingGroups[presentLevels[i]];
                    const smaller = headingGroups[presentLevels[i + 1]];
                    // Use the real size ratio regardless of tag order — avoids false positives
                    // where h1 happens to be smaller than h2 (inverted hierarchy) producing a
                    // ratio < 1 that would otherwise always trip the < 1.15 threshold.
                    const ratio = larger >= smaller
                        ? larger / smaller
                        : smaller / larger;
                    if (ratio < 1.15) scaleViolations.push({ from: presentLevels[i], to: presentLevels[i + 1], ratio, larger, smaller });
                }
                if (scaleViolations.length > 0) {
                    const worst = scaleViolations[0];
                    const worstSizeBig = Math.max(worst.larger, worst.smaller);
                    const worstSizeSmall = Math.min(worst.larger, worst.smaller);
                    const worstFromEl = vis.find(e => e.tag === worst.from && e.rect.w > 30);
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: scaleViolations.length > 1 || worst.ratio < 1.05 ? 'warning' : 'info',
                        element: `${worst.from} and ${worst.to} are too close in size (${Math.round(worstSizeBig)}px vs ${Math.round(worstSizeSmall)}px, ${worst.ratio.toFixed(2)}x ratio)`,
                        issue: `${worst.from} (${Math.round(worst.larger)}px) and ${worst.to} (${Math.round(worst.smaller)}px) are only ${worst.ratio.toFixed(2)}x apart in size. When adjacent heading levels are nearly the same size, readers cannot skim the page structure and must read line by line to understand what level they are on.`,
                        recommendation: `Increase the gap between heading levels to at least 1.25x. Common type scales: Major Third (1.25x), Perfect Fourth (1.333x), Golden Ratio (1.618x).`,
                        boundingBox: worstFromEl ? toBBox(worstFromEl.rect, vpW, vpH) : [0, 0, 400, 1000],
                    });
                } else {
                    strengths.push(`Heading levels follow a clear size progression — the ${presentLevels.join(' to ')} scale gives the page a well-defined information hierarchy.`);
                }

            } else {
                // No structured heading tags — fall back to whole-page text diversity check
                const sizes = textEls.map(e => e.fontSize);
                const sizeSpread = Math.max(...sizes) / Math.max(Math.min(...sizes), 8);
                const contrasts = textEls.map(e =>
                    Math.abs(apcaLc(luma(e.color[0], e.color[1], e.color[2]), luma(e.bg[0], e.bg[1], e.bg[2])))
                );
                const lcSpread = Math.max(...contrasts) - Math.min(...contrasts);
                if (sizeSpread < 1.2 && lcSpread < 15) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: 'All text looks the same size and weight',
                        issue: 'All text across the page is very similar in size and darkness. People have to read everything to figure out what is most important instead of spotting it at a glance.',
                        recommendation: 'Make your main headings noticeably bigger and bolder than body text, and make supporting labels slightly lighter or smaller. A clear size difference of at least 1.5x between headings and body text helps people scan quickly.',
                        boundingBox: textEls.length > 0 ? toBBox(textEls[0].rect, vpW, vpH) : [0, 0, 500, 1000],
                    });
                } else if (sizeSpread >= 1.5 && lcSpread >= 25) {
                    strengths.push('Text hierarchy is clear — there is a noticeable difference between headings and body text.');
                }
            }

            // Sub-check C: font-weight range — is bold/weight used to create emphasis?
            // When all text uses the same font weight, weight cannot signal importance.
            {
                const weights = textEls.map(e => e.fontWeight).filter(w => w > 0);
                if (weights.length >= 6) {
                    const uniqueWeights = new Set(weights);
                    const minW = Math.min(...weights);
                    const maxW = Math.max(...weights);
                    const weightRange = maxW - minW;
                    if (uniqueWeights.size === 1 || weightRange < 100) {
                        findings.push({
                            id: nid(),
                            category: 'Visual Hierarchy',
                            severity: uniqueWeights.size === 1 ? 'warning' : 'info',
                            element: `All text uses the same font weight${uniqueWeights.size === 1 ? ` (${[...uniqueWeights][0]})` : ` — weight range is only ${weightRange} units`} — weight is not reinforcing hierarchy`,
                            issue: `${uniqueWeights.size === 1 ? `Every text element uses weight ${[...uniqueWeights][0]}` : `Font weights span only ${weightRange} units (${minW} to ${maxW})`}. Font weight is one of the most powerful hierarchy tools: Bold headings versus Regular body text communicate importance instantly without relying on size alone. Without weight contrast, the user must interpret size and colour exclusively, which is a weaker and slower signal. Uniform weight also prevents the visual ‘punch’ that makes key headings memorable at a glance.`,
                            recommendation: 'Use at least two distinct weights: Bold (600–700) for headings and key labels, Regular (400) for body text, and optionally Light (300) or Semi-bold (500) for tertiary information. A weight spread of at least 200 units (e.g. 400 vs 600) is needed for the difference to be clearly perceivable at typical reading distances.',
                            boundingBox: [0, 0, 1000, 1000],
                        });
                    } else if (weightRange >= 300 && uniqueWeights.size >= 3) {
                        strengths.push(`Font weight spans ${minW} to ${maxW} across ${uniqueWeights.size} levels — weight effectively reinforces typographic hierarchy alongside size differences.`);
                    }
                }
            }

            // Sub-check D: heading colour as hierarchy signal
            // Headings that share the exact same colour as body text miss a hierarchy dimension.
            // Even a subtle shift darker or toward the brand colour helps.
            {
                const headingEls = textEls.filter(e => ['h1', 'h2', 'h3'].includes(e.tag));
                const bodyEls = textEls.filter(e => ['p', 'li'].includes(e.tag) && e.fontSize >= 13 && e.fontSize <= 20);
                if (headingEls.length >= 2 && bodyEls.length >= 3) {
                    const medianLumaArr = (arr) => {
                        const ls = arr.map(e => luma(e.color[0], e.color[1], e.color[2])).sort((a, b) => a - b);
                        return ls[Math.floor(ls.length / 2)];
                    };
                    const headingLuma = medianLumaArr(headingEls);
                    const bodyLuma = medianLumaArr(bodyEls);
                    const lumaDiff = Math.abs(headingLuma - bodyLuma);
                    if (lumaDiff < 0.05) {
                        findings.push({
                            id: nid(),
                            category: 'Visual Hierarchy',
                            severity: 'info',
                            element: 'Headings and body text share the same colour brightness — a missed hierarchy dimension',
                            issue: `Heading elements (h1–h3) and body text have almost identical text colour brightness (difference: ${Math.round(lumaDiff * 100)}%). Colour is an additional hierarchy axis: headings can be slightly darker (or use a brand colour) to signal higher importance, while captions and labels can be lighter. Without colour differentiation, the entire hierarchy depends on size and weight alone, which becomes harder to perceive at smaller size differences.`,
                            recommendation: 'Set headings to your darkest (or most branded) text colour (e.g. #111 or a brand dark), body text to a mid value (e.g. #333), and secondary labels/captions to a softer tone (e.g. #6b7280). This three-tier colour hierarchy works alongside size and weight to make importance scannable at a glance.',
                            boundingBox: [0, 0, 1000, 1000],
                        });
                    } else if (lumaDiff >= 0.12) {
                        strengths.push('Heading and body text use distinct colour tones — colour reinforces the typographic hierarchy alongside size and weight.');
                    }
                }
            }
        }
    }

    // ── CHECK 7 — Spacing Rhythm ────────────────────────────────────────────────
    {
        const SG = 8;
        const cellW = vpW / SG, cellH = vpH / SG;
        const cellCount = new Array(SG * SG).fill(0);
        for (const el of vis) {
            const ci = Math.min(SG - 1, Math.floor((el.rect.x + el.rect.w / 2) / cellW));
            const ri = Math.min(SG - 1, Math.floor((el.rect.y + el.rect.h / 2) / cellH));
            cellCount[ri * SG + ci]++;
        }
        const sortedCounts = [...cellCount].sort((a, b) => a - b);
        const median = sortedCounts[Math.floor(sortedCounts.length / 2)];
        const mean = cellCount.reduce((s, v) => s + v, 0) / cellCount.length;
        const hotThreshold = Math.max(median * 5, 15);
        const emptyThreshold = Math.max(1, median * 0.1);
        const hotspots = [];
        for (let i = 0; i < SG * SG; i++) {
            if (cellCount[i] > hotThreshold) hotspots.push({ ri: Math.floor(i / SG), ci: i % SG, count: cellCount[i] });
        }

        let spacingFindingPushed = false;

        // Sub-check A: multiple overcrowded zones
        if (hotspots.length >= 7) {
            hotspots.sort((a, b) => b.count - a.count);
            const worst = hotspots[0];
            const v = worst.ri < SG * 0.33 ? 'top' : worst.ri < SG * 0.67 ? 'middle' : 'bottom';
            const hDir = worst.ci < SG * 0.33 ? 'left' : worst.ci < SG * 0.67 ? 'centre' : 'right';
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: hotspots.length >= 10 ? 'warning' : 'info',
                element: `${hotspots.length} overcrowded zone${hotspots.length !== 1 ? 's' : ''} detected — densest in the ${v}-${hDir}`,
                issue: `${hotspots.length} areas of the page pack in significantly more elements than surrounding regions. The most crowded zone (${v}-${hDir}) holds ${worst.count} elements against a page median of ${median}. Dense zones make it hard to read the visual hierarchy because elements compete for the eye rather than guiding it.`,
                recommendation: 'Add more padding inside containers in the crowded zones. Increase margins between sibling elements. Consider moving secondary content (metadata, tags, links) into collapsible sections so the primary content has room to breathe.',
                boundingBox: [
                    Math.round((worst.ri / SG) * 1000),
                    Math.round((worst.ci / SG) * 1000),
                    Math.round(((worst.ri + 1) / SG) * 1000),
                    Math.round(((worst.ci + 1) / SG) * 1000),
                ],
            });
            spacingFindingPushed = true;
        }

        // Sub-check D: overall density is very high — whole page crowded
        const highDensityCells = cellCount.filter(c => c > mean * 2).length;
        if (!spacingFindingPushed && highDensityCells > SG * SG * 0.40) {
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: 'info',
                element: 'High overall element density across the page',
                issue: 'More than 40% of the page area has element density above double the average. Pages with uniformly high density leave little whitespace, which makes it harder to group related content visually and can feel overwhelming on first scan.',
                recommendation: 'Audit whether all visible elements need to be present above the fold. Move secondary content (FAQs, footnotes, related links) further down the page or into expandable sections to let the primary content breathe.',
                boundingBox: [0, 0, 1000, 1000],
            });
            spacingFindingPushed = true;
        }

        if (!spacingFindingPushed) {
            strengths.push('Good spacing throughout — element density is even and there is enough whitespace for content to breathe.');
        }

        // Sub-check F: inconsistent vertical gaps within stacked element groups
        // In a vertical stack of related elements, the gap between each item should
        // be consistent. Irregular gaps imply irregular relationships.
        {
            const stackCandidates = vis.filter(e =>
                e.rect.w >= 80 && e.rect.h >= 16 && e.rect.w < vpW * 0.9
            );
            const stacks = [];
            const usedInStack = new Set();
            const sorted7 = [...stackCandidates].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
            for (const el of sorted7) {
                if (usedInStack.has(el)) continue;
                const group = stackCandidates
                    .filter(o => o !== el && Math.abs(o.rect.x - el.rect.x) < 24)
                    .sort((a, b) => a.rect.y - b.rect.y);
                if (group.length >= 4) {
                    stacks.push([el, ...group]);
                    group.forEach(e => usedInStack.add(e));
                    usedInStack.add(el);
                }
            }
            const unevenStacks = stacks.filter(stack => {
                const s = stack.slice().sort((a, b) => a.rect.y - b.rect.y);
                const gaps = [];
                for (let i = 0; i < s.length - 1; i++) {
                    const gap = s[i + 1].rect.y - (s[i].rect.y + s[i].rect.h);
                    if (gap >= 0 && gap < 120) gaps.push(gap);
                }
                if (gaps.length < 3) return false;
                const avg = gaps.reduce((a, g) => a + g, 0) / gaps.length;
                const maxDev = Math.max(...gaps.map(g => Math.abs(g - avg)));
                return avg > 2 && maxDev / avg > 0.70;
            });
            if (unevenStacks.length >= 3) {
                findings.push({
                    id: nid(),
                    category: 'Spacing & Layout',
                    severity: 'info',
                    element: `${unevenStacks.length} vertical content stack${unevenStacks.length !== 1 ? 's' : ''} have inconsistent gaps between items`,
                    issue: `${unevenStacks.length} groups of vertically stacked elements have varying gaps between items in the same stack. When elements form a visual list, step sequence, or card column, the gaps between them should be uniform — the spacing itself carries meaning. Irregular gaps imply irregular relationships: items that are further apart appear less related even if they semantically belong to the same group.`,
                    recommendation: 'Within any vertical stack of related elements (lists, steps, form rows, card columns), use one consistent gap value throughout the stack. Use a larger gap only when introducing a new semantic group. In CSS: `gap` inside a flex or grid container is the cleanest approach.',
                    boundingBox: toBBox(unevenStacks[0][0].rect, vpW, vpH),
                });
            }
        }
    }

    // ── CHECK 8 — Edge Margin Breathing Room ───────────────────────────────────
    {
        const minMargin = Math.min(vpW, vpH) * 0.035;
        const candidates = vis.filter(e => {
            if (e.rect.w >= vpW * 0.92 || e.rect.h >= vpH * 0.92) return false;
            if (e.rect.y < vpH * 0.07 || e.rect.y + e.rect.h > vpH * 0.93) return false;
            return true;
        });

        const leftEdge = candidates.filter(e => e.rect.x < minMargin);
        const rightEdge = candidates.filter(e => e.rect.x + e.rect.w > vpW - minMargin);
        const topEdge = candidates.filter(e => e.rect.y < vpH * 0.08 && e.rect.y >= 0);
        const edgePressers = [...new Set([...leftEdge, ...rightEdge])];

        let marginFindingPushed = false;

        // Sub-check A: high total count pressing any horizontal edge
        if (edgePressers.length > 20) {
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: edgePressers.length > 40 ? 'warning' : 'info',
                element: `${edgePressers.length} content elements sit within ${Math.round(minMargin)}px of the left or right screen edge`,
                issue: `${edgePressers.length} elements press against the horizontal edges of the viewport with almost no margin. On a 1440px screen this is within ${Math.round(minMargin)}px — barely a sliver of space. The page looks uncontained, as if content is trying to escape the screen.`,
                recommendation: 'Apply a consistent horizontal content wrapper with at least 48px padding on each side for desktop viewports. A max-width container (e.g. 1200px centred) prevents content from ever reaching the screen edge.',
                boundingBox: toBBox(edgePressers[0].rect, vpW, vpH),
            });
            marginFindingPushed = true;
        }

        // Sub-check B: asymmetric left vs right margins
        if (candidates.length >= 10) {
            const leftRatio = leftEdge.length / candidates.length;
            const rightRatio = rightEdge.length / candidates.length;
            const asymmetry = Math.abs(leftRatio - rightRatio);
            if (asymmetry > 0.15 && (leftEdge.length >= 5 || rightEdge.length >= 5)) {
                const heavierSide = leftRatio > rightRatio ? 'left' : 'right';
                const lighterSide = heavierSide === 'left' ? 'right' : 'left';
                findings.push({
                    id: nid(),
                    category: 'Spacing & Layout',
                    severity: 'info',
                    element: `Asymmetric margins — more content presses the ${heavierSide} edge than the ${lighterSide}`,
                    issue: `The ${heavierSide} side has noticeably more elements near the viewport edge than the ${lighterSide} side. Asymmetric edge pressure often means the content container is not properly centred, or a sidebar or sticky panel is pushing one side closer to the boundary. This gives the page a skewed or unconstrained feel.`,
                    recommendation: `Check that your main content wrapper is centred and consistent. If there is a sidebar on the ${heavierSide}, ensure it has its own margin rather than using the viewport edge as its boundary.`,
                    boundingBox: heavierSide === 'left' ? [0, 0, 1000, 200] : [0, 800, 1000, 1000],
                });
                marginFindingPushed = true;
            }
        }

        // Sub-check C: moderate edge pressure (5–15 elements)
        if (!marginFindingPushed && edgePressers.length >= 5) {
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: 'info',
                element: `${edgePressers.length} elements sit close to the screen edge with minimal margin`,
                issue: `${edgePressers.length} elements are very close to the viewport boundary. While not severe, this can look unpolished and creates potential clipping problems on slightly narrower screens or when the browser has scrollbar width variations.`,
                recommendation: 'Add a minimum horizontal margin of 24–32px to content that sits near the viewport edge. Using a CSS max-width container with auto margins is the safest approach.',
                boundingBox: toBBox(edgePressers[0].rect, vpW, vpH),
            });
            marginFindingPushed = true;
        }

        if (!marginFindingPushed) {
            strengths.push('Good margins around content — the page feels properly contained with comfortable space on all sides.');
        }
    }

    // ── CHECK 9 — Vertical Weight Distribution ──────────────────────────────────
    {
        const third = vpH / 3;
        let topW = 0, midW = 0, botW = 0;
        for (const el of vis) {
            const cy = el.rect.y + el.rect.h / 2;
            // Same image fix: use mid-tone estimate so photos and CSS background-image sections have weight
            const bgL = (el.tag === 'img' || el.hasBackgroundImage) ? 0.35 : luma(el.bg[0], el.bg[1], el.bg[2]);
            // Density factor: a packed section feels vertically heavier than a sparse one
            const w = (el.rect.w * el.rect.h) / (vpW * vpH) * (1 - bgL) * (densityFactor.get(el) ?? 1.0);
            if (cy < third) topW += w;
            else if (cy < third * 2) midW += w;
            else botW += w;
        }
        const botVsMid = midW > 0 ? botW / midW : 1;
        const topVsBot = botW > 0 ? topW / botW : 1;
        if (botVsMid > 1.8 && botW > topW) {
            findings.push({
                id: nid(),
                category: 'Visual Weight',
                severity: botVsMid > 2.5 ? 'warning' : 'info',
                element: 'Bottom section feels heavier than the rest',
                issue: 'The bottom section of the page has more visual weight than the top. Most pages have a strong start and lighter content as you scroll down. When the bottom feels heavier, the layout can feel off-balance.',
                recommendation: 'Lighten the bottom section: use less bold text, reduce element density, or use a slightly lighter background. Make sure your footer is not drawing more attention than your main headline or button.',
                boundingBox: [Math.round(third * 2 / vpH * 1000), 0, 1000, 1000],
            });
        } else if (topVsBot >= 1.1 && topVsBot <= 3.0) {
            strengths.push('The page is well-balanced top to bottom — more visual interest at the top naturally guides the eye down the page.');
        }

    }

    // ── CHECK 10 — Simultaneous Contrast ──────────────────────────────────────
    {
        let vibEdges = 0, chromaEdges = 0;
        let highSatCount = 0, totalSatChecked = 0;
        const clashZones = [];
        const sample = vis.length > 150 ? vis.slice(0, 150) : vis;
        for (let i = 0; i < sample.length; i++) {
            for (let j = i + 1; j < Math.min(i + 8, sample.length); j++) {
                const a = sample[i], b = sample[j];
                const hGap = Math.max(0, Math.max(a.rect.x, b.rect.x) - Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w));
                const vGap = Math.max(0, Math.max(a.rect.y, b.rect.y) - Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h));
                if (hGap > 8 || vGap > 8) continue;
                const [ha, sa, la] = rgbToHsl(a.bg[0], a.bg[1], a.bg[2]);
                const [hb, sb, lb] = rgbToHsl(b.bg[0], b.bg[1], b.bg[2]);
                if (sa < 0.35 || sb < 0.35 || la < 0.1 || la > 0.92 || lb < 0.1 || lb > 0.92) continue;
                chromaEdges++;
                const hdiff = Math.min(Math.abs(ha - hb), 1 - Math.abs(ha - hb));
                if (hdiff >= 0.28 && hdiff <= 0.65) {
                    vibEdges++;
                    clashZones.push({ a, b });
                }
            }
        }

        // Collect overall saturation levels
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [, s, l] = rgbToHsl(c[0], c[1], c[2]);
                if (l > 0.1 && l < 0.9) {
                    totalSatChecked++;
                    if (s > 0.75) highSatCount++;
                }
            }
        }

        let contrastFindingPushed = false;

        // Sub-check A: classical vibrating edge pairs (complementary vivid adjacency)
        if (chromaEdges > 5) {
            const vibRatio = vibEdges / chromaEdges;
            if (vibRatio > 0.50) {
                const worstZone = clashZones[0];
                const zoneLabel = worstZone ? zoneDesc(
                    worstZone.a.rect.x + worstZone.a.rect.w / 2,
                    worstZone.a.rect.y + worstZone.a.rect.h / 2, vpW, vpH
                ) : 'unknown';
                findings.push({
                    id: nid(),
                    category: 'Readability',
                    severity: 'warning',
                    element: `${vibEdges} clashing colour pair${vibEdges !== 1 ? 's' : ''} — vivid opposite hues touching directly (worst: ${zoneLabel})`,
                    issue: `${vibEdges} adjacent element pairs place vivid complementary colours (such as saturated red/cyan or orange/blue) directly against each other. When opposite saturated colours meet, the edge between them appears to shimmer or vibrate due to simultaneous contrast — the eye cannot reconcile two competing colour signals at the same boundary.`,
                    recommendation: 'Reduce saturation on at least one of each clashing pair to below 60%, or insert a neutral separator (white, grey, or black line) between them. Alternatively, ensure one colour is significantly lighter or darker than the other so only one dimension clashes at a time.',
                    boundingBox: worstZone ? toBBox(worstZone.a.rect, vpW, vpH) : undefined,
                });
                contrastFindingPushed = true;
            } else if (vibRatio > 0.20) {
                findings.push({
                    id: nid(),
                    category: 'Readability',
                    severity: 'info',
                    element: `${vibEdges} moderate colour clash${vibEdges !== 1 ? 'es' : ''} — vivid colours with opposing hues sit close together`,
                    issue: `${vibEdges} pairs of neighbouring elements use vivid colours on opposite sides of the colour wheel. These are not severe clashes but they can cause mild simultaneous contrast effects where each colour makes the other appear slightly different from how it looks in isolation.`,
                    recommendation: 'Consider reducing saturation on decorative elements to 40–60% so they do not compete visually with interactive elements that rely on vivid colour to draw attention.',
                    boundingBox: clashZones.length > 0 ? toBBox(clashZones[0].a.rect, vpW, vpH) : undefined,
                });
                contrastFindingPushed = true;
            }
        }

        if (!contrastFindingPushed && chromaEdges > 5) {
            strengths.push('Vivid colour pairs are well-separated — no clashing edges that could cause the shimmer effect.');
        }
    }

    // ── CHECK 11 — Grid Alignment Signal ──────────────────────────────────────
    {
        const alignCandidates = vis.filter(e => e.rect.w < vpW * 0.85 && e.rect.w > 20);
        const leftEdges = alignCandidates.map(e => Math.round(e.rect.x / 8) * 8);
        const rightEdges = alignCandidates.map(e => Math.round((e.rect.x + e.rect.w) / 8) * 8);

        let alignFindingPushed = false;

        if (leftEdges.length >= 10) {
            // Left-edge concentration analysis
            const leftCounts = {};
            leftEdges.forEach(x => { leftCounts[x] = (leftCounts[x] || 0) + 1; });
            const leftValues = Object.values(leftCounts).sort((a, b) => b - a);
            const leftTop5 = leftValues.slice(0, 5).reduce((s, v) => s + v, 0);
            const leftConcentration = leftTop5 / leftEdges.length;
            const leftPeaks = leftValues.filter(v => v >= Math.max(3, leftValues[0] * 0.4)).length;

            // Right-edge concentration analysis
            const rightCounts = {};
            rightEdges.forEach(x => { rightCounts[x] = (rightCounts[x] || 0) + 1; });
            const rightValues = Object.values(rightCounts).sort((a, b) => b - a);
            const rightTop5 = rightValues.slice(0, 5).reduce((s, v) => s + v, 0);
            const rightConcentration = rightTop5 / rightEdges.length;

            // Sub-check A: no consistent column structure (sparse left-edge alignment)
            if (leftConcentration < 0.22 && leftPeaks < 2) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'info',
                    element: `Weak column structure — left edges scatter across ${Object.keys(leftCounts).length} different positions`,
                    issue: `Elements across the page start at ${Object.keys(leftCounts).length} different horizontal positions, with only ${Math.round(leftConcentration * 100)}% aligning to the top 5 positions. When left edges do not share consistent x-coordinates, the layout reads as a collection of individually placed items rather than a structured grid. Even well-designed components can look disorganised together.`,
                    recommendation: 'Align all block-level content to a shared 12 or 16-column grid. Pick 2–4 consistent left-edge positions and apply them to all content areas. Design tools like Figma grids or CSS Grid make this straightforward.',
                    boundingBox: [0, 0, 1000, 1000],
                });
                alignFindingPushed = true;
            }

            // Sub-check C: too many column peaks — over-fragmented grid
            if (leftConcentration >= 0.22 && leftPeaks > 10) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'info',
                    element: `${leftPeaks} distinct column positions detected — grid may be over-fragmented`,
                    issue: `Elements align to ${leftPeaks} distinct left-edge positions. While this shows grid awareness, too many column lines can make the layout feel busy and can break visual grouping — elements in nearby columns may not look related even when they are semantically connected.`,
                    recommendation: 'Consolidate to a maximum of 4–6 primary column positions. Group related content into the same column alignment so visual proximity reinforces semantic grouping.',
                    boundingBox: [0, 0, 1000, 1000],
                });
                alignFindingPushed = true;
            }

            // Sub-check E: row-level vertical alignment
            // Per alignment theory: elements sharing the same horizontal row should align
            // on a common top, centre, or bottom axis. Misaligned rows look unpolished
            // even when every individual element looks fine in isolation.
            {
                const rowThreshold = 20; // px — elements whose y-centres are within this range share a row.
                // Intentionally NOT updated after each addition to prevent
                // the row centre from drifting across multiple visual rows.
                const rows = [];
                const sortedByY = [...alignCandidates].sort((a, b) =>
                    (a.rect.y + a.rect.h / 2) - (b.rect.y + b.rect.h / 2)
                );
                for (const el of sortedByY) {
                    const cy = el.rect.y + el.rect.h / 2;
                    const row = rows.find(r => Math.abs(r.cy - cy) < rowThreshold);
                    if (row) { row.els.push(el); } // cy stays fixed — no drift
                    else rows.push({ cy, els: [el] });
                }
                const spread = (arr) => Math.max(...arr) - Math.min(...arr);
                const misalignedRows = rows.filter(row => {
                    if (row.els.length < 4) return false; // need a meaningful-sized row
                    const tops = row.els.map(e => e.rect.y);
                    const centers = row.els.map(e => e.rect.y + e.rect.h / 2);
                    const bottoms = row.els.map(e => e.rect.y + e.rect.h);
                    // Take the tightest alignment mode; if even the best is still scattered, it's misaligned.
                    // 22px threshold accommodates intentional mixed-height rows (e.g. icon + label pairs).
                    const best = Math.min(spread(tops), spread(centers), spread(bottoms));
                    return best > 22;
                });
                if (!alignFindingPushed && misalignedRows.length >= 3) {
                    const worst = misalignedRows.reduce((a, b) => {
                        const sp = (row) => {
                            const tops = row.els.map(e => e.rect.y);
                            const ctrs = row.els.map(e => e.rect.y + e.rect.h / 2);
                            const bots = row.els.map(e => e.rect.y + e.rect.h);
                            return Math.min(spread(tops), spread(ctrs), spread(bots));
                        };
                        return sp(b) > sp(a) ? b : a;
                    });
                    const worstSpread = Math.round(Math.min(
                        spread(worst.els.map(e => e.rect.y)),
                        spread(worst.els.map(e => e.rect.y + e.rect.h / 2)),
                        spread(worst.els.map(e => e.rect.y + e.rect.h))
                    ));
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: misalignedRows.length >= 5 ? 'warning' : 'info',
                        element: `${misalignedRows.length} row${misalignedRows.length !== 1 ? 's' : ''} of elements are not vertically aligned (worst row: ${worstSpread}px spread across ${worst.els.length} elements)`,
                        issue: `${misalignedRows.length} groups of elements that appear to form a horizontal row do not share a common top, centre, or bottom alignment. The worst row has a vertical spread of ${worstSpread}px across ${worst.els.length} elements. Even when individual elements look good on their own, misaligned rows make the overall layout read as unpolished because the eye naturally expects row elements to sit on a shared invisible axis.`,
                        recommendation: 'For each row of elements, choose one alignment mode: align tops when elements have very different heights (e.g. a mix of icons and text blocks), align centres when heights are similar, or align bottoms when elements connect to a baseline. In CSS Flexbox this is \`align-items: flex-start | center | flex-end\`. In CSS Grid, use \`align-items\` on the grid container.',
                        boundingBox: toBBox(worst.els[0].rect, vpW, vpH),
                    });
                    alignFindingPushed = true;
                }
            }

            // Sub-check F: centred or right-aligned body text
            // Per alignment theory: left alignment is optimal for multi-line body text in LTR
            // interfaces. Centred or right-aligned body text requires the eye to find a new
            // starting position on each line, reducing reading speed after a few lines.
            {
                const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
                const bodyTextEls = vis.filter(e =>
                    e.isText &&
                    !HEADING_TAGS.has(e.tag) &&
                    e.fontSize >= 13 &&
                    e.fontSize <= 22 &&
                    e.rect.w >= 280
                );
                const centredBody = bodyTextEls.filter(e => e.textAlign === 'center');
                const rightAligned = bodyTextEls.filter(e => e.textAlign === 'right');
                if (centredBody.length >= 3) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: centredBody.length >= 6 ? 'warning' : 'info',
                        element: `${centredBody.length} body text block${centredBody.length !== 1 ? 's' : ''} use centre alignment`,
                        issue: `${centredBody.length} paragraph-width text blocks are centre-aligned. Centre alignment is appropriate for short headings and callout text, but for multi-line body content it requires the eye to find a different starting position on every line, which noticeably reduces reading speed. Most readers process left-aligned body text faster because each line reliably begins at the same x-position.`,
                        recommendation: 'Switch body text and paragraph content to left alignment (\`text-align: left\`). Reserve centre alignment for headings, hero taglines, and single-line callouts where the eye does not need to track back across multiple lines.',
                    });
                    alignFindingPushed = true;
                }
                if (!alignFindingPushed && rightAligned.length >= 3) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'warning',
                        element: `${rightAligned.length} body text block${rightAligned.length !== 1 ? 's' : ''} use right alignment`,
                        issue: `${rightAligned.length} body text blocks are right-aligned. Right alignment is occasionally used for captions, pull quotes, or table cells, but applied to paragraph content it is one of the most readability-damaging alignment choices in LTR languages. The eye must search for each new line start, making even short passages noticeably harder to read.`,
                        recommendation: 'Switch to left alignment (\`text-align: left\`) for all body text. Right alignment should be reserved for specific UI elements like currency values in table columns, timestamps, or short labels that sit opposite a left-aligned counterpart.',
                    });
                    alignFindingPushed = true;
                }
            }

            if (!alignFindingPushed && leftConcentration >= 0.30 && leftPeaks >= 2 && leftPeaks <= 8) {
                strengths.push(`Good grid structure — elements align to ${leftPeaks} consistent column positions, giving the layout an organised, deliberate feel.`);
            }
        }
    }

    // ── CHECK 12 — Colour Temperature Consistency ─────────────────────────────
    {
        let shSin = 0, shCos = 0, shN = 0, hiSin = 0, hiCos = 0, hiN = 0;
        let warmCount = 0, coolCount = 0, neutralCount = 0;
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
                if (s < 0.1) { neutralCount++; continue; }
                const angle = h * 2 * Math.PI;
                if (l < 0.25) { shSin += Math.sin(angle); shCos += Math.cos(angle); shN++; }
                else if (l > 0.70) { hiSin += Math.sin(angle); hiCos += Math.cos(angle); hiN++; }
                // classify overall temperature
                if (h < 0.17 || h > 0.88) warmCount++;
                else if (h > 0.50 && h < 0.72) coolCount++;
            }
        }
        const totalChromatic = warmCount + coolCount;
        const isWarm = (h) => h < 0.17 || h > 0.88;
        const isCool = (h) => h > 0.50 && h < 0.72;

        let tempFindingPushed = false;

        if (shN >= 5 && hiN >= 5 && !tempFindingPushed) {
            const shMean = ((Math.atan2(shSin / shN, shCos / shN) / (2 * Math.PI)) + 1) % 1;
            const hiMean = ((Math.atan2(hiSin / hiN, hiCos / hiN) / (2 * Math.PI)) + 1) % 1;
            const wrapped = Math.min(Math.abs(shMean - hiMean), 1 - Math.abs(shMean - hiMean));

            // Sub-check C: jarring extreme temperature shift
            if (!tempFindingPushed && wrapped > 0.25) {
                findings.push({
                    id: nid(),
                    category: 'Colour Palette',
                    severity: 'info',
                    element: `Strong temperature clash between light and dark zones (shift: ${Math.round(wrapped * 360)}° on the colour wheel)`,
                    issue: `There is a ${Math.round(wrapped * 360)}° hue shift between the colour temperature of light elements and dark elements — much larger than the subtle contrast typically used in professional design. A shift this extreme can make the page feel like two separate designs and can interfere with perceived lighting and depth cues.`,
                    recommendation: 'Reduce the temperature shift between light and dark zones. The sweet spot is a subtle 30–80° shift (e.g. warm cream highlights vs cool blue-greys in shadows). Shifts over 120° tend to feel jarring unless the design intent is deliberately high-contrast or experimental.',
                    boundingBox: [0, 0, 1000, 1000],
                });
                tempFindingPushed = true;
            }
        }

        // Sub-check D: all chromatic values are exclusively warm — no cool contrast
        if (!tempFindingPushed && totalChromatic >= 8 && coolCount === 0 && warmCount >= 8) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: 'Palette is entirely warm — no cool tones to provide temperature contrast',
                issue: 'Every chromatic element on the page is in the warm range (reds, oranges, yellows, warm browns). While warm palettes can convey energy and approachability, a palette with zero cool tones has no temperature contrast. Temperature contrast is what gives a design a sense of depth and makes warm elements feel more vivid by comparison.',
                recommendation: 'Introduce at least one cool tone — even a slightly blue-grey for borders or text, or a cool white for backgrounds. The contrast between a warm accent and a cool neutral makes both more effective.',
                boundingBox: [0, 0, 1000, 1000],
            });
            tempFindingPushed = true;
        }

        // Sub-check E: all chromatic values are exclusively cool — no warm contrast
        if (!tempFindingPushed && totalChromatic >= 8 && warmCount === 0 && coolCount >= 8) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: 'Palette is entirely cool — no warm tones to provide temperature contrast',
                issue: 'Every chromatic colour on the page sits in the cool range (blues, blue-greens, purples). An all-cool palette can feel calm and professional, but without any warm tones for contrast it can also feel cold or clinical. Temperature contrast makes cool colours appear cooler and accent elements more striking.',
                recommendation: 'Consider adding a single warm accent — a muted amber, gold, or terracotta — to provide temperature contrast for your primary call-to-action or brand accent. It does not need to be vivid; even a soft warm tone against the cool background creates effective contrast.',
                boundingBox: [0, 0, 1000, 1000],
            });
            tempFindingPushed = true;
        }

        if (!tempFindingPushed && shN >= 5 && hiN >= 5) {
            const shMeanFinal = ((Math.atan2(shSin / shN, shCos / shN) / (2 * Math.PI)) + 1) % 1;
            const hiMeanFinal = ((Math.atan2(hiSin / hiN, hiCos / hiN) / (2 * Math.PI)) + 1) % 1;
            const wrappedFinal = Math.min(Math.abs(shMeanFinal - hiMeanFinal), 1 - Math.abs(shMeanFinal - hiMeanFinal));
            if (wrappedFinal >= 0.07 && wrappedFinal <= 0.22 &&
                ((isWarm(shMeanFinal) && isCool(hiMeanFinal)) || (isCool(shMeanFinal) && isWarm(hiMeanFinal)))) {
                strengths.push('Light and dark zones use contrasting colour temperatures — warm highlights against cool shadows (or vice versa) gives the palette depth and richness.');
            }
        }
    }

    // ── CHECK 13 — Line Length ──────────────────────────────────────────────────
    // Source: Refactoring UI — "Line Length Thresholds"
    // Optimal reading line: 45–75 characters. Estimated from rect.w / (fontSize × 0.55).
    {
        const charWidthFactor = 0.55;
        const maxChars = 75;
        const minChars = 45;
        const bodyFontMin = 13;
        const bodyFontMax = 22;
        const minWidth = 200;
        const minViolations = 4;
        const warningCount = 6;
        const bodyText = vis.filter(e =>
            e.isText &&
            e.fontSize >= bodyFontMin &&
            e.fontSize <= bodyFontMax &&
            e.rect.w >= minWidth
        );
        const estCharsPerLine = (e) => e.rect.w / (e.fontSize * charWidthFactor);
        const tooWide = bodyText.filter(e => estCharsPerLine(e) > maxChars);
        // Only count elements tall enough to hold at least 5 wrapped lines —
        // multi-column feature-card captions (2–4 lines) are intentionally short-form
        // and should not be counted as a reading-flow problem.
        const tooNarrow = bodyText.filter(e =>
            estCharsPerLine(e) < minChars && e.rect.h > e.fontSize * 5
        );

        let lineFindingPushed = false;

        // Sub-check A: too-narrow text blocks (choppy reading)
        if (tooNarrow.length >= minViolations) {
            const worst = tooNarrow.reduce((a, b) => estCharsPerLine(b) < estCharsPerLine(a) ? b : a);
            const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
            const estChars = Math.round(estCharsPerLine(worst));
            const worstLabel = elQ(worst) || zone;
            findings.push({
                id: nid(),
                category: 'Typography',
                severity: tooNarrow.length >= warningCount ? 'warning' : 'info',
                element: `${tooNarrow.length} text block${tooNarrow.length !== 1 ? 's' : ''} are too narrow — estimated ~${estChars} characters per line (worst: ${worstLabel})`,
                issue: `${tooNarrow.length} text areas appear to be under 45 characters wide per line. Lines this short cause frequent line breaks, forcing the eye to jump back to the left margin far too often. This fragments reading flow and makes prose feel choppy, like a list of sentence fragments rather than connected paragraphs.`,
                recommendation: 'Widen text containers to fit at least 45–55 characters per line. In CSS this is typically a min-width of about 25–30ch. If a column layout is forcing narrow text, consider increasing column widths or reducing the number of columns.',
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
            lineFindingPushed = true;
        }

        // Sub-check B: mixed — some blocks too wide AND some too narrow on the same page
        if (tooWide.length >= minViolations && tooNarrow.length >= minViolations) {
            findings.push({
                id: nid(),
                category: 'Typography',
                severity: 'warning',
                element: `Inconsistent line lengths — ${tooWide.length} text block${tooWide.length !== 1 ? 's' : ''} too wide and ${tooNarrow.length} too narrow simultaneously`,
                issue: `The page has both over-wide text areas (estimated >75 characters per line) and over-narrow text areas (<45 characters) at the same time. This inconsistency suggests text widths are not controlled by a consistent layout system. Reading from one section to another requires constant visual re-adjustment.`,
                recommendation: 'Define a consistent content width for body text — typically 55–70ch or equivalent pixel width — and apply it uniformly to all prose sections. Headings and UI elements can deviate, but paragraph text should feel consistent in width throughout.',
                boundingBox: toBBox(tooNarrow.length > 0 ? tooNarrow[0].rect : tooWide[0].rect, vpW, vpH),
            });
            lineFindingPushed = true;
        }

        // Sub-check C: heading elements that are excessively wide
        const headingTags = ['h1', 'h2', 'h3'];
        const wideHeadings = vis.filter(e =>
            headingTags.includes(e.tag) &&
            e.fontSize >= 24 &&
            e.rect.w >= 600 &&
            estCharsPerLine(e) > 85
        );
        if (wideHeadings.length >= 2) {
            const worst = wideHeadings.reduce((a, b) => estCharsPerLine(b) > estCharsPerLine(a) ? b : a);
            const estChars = Math.round(estCharsPerLine(worst));
            findings.push({
                id: nid(),
                category: 'Typography',
                severity: 'info',
                element: `${wideHeadings.length} heading element${wideHeadings.length !== 1 ? 's' : ''} span very long estimated line lengths (~${estChars} characters)`,
                issue: `${wideHeadings.length} headings appear to span around ${estChars} characters or more. Very wide headings are harder to read at a glance because the eye must travel far across the line to take in the full title. Headings are meant to be scanned, not read word by word.`,
                recommendation: 'Consider capping heading widths at 20–30 words, or using a larger font size so the container width corresponds to fewer characters per line. Short, punchy headings in slightly larger type are easier to absorb.',
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
            lineFindingPushed = true;
        }

        if (tooWide.length >= minViolations) {
            const worst = tooWide.reduce((a, b) =>
                (b.rect.w / (b.fontSize * charWidthFactor)) >
                    (a.rect.w / (a.fontSize * charWidthFactor)) ? b : a
            );
            findings.push({
                id: nid(),
                category: 'Typography',
                severity: tooWide.length >= warningCount ? 'warning' : 'info',
                element: `${tooWide.length} text block${tooWide.length !== 1 ? 's' : ''} wider than a comfortable reading width`,
                issue: `${tooWide.length} text area${tooWide.length !== 1 ? 's' : ''} appear to have lines longer than about 75 characters. Long lines make it hard for the eye to track back from the end of one line to the start of the next, which slows reading and can cause the eye to land on the wrong line.`,
                recommendation: 'Try constraining paragraph and body text to a max-width of around 60 to 70 characters wide. In CSS this is typically somewhere between 55ch and 75ch. Headings can stay wider.',
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
            lineFindingPushed = true;
        }

        if (!lineFindingPushed && bodyText.length >= 3) {
            strengths.push('Text blocks are a comfortable width for reading — line lengths are within the 45–75 character optimal range.');
        }
    }

    // ── CHECK 14 — Grey Temperature Tinting ───────────────────────────────────
    // Source: Refactoring UI — "Grey Temperature Tinting"
    // When an interface has a primary colour, pure neutral greys can look
    // disconnected. Greys should carry a hint of the primary hue.
    {
        const greySatMax = 0.06;
        const greyLumaMin = 0.15;
        const greyLumaMax = 0.85;
        const chromaticSatMin = 0.25;
        const minChromatic = 10;
        const minGreys = 5;
        const tintedSatMin = 0.03;
        const wrongTempThreshold = 0.25; // hue distance to call a tint "wrong temperature"
        const chromaticSamples = [];
        const greySats = [];
        const greyHints = []; // any sub-threshold saturation still carries hue info
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
                if (s >= chromaticSatMin && l > 0.1 && l < 0.9) {
                    chromaticSamples.push(h);
                }
                if (s < greySatMax && l >= greyLumaMin && l <= greyLumaMax) {
                    greySats.push(s);
                    if (s >= 0.01) greyHints.push(h); // has some hue direction
                }
            }
        }

        let greyFindingPushed = false;

        // Sub-check A: primary colour exists but greys have no tint at all
        if (chromaticSamples.length >= minChromatic && greySats.length >= minGreys) {
            const avgGreySat = greySats.reduce((a, s) => a + s, 0) / greySats.length;

            if (avgGreySat < tintedSatMin) {
                findings.push({
                    id: nid(),
                    category: 'Colour Palette',
                    severity: 'info',
                    element: `Grey surfaces are completely neutral (avg saturation: ${(avgGreySat * 100).toFixed(1)}%) despite a defined primary colour`,
                    issue: `The interface has a clear primary colour (found ${chromaticSamples.length} chromatic samples) but ${greySats.length} grey values — backgrounds, borders, and surfaces — are pure neutral grey with average saturation of just ${(avgGreySat * 100).toFixed(1)}%. Pure neutral greys next to a vivid primary can feel cold or disconnected, as if the surfaces belong to a different design system than the accent colours.`,
                    recommendation: 'Add a subtle tint of your primary hue to grey surfaces. Even 2–4% saturation is perceptible and creates cohesion. In practice: if your primary is blue, use #F3F5F8 instead of #F5F5F5 for card backgrounds. The difference is subtle but makes the palette feel unified.',
                    boundingBox: [0, 0, 1000, 1000],
                });
                greyFindingPushed = true;
            }

            // Sub-check B: greys have a tint, but it is the wrong temperature relative to the primary
            if (!greyFindingPushed && greyHints.length >= 3 && chromaticSamples.length >= minChromatic) {
                // Circular mean of primary hues
                const pSin = chromaticSamples.reduce((s, h) => s + Math.sin(h * 2 * Math.PI), 0);
                const pCos = chromaticSamples.reduce((s, h) => s + Math.cos(h * 2 * Math.PI), 0);
                const primaryMean = ((Math.atan2(pSin / chromaticSamples.length, pCos / chromaticSamples.length) / (2 * Math.PI)) + 1) % 1;
                // Circular mean of grey hint hues
                const gSin = greyHints.reduce((s, h) => s + Math.sin(h * 2 * Math.PI), 0);
                const gCos = greyHints.reduce((s, h) => s + Math.cos(h * 2 * Math.PI), 0);
                const greyMean = ((Math.atan2(gSin / greyHints.length, gCos / greyHints.length) / (2 * Math.PI)) + 1) % 1;
                const hueDist = Math.min(Math.abs(primaryMean - greyMean), 1 - Math.abs(primaryMean - greyMean));
                if (hueDist > wrongTempThreshold) {
                    const primaryDeg = Math.round(primaryMean * 360);
                    const greyDeg = Math.round(greyMean * 360);
                    findings.push({
                        id: nid(),
                        category: 'Colour Palette',
                        severity: 'info',
                        element: `Grey tint is the wrong temperature — greys lean toward ${greyDeg}° while the primary sits at ${primaryDeg}°`,
                        issue: `The grey surfaces do carry a slight colour tint, but that tint points toward a different part of the colour wheel (${greyDeg}°) than the primary colour family (${primaryDeg}°). When grey tints pull in a different direction from the primary, the palette can feel subtly dissonant — as if warm and cool aren't quite agreeing.`,
                        recommendation: `Shift the tint on grey surfaces closer to your primary hue direction (${primaryDeg}°). If the primary is a warm amber, greys should lean slightly warm. If it is a cool blue, greys should lean slightly cool. The goal is for the whole palette to feel like it exists in the same light.`,
                        boundingBox: [0, 0, 1000, 1000],
                    });
                    greyFindingPushed = true;
                }
            }
        }

        // Sub-check D: greys are correctly tinted — positive signal
        if (!greyFindingPushed && chromaticSamples.length >= minChromatic && greySats.length >= minGreys) {
            const avgGreySat = greySats.reduce((a, s) => a + s, 0) / greySats.length;
            if (avgGreySat >= tintedSatMin) {
                strengths.push(`Grey surfaces carry a subtle hue tint (avg saturation: ${(avgGreySat * 100).toFixed(1)}%), creating cohesion with the primary colour palette.`);
            }
        }
    }

    // ── CHECK 15 — Interactive Affordance ─────────────────────────────────────
    // Buttons should be visually distinct from the page background.
    // Links should be a different colour from surrounding body text.
    {
        const largeBgEls = vis.filter(e => e.rect.w > vpW * 0.4 && e.rect.h > vpH * 0.1);
        const pgBgL = largeBgEls.length > 0
            ? largeBgEls.reduce((s, e) => s + luma(e.bg[0], e.bg[1], e.bg[2]), 0) / largeBgEls.length
            : 0.95;

        // Ghost button check: button background nearly same luminance as page background
        const buttons = vis.filter(e => e.tag === 'button' && e.rect.w > 30 && e.rect.h > 20);
        const ghostButtons = buttons.filter(e => Math.abs(luma(e.bg[0], e.bg[1], e.bg[2]) - pgBgL) < 0.08);
        const ghostRatio = buttons.length > 0 ? ghostButtons.length / buttons.length : 0;
        if (ghostButtons.length > 0 && (ghostRatio === 1 || (ghostRatio > 0.60 && buttons.length >= 2))) {
            findings.push({
                id: nid(),
                category: 'Visual Hierarchy',
                severity: ghostRatio > 0.80 ? 'warning' : 'info',
                element: `${ghostButtons.length} of ${buttons.length} button${buttons.length !== 1 ? 's' : ''} have no visible fill (ghost buttons)`,
                issue: `${ghostButtons.length} button${ghostButtons.length !== 1 ? 's' : ''} blend into the page background rather than standing out as interactive elements. Ghost buttons rely on users already knowing where to click and are much harder to recognise as actionable, especially on mobile or for first-time visitors.`,
                recommendation: 'Give primary buttons a solid background that clearly separates them from the page. Ghost buttons (border-only style) are acceptable for secondary actions alongside a solid primary, but should not be the dominant button style.',
                boundingBox: toBBox(ghostButtons[0].rect, vpW, vpH),
            });
        } else if (buttons.length >= 3) {
            strengths.push('Buttons are visually distinct from the page background and easy to recognise as interactive.');
        }

        // Link colour vs body text: links should not be indistinguishable from static text
        const links = textEls.filter(e => e.tag === 'a' && e.rect.w > 10);
        const bodyTexts = textEls.filter(e => ['p', 'li', 'td', 'span'].includes(e.tag));
        if (links.length >= 3 && bodyTexts.length >= 5) {
            const medianVal = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
            const linkHues = links.map(e => rgbToHsl(e.color[0], e.color[1], e.color[2])[0]);
            const bodyHues = bodyTexts.map(e => rgbToHsl(e.color[0], e.color[1], e.color[2])[0]);
            const linkLumas = links.map(e => luma(e.color[0], e.color[1], e.color[2]));
            const bodyLumas = bodyTexts.map(e => luma(e.color[0], e.color[1], e.color[2]));
            const hueDiff = Math.min(
                Math.abs(medianVal(linkHues) - medianVal(bodyHues)),
                1 - Math.abs(medianVal(linkHues) - medianVal(bodyHues))
            );
            const lumaDiff = Math.abs(medianVal(linkLumas) - medianVal(bodyLumas));
            if (hueDiff < 0.05 && lumaDiff < 0.10) {
                const linksWithUnderline = links.filter(e => (e.textDecoration || 'none').includes('underline'));
                const hasUnderlineFallback = linksWithUnderline.length >= links.length * 0.7;
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: hasUnderlineFallback ? 'info' : 'warning',
                    element: hasUnderlineFallback
                        ? 'Links rely solely on underline to differ from body text — no colour distinction'
                        : 'Links are indistinguishable from body text — same colour and no underline',
                    issue: hasUnderlineFallback
                        ? 'Links are the same colour as surrounding body text and only distinguishable by their underline decoration. While underlines signal clickability, sighted users scanning a dense page may miss inline links that share the same colour as static text, especially at small sizes or low contrast.'
                        : 'Link text shares nearly the same hue and brightness as the body text around it. Without a clear colour signal or underline, users cannot identify which text is clickable without hovering, and on mobile or keyboard navigation they may miss links entirely.',
                    recommendation: hasUnderlineFallback
                        ? 'Add a distinct colour to links — even your brand primary or a conventional blue alongside the underline doubles the affordance signal and makes links scannable at a glance without needing to read every word.'
                        : 'Use a clearly distinct colour for links, typically your brand primary or conventional blue. If you prefer subtle links, add an underline as a minimum so they are always distinguishable from static text regardless of hover state.',
                    boundingBox: toBBox(links[0].rect, vpW, vpH),
                });
            }
        }

        // Sub-check C: primary vs secondary button distinction
        // A design with all buttons at the same visual weight has no way to
        // communicate which action is the recommended or primary choice.
        {
            const solidBtns = vis.filter(e => e.tag === 'button' && e.rect.w > 40 && e.rect.h > 20);
            if (solidBtns.length >= 4) {
                const btnLumas = solidBtns.map(e => luma(e.bg[0], e.bg[1], e.bg[2]));
                const minL = Math.min(...btnLumas);
                const maxL = Math.max(...btnLumas);
                const btnLumaRange = maxL - minL;
                const btnHues = solidBtns.map(e => rgbToHsl(e.bg[0], e.bg[1], e.bg[2])[0]);
                const hueRange = Math.max(...btnHues) - Math.min(...btnHues);
                if (btnLumaRange < 0.15 && hueRange < 0.08) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'warning',
                        element: `${solidBtns.length} buttons all appear visually identical — no primary/secondary action distinction`,
                        issue: `All ${solidBtns.length} buttons share nearly the same background brightness and colour. Every action appears equally important, so users cannot quickly identify the recommended or primary choice. They must read every button label before deciding, which increases friction and reduces conversion. Research consistently shows that an undifferentiated set of CTAs underperforms a clearly tiered primary/secondary pair.`,
                        recommendation: 'Define a clear button hierarchy: (1) Primary — solid fill with your brand colour, used for the single most important action per section. (2) Secondary — outlined or lighter fill, for supporting actions. (3) Tertiary — text-only or ghost, for low-priority links. The visual weight difference between tiers should be unmistakable even without reading the labels.',
                        boundingBox: toBBox(solidBtns[0].rect, vpW, vpH),
                    });
                } else if (btnLumaRange >= 0.20 || hueRange >= 0.10) {
                    strengths.push('Buttons have a clear primary/secondary distinction — action priority is visually communicated without relying exclusively on text labels.');
                }
            }
        }

        // Sub-check D: too many equal-prominence CTAs clustered in the same section
        {
            const ctaEls = vis.filter(e =>
                e.tag === 'button' &&
                e.rect.w > 60 && e.rect.h > 28 &&
                e.rect.w < vpW * 0.5
            );
            if (ctaEls.length >= 5) {
                const yBuckets = {};
                ctaEls.forEach(e => {
                    const band = Math.floor(e.rect.y / (vpH / 4));
                    yBuckets[band] = (yBuckets[band] || 0) + 1;
                });
                const maxInBand = Math.max(...Object.values(yBuckets));
                if (maxInBand >= 5) {
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: `${maxInBand} buttons clustered in the same section — too many competing CTAs`,
                        issue: `${maxInBand} button-sized interactive elements appear in the same quarter of the page. When multiple CTAs cluster at the same visual weight, none stands out as the obvious next step. The user is presented with a decision array rather than a guided action — a phenomenon known as the paradox of choice — which causes hesitation and reduces the likelihood of any action being taken.`,
                        recommendation: 'Limit any single section to one primary CTA and one optional secondary. If multiple actions are genuinely needed, apply a strict visual hierarchy (from solid filled to outlined to text-link) and give the primary significantly more surrounding white space to isolate it from its neighbours.',
                        boundingBox: toBBox(ctaEls[0].rect, vpW, vpH),
                    });
                }
            }
        }
    }

    // ── CHECK 16 — Leading / Line Height ──────────────────────────────────────
    // Source: typography research — optimal body text line height is 1.4–1.6×
    // Below 1.3× lines are too tight; above 2.2× they become visually disconnected.
    {
        const bodyForLH = textEls.filter(e =>
            e.fontSize >= 13 && e.fontSize <= 22 &&
            e.rect.w >= 200 &&
            e.lineHeight > 0
        );
        if (bodyForLH.length >= 4) {
            const tooTight = bodyForLH.filter(e => (e.lineHeight / e.fontSize) < 1.3);
            const tooLoose = bodyForLH.filter(e => (e.lineHeight / e.fontSize) > 2.2);
            if (tooTight.length >= 3) {
                const worst = tooTight.reduce((a, b) =>
                    (b.lineHeight / b.fontSize) < (a.lineHeight / a.fontSize) ? b : a
                );
                const worstRatio = (worst.lineHeight / worst.fontSize).toFixed(2);
                findings.push({
                    id: nid(),
                    category: 'Typography',
                    severity: tooTight.length >= 6 ? 'warning' : 'info',
                    element: `${tooTight.length} body text block${tooTight.length !== 1 ? 's' : ''} have tight line spacing (tightest: ${worstRatio}× line height)`,
                    issue: `${tooTight.length} text areas have line spacing below 1.3× the font size. Text lines that sit too close together are hard to read — the eye struggles to track from the end of one line back to the start of the next, and the descenders of one row visually collide with the ascenders of the row below.`,
                    recommendation: 'Set line-height to 1.4–1.6 for body text. In CSS: `line-height: 1.5` on your paragraph or body styles covers most cases. Headings (24px+) can use tighter leading of 1.1–1.3 since they are short lines read in a single glance.',
                    boundingBox: toBBox(worst.rect, vpW, vpH),
                });
            } else if (tooLoose.length >= 3) {
                const worst = tooLoose.reduce((a, b) =>
                    (b.lineHeight / b.fontSize) > (a.lineHeight / a.fontSize) ? b : a
                );
                const worstRatio = (worst.lineHeight / worst.fontSize).toFixed(2);
                findings.push({
                    id: nid(),
                    category: 'Typography',
                    severity: 'info',
                    element: `${tooLoose.length} text block${tooLoose.length !== 1 ? 's' : ''} have very loose line spacing (loosest: ${worstRatio}×)`,
                    issue: `${tooLoose.length} text areas have a line height over 2.2× the font size. Very loose leading makes text harder to read as a connected block — the eye travels too far between lines and each sentence feels isolated from the one above it.`,
                    recommendation: 'Reduce line-height to 1.4–1.6 for body text. Extremely loose leading is occasionally used for single-line labels or display type, but should not be applied to multi-line paragraphs.',
                    boundingBox: toBBox(worst.rect, vpW, vpH),
                });
            } else {
                strengths.push('Line spacing is comfortable throughout — body text has good breathing room between lines without feeling too spread out.');
            }
        }

        // Sub-check C: heading-specific line height
        // Large display headings should use tight leading (1.0–1.3×). Applying the same
        // generous line height used for body text to headings creates excessive gaps
        // between headline lines that look unpolished and disconnected.
        {
            const headingLHEls = vis.filter(e =>
                ['h1', 'h2', 'h3'].includes(e.tag) &&
                e.fontSize >= 24 &&
                e.lineHeight > 0
            );
            if (headingLHEls.length >= 2) {
                const tooLooseHeadings = headingLHEls.filter(e => (e.lineHeight / e.fontSize) > 1.45);
                if (tooLooseHeadings.length >= 2) {
                    const worst = tooLooseHeadings.reduce((a, b) =>
                        (b.lineHeight / b.fontSize) > (a.lineHeight / a.fontSize) ? b : a
                    );
                    const worstRatioH = (worst.lineHeight / worst.fontSize).toFixed(2);
                    findings.push({
                        id: nid(),
                        category: 'Typography',
                        severity: 'info',
                        element: `${tooLooseHeadings.length} heading element${tooLooseHeadings.length !== 1 ? 's' : ''} have body-text line height applied (loosest: ${worstRatioH}×)`,
                        issue: `${tooLooseHeadings.length} heading elements use a line height of ${worstRatioH}× or higher. Body text benefits from generous leading because lines are long and readers track to the next line frequently. Headings are short — usually 1–3 lines at most — and should use tighter leading (1.0–1.3×). Applying body line-height to display type creates exaggerated vertical gaps between headline rows that look unpolished and optically disconnected, as though the heading lines do not belong to the same thought.`,
                        recommendation: 'Set heading line-height based on size: h1 at 40px+ should use 1.0–1.1, h2 around 1.15–1.25, h3 around 1.2–1.3. In CSS: `h1 { line-height: 1.1; } h2 { line-height: 1.2; } h3 { line-height: 1.25; }` covers most cases. Dramatically tighter heading leading is one of the quickest routes to a more professional typographic impression.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                } else {
                    strengths.push('Headings use appropriately tight line height — display text lines sit close together for a polished, intentional typographic look.');
                }
            }
        }

        // Sub-check D: letter-spacing on body text
        // Positive tracking hurts word-shape recognition in body text;
        // excessive negative tracking pushes glyphs together until they collide.
        {
            const bodyForLS = textEls.filter(e =>
                e.fontSize >= 13 && e.fontSize <= 20 &&
                e.rect.w >= 180 &&
                typeof e.letterSpacing === 'number' && e.letterSpacing !== 0
            );
            if (bodyForLS.length >= 3) {
                const tooLooseLS = bodyForLS.filter(e => e.letterSpacing > 1.5);
                const tooTightLS = bodyForLS.filter(e => e.letterSpacing < -0.5);
                if (tooLooseLS.length >= 3) {
                    const worstLS = tooLooseLS.reduce((a, b) => b.letterSpacing > a.letterSpacing ? b : a);
                    findings.push({
                        id: nid(),
                        category: 'Typography',
                        severity: 'info',
                        element: `${tooLooseLS.length} body text block${tooLooseLS.length !== 1 ? 's' : ''} use excessive letter-spacing (widest: +${worstLS.letterSpacing.toFixed(1)}px)`,
                        issue: `${tooLooseLS.length} body text areas track characters more than 1.5px apart. Positive letter-spacing (tracking) is effective for short uppercase labels, button text, and acronyms but hurts readability in prose. It breaks the natural word-shape recognition that fluent readers rely on at speed — words begin to look like sequences of individual glyphs rather than holistic shapes, noticeably slowing comprehension.`,
                        recommendation: 'Set body text letter-spacing to 0 (default browser) or at most 0.01em. Reserve positive tracking for short uppercase headings, navigation labels, and small-caps text. Large display headings (40px+) often benefit from slightly negative tracking (−0.02em) to compensate for the wider optical spacing at large sizes.',
                        boundingBox: toBBox(worstLS.rect, vpW, vpH),
                    });
                } else if (tooTightLS.length >= 3) {
                    const worstLS = tooTightLS.reduce((a, b) => b.letterSpacing < a.letterSpacing ? b : a);
                    findings.push({
                        id: nid(),
                        category: 'Typography',
                        severity: 'info',
                        element: `${tooTightLS.length} text block${tooTightLS.length !== 1 ? 's' : ''} use negative letter-spacing at body text sizes`,
                        issue: `${tooTightLS.length} text areas use negative letter-spacing (${worstLS.letterSpacing.toFixed(1)}px on the worst case) at 13–20px sizes. At these sizes, typefaces are already designed with optimal glyph spacing — negative tracking closes that gap until glyphs begin to touch. The result is text that looks compressed and strains the reader. Negative tracking is intended only for very large display type (40px+) where typefaces are built with slightly open spacing.`,
                        recommendation: 'Remove negative letter-spacing from all body and UI text. Apply it only to large display headings (40px+) where you can visually verify that no glyph pairs are colliding or touching.',
                        boundingBox: toBBox(worstLS.rect, vpW, vpH),
                    });
                }
            }
        }

        // Sub-check E: Inverse Leading Rule on display type
        // Source: Refactoring UI — large display text should use tight leading (~1.0–1.2×).
        // Applying body-text line height (1.4–1.6×) to oversized headings creates awkward
        // vertical gaps between lines that look unpolished and "accidentally spaced".
        {
            const displayTextEls = textEls.filter(e => e.fontSize > 32 && e.lineHeight > 0);
            if (displayTextEls.length >= 2) {
                const looseDisplay = displayTextEls.filter(e => (e.lineHeight / e.fontSize) > 1.4);
                if (looseDisplay.length >= 2) {
                    const worst = looseDisplay.reduce((a, b) =>
                        (b.lineHeight / b.fontSize) > (a.lineHeight / a.fontSize) ? b : a
                    );
                    const worstRatio = (worst.lineHeight / worst.fontSize).toFixed(2);
                    findings.push({
                        id: nid(),
                        category: 'Typography',
                        severity: 'info',
                        element: `${looseDisplay.length} display text element${looseDisplay.length !== 1 ? 's' : ''} (>32px) use body-level line height — too loose for display type (worst: ${worstRatio}×)`,
                        issue: `${looseDisplay.length} large text element${looseDisplay.length !== 1 ? 's' : ''} over 32px use a line height of ${worstRatio}× or more. Body text benefits from loose leading (1.4–1.6×) because paragraphs have many long lines to track between. Display text — large headings and hero copy — is short and read in a glance. At large sizes, generous line height creates wide vertical voids between lines that make multi-line headings read as disconnected phrases rather than a single continuous thought. The result looks unintentional and visually immature.`,
                        recommendation: 'Reduce line height on display text to 1.0–1.2× the font size. Examples: `h1 { line-height: 1.05; }` for hero headlines, `h2 { line-height: 1.15; }` for section titles. The tighter the leading, the more punchy and intentional large type looks — it is one of the quickest things that separates amateur from professional type-setting.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                } else if (looseDisplay.length === 0) {
                    strengths.push('Display text uses tight, appropriate leading — large headings sit close together for a typographically polished look.');
                }
            }
        }

        // Sub-check F: All-caps text without adequate letter spacing
        // Source: Refactoring UI — uppercase setting optically tightens letter-spacing
        // because capital letters have less built-in sidebearing than mixed-case glyphs.
        // A minimum of ~0.05em (≈1px at 14px, ≈0.7px at 12px) is needed to restore legibility.
        {
            const allCapsEls = textEls.filter(e =>
                e.textTransform === 'uppercase' &&
                e.fontSize >= 9 && e.fontSize <= 18
            );
            if (allCapsEls.length >= 2) {
                const capsNoSpacing = allCapsEls.filter(e => (e.letterSpacing || 0) < 0.5);
                if (capsNoSpacing.length >= 2) {
                    const worst = capsNoSpacing.reduce((a, b) => b.fontSize < a.fontSize ? a : b);
                    const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
                    findings.push({
                        id: nid(),
                        category: 'Typography',
                        severity: capsNoSpacing.length >= 4 ? 'warning' : 'info',
                        element: `${capsNoSpacing.length} uppercase text element${capsNoSpacing.length !== 1 ? 's' : ''} have no letter-spacing — legibility is compressed (worst area: ${zone})`,
                        issue: `${capsNoSpacing.length} text element${capsNoSpacing.length !== 1 ? 's' : ''} use \`text-transform: uppercase\` at small sizes without compensating letter-spacing. Capital letters lack the natural sidebearing of mixed-case text — the gaps between glyphs are narrower, making all-caps sequences feel denser and harder to parse letter-by-letter. At sizes below 20px this is particularly pronounced: labels like "STATUS", "CATEGORY", or "PRICE" appear as compressed blocks rather than distinct letterforms.`,
                        recommendation: 'Add `letter-spacing: 0.05em` (or ≈1px) to any all-caps text under 20px. This single property restores the optical spacing that capitalisation removes. For very small labels (≤12px), use `0.08em` or more. In a utility class: `.label-caps { text-transform: uppercase; letter-spacing: 0.07em; font-size: 11px; }`.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                } else if (capsNoSpacing.length === 0 && allCapsEls.length >= 2) {
                    strengths.push('Uppercase labels have appropriate letter-spacing — capitalisation is compensated with positive tracking for good legibility.');
                }
            }
        }
    }

    // ── CHECK 17 — Font Family Proliferation ──────────────────────────────────
    // More than 2–3 typefaces on one page introduces competing rhythms and weakens
    // typographic cohesion. Each font family carries its own personality.
    {
        const GENERIC_FAMILIES = new Set([
            'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
            'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
            'inherit', 'initial', 'unset', ''
        ]);
        const familySet = new Set(
            textEls
                .map(e => (e.fontFamily || '').trim().toLowerCase())
                .filter(f => f.length > 0 && !GENERIC_FAMILIES.has(f))
        );
        const uniqueCount = familySet.size;
        if (uniqueCount > 4) {
            findings.push({
                id: nid(),
                category: 'Typography',
                severity: uniqueCount > 6 ? 'warning' : 'info',
                element: `${uniqueCount} different typefaces in use simultaneously`,
                issue: `The page uses ${uniqueCount} distinct font families at the same time. Each additional typeface introduces its own rhythm, weight, and aesthetic character that competes with the others. More than 2–3 typefaces erodes typographic cohesion and gives the design a collaged, unfinished feel — as if each section were designed independently.`,
                recommendation: 'Limit the design to 2 font families: one for headings and one for body text. A single versatile typeface at different weights (Regular, Medium, Bold) often works better than multiple different families. Strong pairings: Inter + Playfair Display, Source Sans 3 + Merriweather.',
                boundingBox: [0, 0, 1000, 1000],
            });
        } else if (uniqueCount === 1 || uniqueCount === 2) {
            strengths.push(`Typography uses ${uniqueCount === 1 ? 'a single consistent typeface' : 'just two typefaces'} — a focused choice that keeps the design visually cohesive.`);
        }
    }

    // ── CHECK 18 — Touch Target Size ──────────────────────────────────────────
    // WCAG 2.5.8 and platform guidelines (Apple HIG: 44px, Material Design: 48dp)
    // require interactive elements to have a minimum tap area.
    {
        const interactiveEls = vis.filter(e => e.isInteractive && e.rect.w > 8 && e.rect.h > 8);
        if (interactiveEls.length >= 3) {
            const tooSmall = interactiveEls.filter(e => e.rect.h < 32 || e.rect.w < 32);
            if (tooSmall.length >= 2) {
                const worst = tooSmall.reduce((a, b) =>
                    (b.rect.h * b.rect.w) < (a.rect.h * a.rect.w) ? b : a
                );
                const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
                const worstLabel = elQ(worst) ? `${elQ(worst)} (${zone})` : zone;
                findings.push({
                    id: nid(),
                    category: 'Interactive Targets',
                    severity: tooSmall.length / interactiveEls.length > 0.5 ? 'warning' : 'info',
                    element: `${tooSmall.length} interactive element${tooSmall.length !== 1 ? 's' : ''} are smaller than the recommended 32×32px minimum — worst case: ${worstLabel} at ${worst.rect.w}×${worst.rect.h}px`,
                    issue: `${tooSmall.length} buttons, links, or inputs have a clickable area smaller than 32×32px — the worst case (${zone}) is only ${worst.rect.w}×${worst.rect.h}px. Tiny targets are one of the most common causes of accidental taps on mobile, and they are harder to click accurately even with a mouse.`,
                    recommendation: 'Give every interactive element at least 44×44px of tappable area (Apple HIG) or 48×48dp (Material Design). You can expand the hit area without affecting visual size by adding padding: `padding: 12px; box-sizing: border-box;` or using a larger invisible wrapper.',
                    boundingBox: toBBox(worst.rect, vpW, vpH),
                });
            } else {
                strengths.push('Interactive elements are well-sized with comfortable tap targets throughout.');
            }
        }

        // Sub-check B: adjacent interactive elements too close together
        // Correctly-sized targets still cause accidental activations when
        // neighbouring elements' activation zones overlap or nearly overlap.
        {
            const allInteractive = vis.filter(e => e.isInteractive && e.rect.w > 16 && e.rect.h > 16);
            if (allInteractive.length >= 4) {
                const tooClose = [];
                const sortedIA = [...allInteractive].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
                for (let i = 0; i < sortedIA.length; i++) {
                    for (let j = i + 1; j < Math.min(i + 6, sortedIA.length); j++) {
                        const a = sortedIA[i], b = sortedIA[j];
                        const hGap = Math.max(0, Math.max(a.rect.x, b.rect.x) - Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w));
                        const vGap = Math.max(0, Math.max(a.rect.y, b.rect.y) - Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h));
                        const gap = Math.min(hGap, vGap);
                        if (gap >= 8 || gap < 0) continue;
                        // Exclude inline navigation text-link pairs — two <a> tags in the same
                        // horizontal row with visible text labels are an intentional nav-strip
                        // pattern. Icon-only links (empty or SVG-only text) are NOT excluded
                        // because they lack text labels and are genuinely harder to tap accurately.
                        const sameLinkRow = a.tag === 'a' && b.tag === 'a' &&
                            Math.abs((a.rect.y + a.rect.h / 2) - (b.rect.y + b.rect.h / 2)) < Math.min(a.rect.h, b.rect.h) * 0.6 &&
                            hGap < 16 &&
                            (a.textContent || '').length >= 2 &&
                            (b.textContent || '').length >= 2;
                        if (sameLinkRow) continue;
                        tooClose.push({ a, b, gap });
                    }
                }
                // Cluster connected pairs so a group of N close elements counts as one
                // problem rather than N*(N-1)/2 separate pair-counts.
                const elemKey = e => `${Math.round(e.rect.x)}_${Math.round(e.rect.y)}`;
                const clusterIdx = new Map();
                const clusters = [];
                for (const pair of tooClose) {
                    const ka = elemKey(pair.a), kb = elemKey(pair.b);
                    const ca = clusterIdx.get(ka), cb = clusterIdx.get(kb);
                    if (ca === undefined && cb === undefined) {
                        const idx = clusters.length;
                        clusters.push({ elements: new Set([ka, kb]), worst: pair });
                        clusterIdx.set(ka, idx); clusterIdx.set(kb, idx);
                    } else if (ca !== undefined && cb === undefined) {
                        clusters[ca].elements.add(kb); clusterIdx.set(kb, ca);
                        if (pair.gap < clusters[ca].worst.gap) clusters[ca].worst = pair;
                    } else if (ca === undefined && cb !== undefined) {
                        clusters[cb].elements.add(ka); clusterIdx.set(ka, cb);
                        if (pair.gap < clusters[cb].worst.gap) clusters[cb].worst = pair;
                    } else if (ca !== cb) {
                        const [keep, drop] = ca < cb ? [ca, cb] : [cb, ca];
                        for (const k of clusters[drop].elements) {
                            clusters[keep].elements.add(k); clusterIdx.set(k, keep);
                        }
                        if (clusters[drop].worst.gap < clusters[keep].worst.gap) clusters[keep].worst = clusters[drop].worst;
                        clusters[drop] = null;
                    } else {
                        if (pair.gap < clusters[ca].worst.gap) clusters[ca].worst = pair;
                    }
                }
                const activeC = clusters.filter(Boolean);
                if (activeC.length >= 1) {
                    const worst = activeC.reduce((a, b) => b.worst.gap < a.worst.gap ? b : a).worst;
                    const zone = zoneDesc(worst.a.rect.x + worst.a.rect.w / 2, worst.a.rect.y + worst.a.rect.h / 2, vpW, vpH);
                    const aLabel = elQ(worst.a);
                    const bLabel = elQ(worst.b);
                    const worstDesc = (aLabel && bLabel)
                        ? `the ${aLabel} and ${bLabel} elements`
                        : (aLabel || bLabel)
                            ? `elements near ${aLabel || bLabel}`
                            : `interactive elements in the ${zone} area`;
                    const groupDesc = activeC.length === 1
                        ? worstDesc
                        : `${activeC.length} groups of adjacent interactive elements — worst: ${worstDesc}`;
                    findings.push({
                        id: nid(),
                        category: 'Interactive Targets',
                        severity: worst.gap === 0 ? 'warning' : 'info',
                        element: `${groupDesc} are less than 8px apart (worst: ${worst.gap}px gap, ${zone})`,
                        issue: `${activeC.length} group${activeC.length !== 1 ? 's' : ''} of buttons, links, or inputs are spaced less than 8px apart. Even correctly-sized individual elements cause accidental activations when their neighbours are this close — the user attempting to tap element A triggers element B. On touchscreens in particular, finger width makes this a frequent error. Apple HIG recommends 8px minimum separation between tap targets; 16px preferred for primary actions.`,
                        recommendation: 'Add at least 8px of gap between all adjacent interactive elements. For primary navigation and action buttons, aim for 12–16px. The cleanest approach is `gap: 12px` inside a flex or grid container holding the interactive elements. For icon-only controls, use even more spacing since there is no label to aid target identification.',
                        boundingBox: toBBox(worst.a.rect, vpW, vpH),
                    });
                } else if (tooClose.length === 0) {
                    strengths.push('Adjacent interactive elements are well-spaced — no neighbouring tap targets are close enough to cause accidental activations.');
                }
            }
        }
    }

    // ── CHECK 19 — Heading Document Hierarchy ─────────────────────────────────
    // Every page should have exactly one H1 as the primary visual anchor.
    // Missing H1: no clear entry point. Multiple H1s: competing anchors.
    {
        const allH1s = vis.filter(e => e.tag === 'h1');
        const allHeadings = vis.filter(e => ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(e.tag));
        if (textEls.length >= 5) {
            if (allH1s.length === 0 && allHeadings.length >= 2) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'warning',
                    element: 'No primary heading (H1) — the page has no visual entry point',
                    issue: `The page has ${allHeadings.length} heading${allHeadings.length !== 1 ? 's' : ''} but no H1. An H1 is the single dominant heading that immediately tells visitors what this page is about. Without one, every heading looks like a sub-section heading and the page has no clear visual anchor or logical starting point.`,
                    recommendation: 'Add exactly one H1 as the main page title — the largest, most prominent text that communicates the page topic at a glance. All other section headings should use H2 and below. This creates the hierarchy: page title → section → sub-section.',
                    boundingBox: [0, 0, 300, 1000],
                });
            } else if (allH1s.length > 1) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'info',
                    element: `${allH1s.length} H1 headings detected — multiple top-level headings dilute the hierarchy`,
                    issue: `There are ${allH1s.length} H1 elements on this page. Conventionally a page has exactly one H1 — the primary heading that identifies the page topic. Multiple H1s mean nothing is definitively "the main title", and visitors scanning the page find competing anchors instead of a single clear starting point.`,
                    recommendation: 'Demote all but one H1 to H2. Choose the single most important heading as the H1. This creates a clear hierarchy that is easy to scan: page title at the top, then sections (H2), then sub-sections (H3).',
                    boundingBox: toBBox(allH1s[0].rect, vpW, vpH),
                });
            } else if (allH1s.length === 1) {
                strengths.push('The page has a single clear H1 heading — a strong visual and structural anchor that immediately communicates what the page is about.');
            }
        }

        // Sub-check D: disproportionate font-size jump between consecutive headings
        // The perceptual problem isn't a missing tag number — it's when two adjacent
        // headings on the page have a font size ratio so large that the step feels
        // abrupt rather than graduated. A 2× drop in one step (e.g. 36px → 16px with
        // nothing in between) is visually jarring regardless of which tag numbers are used.
        {
            const allHSorted = vis
                .filter(e => /^h[1-6]$/.test(e.tag) && e.rect.w > 30 && e.fontSize >= 10)
                .sort((a, b) => a.rect.y - b.rect.y);
            if (allHSorted.length >= 2) {
                let worstRatio = 0, worstFrom = null, worstTo = null;
                for (let i = 0; i < allHSorted.length - 1; i++) {
                    const a = allHSorted[i], b = allHSorted[i + 1];
                    if (a.fontSize <= 0 || b.fontSize <= 0) continue;
                    // Only compare headings that are close together on the page.
                    // A large vertical gap means they are in separate sections —
                    // any size difference between them is intentional, not a hierarchy error.
                    const verticalGap = b.rect.y - (a.rect.y + a.rect.h);
                    if (verticalGap > vpH * 0.25) continue;
                    const ratio = a.fontSize / b.fontSize;
                    if (ratio > worstRatio) { worstRatio = ratio; worstFrom = a; worstTo = b; }
                }
                if (worstRatio >= 2.2 && worstFrom && worstTo) {
                    const fromQ = elQ(worstFrom);
                    const toQ = elQ(worstTo);
                    const exStr = (fromQ && toQ) ? ` — ${fromQ} (${Math.round(worstFrom.fontSize)}px) followed by ${toQ} (${Math.round(worstTo.fontSize)}px)` : '';
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: worstRatio >= 3 ? 'warning' : 'info',
                        element: `Heading size drops ${Math.round(worstRatio * 10) / 10}× in one step${exStr}`,
                        issue: `Two adjacent headings on the page have a font size ratio of ${Math.round(worstRatio * 10) / 10}× — the upper heading is ${Math.round(worstFrom.fontSize)}px and the next heading is only ${Math.round(worstTo.fontSize)}px. A well-graded heading scale steps down gradually (roughly 20–30% per level) so visitors can instantly perceive depth and nesting. A jump this large makes the lower heading feel like it belongs to a completely different section rather than a sub-level of the one above it.`,
                        recommendation: `Introduce an intermediate heading size between ${Math.round(worstFrom.fontSize)}px and ${Math.round(worstTo.fontSize)}px so the scale steps down gradually. Aim for each heading level to be roughly 1.25–1.5× larger than the one below it. If the lower heading is a card or widget label that is intentionally small, make sure enough whitespace or a container boundary separates it visually from the section heading above.`,
                        boundingBox: toBBox(worstFrom.rect, vpW, vpH),
                    });
                }
            }
        }

        // Sub-check E: orphaned headings — headings that have no body content following them
        // An orphaned heading introduces a section that contains nothing,
        // leaving a structural hole that reads as incomplete.
        {
            const BODY_CONTENT_TAGS19 = new Set(['p', 'ul', 'ol', 'li', 'table', 'section', 'article', 'div', 'figure', 'img', 'form', 'canvas']);
            const pageHeadings19 = vis.filter(e => ['h2', 'h3', 'h4'].includes(e.tag) && e.rect.w > 40);
            const sortedByY19 = [...vis].sort((a, b) => a.rect.y - b.rect.y);
            const orphaned = pageHeadings19.filter(hEl => {
                const headingBottom = hEl.rect.y + hEl.rect.h;
                const below = sortedByY19.filter(e =>
                    e !== hEl &&
                    e.rect.y >= headingBottom &&
                    e.rect.y < headingBottom + vpH * 0.30 &&
                    e.rect.w > 40
                );
                const hasBodyBelow = below.some(e => BODY_CONTENT_TAGS19.has(e.tag) && e.rect.h > 16);
                return below.length > 0 && !hasBodyBelow;
            });
            if (orphaned.length >= 2) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'info',
                    element: `${orphaned.length} heading${orphaned.length !== 1 ? 's' : ''} with no body content following them`,
                    issue: `${orphaned.length} mid-level headings are not immediately followed by body text, lists, or content containers. An orphaned heading — one that introduces a section but is followed by no content — leaves a structural hole in the page hierarchy. Users scanning headings to locate specific information will click or focus on such a heading, only to find no corresponding content. It also signals an incomplete page or missing sections.`,
                    recommendation: 'Every section heading (h2–h4) should introduce visible content that follows it. Add at minimum a short introductory sentence or a visible content block beneath each orphaned heading. If a section is intentionally navigation-only, consider whether a heading is the right semantic element — a \`<nav>\` landmark or a \`<section aria-label>\` may be more appropriate.',
                    boundingBox: toBBox(orphaned[0].rect, vpW, vpH),
                });
            }
        }
    }

    // ── CHECK 20 — Heading Proximity (Section Spacing) ────────────────────────
    // Source: negative_space.txt / hiarachy.txt
    // "Use less white space between headings and body text to establish a
    //  relationship between the two. Separate new sections with more white
    //  space to create more distinction."
    {
        const PROXIMITY_HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4']);
        const sortedByY = [...vis].sort((a, b) => a.rect.y - b.rect.y);
        const detachedHeadings = [];

        for (const hEl of sortedByY.filter(e => PROXIMITY_HEADING_TAGS.has(e.tag) && e.rect.w > 50)) {
            const hTop = hEl.rect.y;
            const hBottom = hEl.rect.y + hEl.rect.h;

            // Nearest element whose bottom edge sits at or above the heading's top
            const prevEl = sortedByY
                .filter(e => e !== hEl && (e.rect.y + e.rect.h) < hTop + 2 && e.rect.w > 30)
                .sort((a, b) => (b.rect.y + b.rect.h) - (a.rect.y + a.rect.h))[0];

            // Nearest element whose top edge sits at or below the heading's bottom
            const nextEl = sortedByY
                .filter(e => e !== hEl && e.rect.y >= hBottom - 2 && e.rect.w > 30)
                .sort((a, b) => a.rect.y - b.rect.y)[0];

            if (!prevEl || !nextEl) continue; // heading at very top or bottom of page

            const gapAbove = hTop - (prevEl.rect.y + prevEl.rect.h);
            const gapBelow = nextEl.rect.y - hBottom;

            // A heading that has more space below it than above it looks unanchored —
            // the content it introduces appears to belong to the section above.
            if (gapBelow > 16 && gapAbove >= 0 && gapBelow > gapAbove * 1.8) {
                detachedHeadings.push({ hEl, gapAbove, gapBelow });
            }
        }

        if (detachedHeadings.length >= 2) {
            detachedHeadings.sort((a, b) => (b.gapBelow - b.gapAbove) - (a.gapBelow - a.gapAbove));
            const worst = detachedHeadings[0];
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: detachedHeadings.length >= 4 ? 'warning' : 'info',
                element: `${detachedHeadings.length} heading${detachedHeadings.length !== 1 ? 's' : ''} appear detached from the content they introduce`,
                issue: `${detachedHeadings.length} section heading${detachedHeadings.length !== 1 ? 's' : ''} have more space below them than above — the opposite of the proximity principle. The worst case has ${Math.round(worst.gapAbove)}px above the heading and ${Math.round(worst.gapBelow)}px below it. A heading should sit visually closer to the content it introduces than to the section that precedes it. When the gap below a heading equals or exceeds the gap above, the heading looks like it belongs to the previous section rather than the one it opens.`,
                recommendation: 'Reduce the margin below headings and increase the margin above. A common rule: margin-top should be 1.5–2× margin-bottom. For example: `margin-top: 2rem; margin-bottom: 0.5rem` keeps each heading firmly anchored to its content.',
                boundingBox: toBBox(worst.hEl.rect, vpW, vpH),
            });
        } else if (detachedHeadings.length === 0 && sortedByY.filter(e => PROXIMITY_HEADING_TAGS.has(e.tag)).length >= 2) {
            strengths.push('Headings are well-anchored to their content — the spacing above each heading is greater than the spacing below, clearly connecting headings to the sections they introduce.');
        }
    }

    // ── CHECK 21 — Excessive Heading Levels ───────────────────────────────────
    // Source: hiarachy.txt — "more than 3–4 levels of hierarchy becomes very
    // difficult to follow"
    {
        const ALL_HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
        const activeLevels = ALL_HEADING_TAGS.filter(tag =>
            vis.some(e => e.tag === tag && e.rect.w > 30)
        );
        if (activeLevels.length >= 5) {
            findings.push({
                id: nid(),
                category: 'Visual Hierarchy',
                severity: activeLevels.length >= 6 ? 'warning' : 'info',
                element: `${activeLevels.length} heading levels active simultaneously (${activeLevels.join(', ')})`,
                issue: `The page uses ${activeLevels.length} distinct heading levels (${activeLevels.join(', ')}). Research in typographic hierarchy suggests that more than 3–4 levels becomes very difficult for readers to follow — the brain struggles to assign meaning to each tier and the visual difference between adjacent levels becomes too subtle to register at a glance.`,
                recommendation: 'Consolidate to a maximum of 3 heading levels: H1 for the page title, H2 for main sections, H3 for sub-sections. If finer structure is needed, use bold body text, labels, or callout styles inside sections rather than adding heading levels.',
                boundingBox: [0, 0, 1000, 1000],
            });
        } else if (activeLevels.length >= 2 && activeLevels.length <= 3) {
            strengths.push(`${activeLevels.join(', ')} — heading depth is well-controlled with ${activeLevels.length} levels, making the page structure easy to follow at a glance.`);
        }
    }

    // ── CHECK 22 — Elevation Consistency (Z-Index vs Shadow) ──────────────────
    // Shadows simulate physical elevation in UI. When a page uses both z-index
    // and box-shadow as elevation signals, they should agree: a higher stacking
    // layer should cast a proportionally larger, softer shadow.
    {
        // Parse the largest blur radius from a CSS box-shadow string.
        // Handles multiple comma-separated shadows, color tokens, and 'inset'.
        function parseShadowBlur(shadow) {
            if (!shadow || shadow === 'none') return 0;
            // Split on commas that are not inside a color function
            const parts = shadow.split(/,(?![^(]*\))/);
            let maxBlur = 0;
            for (const part of parts) {
                const stripped = part
                    .replace(/rgba?\s*\([^)]+\)/gi, '')
                    .replace(/#[0-9a-fA-F]{3,8}/g, '')
                    .replace(/\binset\b/gi, '')
                    .trim();
                const pxVals = (stripped.match(/(-?\d+(?:\.\d+)?)\s*px/g) || [])
                    .map(s => Math.abs(parseFloat(s)));
                // Layout: offset-x  offset-y  blur  [spread]
                if (pxVals.length >= 3) maxBlur = Math.max(maxBlur, pxVals[2]);
            }
            return maxBlur;
        }

        // Parse y-offset values from a CSS box-shadow string (non-inset shadows only).
        // Returns an array of y-offset numbers (positive = shadow below = light from above).
        function parseShadowYOffsets(shadow) {
            if (!shadow || shadow === 'none') return [];
            const parts = shadow.split(/,(?![^(]*\))/);
            const offsets = [];
            for (const part of parts) {
                if (/\binset\b/i.test(part)) continue; // inset is intentional, skip
                const stripped = part
                    .replace(/rgba?\s*\([^)]+\)/gi, '')
                    .replace(/#[0-9a-fA-F]{3,8}/g, '')
                    .replace(/\binset\b/gi, '')
                    .trim();
                const pxVals = (stripped.match(/(-?\d+(?:\.\d+)?)\s*px/g) || [])
                    .map(s => parseFloat(s));
                if (pxVals.length >= 2) offsets.push(pxVals[1]); // y-offset is 2nd value
            }
            return offsets;
        }

        // Work only on component-like elements: medium-to-large, non-text, not full-width
        const compEls = vis.filter(e =>
            !e.isText &&
            e.rect.w >= 48 && e.rect.h >= 24 &&
            e.rect.w < vpW * 0.90
        );

        if (compEls.length >= 4) {
            // 'Explicitly elevated' = an element with a z-index value intentionally set above 0
            // (auto → 0 on the server, so z ≥ 4 filters out layout accidents)
            const withZ = compEls.filter(e => (e.zIndex ?? 0) >= 4);
            const withShadow = compEls.filter(e => e.hasShadow);
            const pageUsesZ = withZ.length >= 2;
            const pageUsesShadow = withShadow.length >= 2;

            // Paradox A — high z-index but no shadow, while other elements use shadows for elevation.
            // Only meaningful when the page has established a shadow language.
            if (pageUsesShadow && withZ.length >= 2) {
                const highZNoShadow = withZ.filter(e => (e.zIndex ?? 0) >= 10 && !e.hasShadow);
                if (highZNoShadow.length >= 2) {
                    highZNoShadow.sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
                    const worst = highZNoShadow[0];
                    const zone = zoneDesc(
                        worst.rect.x + worst.rect.w / 2,
                        worst.rect.y + worst.rect.h / 2,
                        vpW, vpH
                    );
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: highZNoShadow.length >= 4 ? 'warning' : 'info',
                        element: `${highZNoShadow.length} high z-index element${highZNoShadow.length !== 1 ? 's' : ''} cast no shadow despite being elevated above other content (worst: z-index ${worst.zIndex ?? 0}, ${zone})`,
                        issue: `${highZNoShadow.length} element${highZNoShadow.length !== 1 ? 's' : ''} use a high z-index (≥ 10) to sit above the rest of the page, but cast no box-shadow. This page clearly uses shadows to signal elevation — other components already carry shadow — so these unshadowed high-z elements feel weightless or detached: they sit on top of the layout without visually floating above it. Shadows are what make elevation perceptible; z-index alone moves something in the stacking order but gives the eye no depth cue.`,
                        recommendation: 'Add a box-shadow to any component that deliberately sits above the page content. Use a larger, softer shadow for higher elevation: a modal (z ~1000) needs a bigger shadow than a dropdown (z ~100), which needs more than a card (z ~10). A simple scale: card → `0 2px 8px rgba(0,0,0,.12)`, dropdown → `0 8px 24px rgba(0,0,0,.18)`, modal → `0 24px 48px rgba(0,0,0,.28)`.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                }
            }

            // Paradox B — large shadow but z-index is at ground level, while other elevated
            // elements have smaller shadows. Shadow is overstating the element's elevation.
            if (pageUsesZ && withShadow.length >= 2) {
                const largeBlurLowZ = withShadow.filter(e => {
                    const blur = parseShadowBlur(e.boxShadow || '');
                    return blur >= 20 && (e.zIndex ?? 0) <= 1;
                });
                // Only flag if elevated elements exist with noticeably smaller shadows
                const elevatedTinyShadow = withZ.filter(e => {
                    const blur = parseShadowBlur(e.boxShadow || '');
                    return blur < 6;
                });
                if (largeBlurLowZ.length >= 2 && elevatedTinyShadow.length >= 1) {
                    largeBlurLowZ.sort((a, b) =>
                        parseShadowBlur(b.boxShadow || '') - parseShadowBlur(a.boxShadow || '')
                    );
                    const worst = largeBlurLowZ[0];
                    const worstBlur = Math.round(parseShadowBlur(worst.boxShadow || ''));
                    const zone = zoneDesc(
                        worst.rect.x + worst.rect.w / 2,
                        worst.rect.y + worst.rect.h / 2,
                        vpW, vpH
                    );
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: `${largeBlurLowZ.length} ground-level element${largeBlurLowZ.length !== 1 ? 's' : ''} cast excessively large shadows relative to their z-index (worst: ${worstBlur}px blur at z-index ${worst.zIndex ?? 0}, ${zone})`,
                        issue: `${largeBlurLowZ.length} element${largeBlurLowZ.length !== 1 ? 's' : ''} carry large box-shadows (${worstBlur}px blur on the worst case) while remaining at z-index 0 or 1 — the same stacking level as the base page content. Meanwhile other elements with higher z-index use much smaller shadows. This inverts the elevation signal: the large shadow makes a flat element look more elevated than the components that actually float above the page, which can confuse the user's sense of depth and layer order.`,
                        recommendation: 'Calibrate shadow size to match stacking order. Reduce the blur radius on ground-level elements to 4–12px and increase it on truly elevated components. This ensures the depth cue and the stacking order tell the same story.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                }
            }

            // Paradox C — upward shadows (negative y-offset): simulates light from below,
            // which is physically unnatural in UI. Shadows should fall downward.
            {
                const upwardShadowEls = compEls.filter(e => {
                    if (!e.boxShadow) return false;
                    const yOffsets = parseShadowYOffsets(e.boxShadow);
                    // Flag only when ALL outer shadows are negative (strictly upward)
                    return yOffsets.length >= 1 && yOffsets.every(y => y < -1);
                });
                if (upwardShadowEls.length >= 2) {
                    upwardShadowEls.sort((a, b) =>
                        Math.min(...parseShadowYOffsets(a.boxShadow)) -
                        Math.min(...parseShadowYOffsets(b.boxShadow))
                    );
                    const worst = upwardShadowEls[0];
                    const worstY = Math.round(Math.min(...parseShadowYOffsets(worst.boxShadow || '')));
                    const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
                    findings.push({
                        id: nid(),
                        category: 'Visual Hierarchy',
                        severity: 'info',
                        element: `${upwardShadowEls.length} element${upwardShadowEls.length !== 1 ? 's' : ''} cast shadows upward (negative y-offset: ${worstY}px on worst case, ${zone})`,
                        issue: `${upwardShadowEls.length} non-inset shadow${upwardShadowEls.length !== 1 ? 's' : ''} have a negative y-offset, meaning they project above their element rather than below it. UI depth conventions assume a light source above the screen — so shadows naturally fall downward. An upward-projecting shadow implies light from below, which breaks this convention and creates an unnatural, slightly unsettling sense of depth. Users do not consciously notice but the elevation signal feels "off".`,
                        recommendation: 'Change negative y-offsets to positive values so shadows fall downward: `box-shadow: 0 4px 12px rgba(0,0,0,.15)` instead of `0 -4px 12px rgba(0,0,0,.15)`. If the design intentionally uses a downward light source for a specific stylistic reason (e.g. neumorphism from below), this is a creative choice — but verify it is consistent across all elevated components.',
                        boundingBox: toBBox(worst.rect, vpW, vpH),
                    });
                }
            }

            // Strength: consistent elevation system
            if (pageUsesZ && pageUsesShadow && withZ.length >= 3) {
                const consistent = withZ.filter(e => e.hasShadow && parseShadowBlur(e.boxShadow || '') >= 4);
                const consistencyRatio = consistent.length / withZ.length;
                if (consistencyRatio >= 0.75) {
                    strengths.push('Elevation is visually consistent — elements with high z-index carry appropriately scaled shadows, giving the layout a coherent sense of depth.');
                }
            }
        }
    }

    // ── CHECK 23 — Border Overuse ─────────────────────────────────────────────
    // Source: Refactoring UI — "Don't use a border when a box shadow will do"
    // Borders are the most rigid separation tool available. When they appear on
    // more than ~40% of elements they create a heavily caged look. Backgrounds
    // tints and shadows are softer alternatives that communicate depth instead of
    // just separation.
    {
        const borderedEls = vis.filter(e => (e.borderWidth ?? 0) > 0);
        const borderRatio = vis.length > 0 ? borderedEls.length / vis.length : 0;
        if (borderRatio > 0.40 && borderedEls.length >= 8) {
            const shadowEls = vis.filter(e => e.hasShadow);
            const hasShadowAlternative = shadowEls.length >= 3;
            findings.push({
                id: nid(),
                category: 'Visual Hierarchy',
                severity: borderRatio > 0.60 ? 'warning' : 'info',
                element: `${Math.round(borderRatio * 100)}% of visible elements use borders (${borderedEls.length} elements) — borders may be creating visual noise`,
                issue: `${Math.round(borderRatio * 100)}% of elements on the page carry a visible border. When borders are the primary separation mechanism, the layout takes on a rigid, grid-heavy appearance. Each border introduces a hard edge that divides space — fine in moderation (table rows, form inputs, dividers) but overwhelming at scale. ${!hasShadowAlternative ? 'The page also uses very few shadows, which suggests little use of softer, depth-based separation.' : 'Alternatives like box shadows and background tints are already present on some components.'}`,
                recommendation: `Replace borders with lighter separation techniques where possible: ${hasShadowAlternative ? 'extend the existing shadow approach to more components; ' : ''}use subtle background tints (2–4% darker or lighter) to separate card surfaces from page backgrounds; reserve borders for genuinely linear separators (table rows, form field outlines, horizontal rules). A page with few borders and more depth through shadows and tints feels more professional and less "boxy".`,
                boundingBox: [0, 0, 1000, 1000],
            });
        } else if (borderRatio <= 0.15 && vis.filter(e => e.hasShadow).length >= 3) {
            strengths.push('Separation relies on shadows and background tints rather than heavy borders — the layout feels open and depth-forward rather than rigidly caged.');
        }
    }

    // ── CHECK 24 — Containment Paradox ───────────────────────────────────────
    // Source: Refactoring UI — spacing should reinforce containment
    // Within a component the outer padding (the gap from the container edge to its
    // content) should be larger than the inner gaps between the items inside it.
    // When inner gaps exceed outer padding, the items feel visually "loose" inside
    // the box — as if about to spill out — because there is more breathing room
    // between siblings than between siblings and their parent.
    {
        // Look for "card-like" containers: padded on all four sides, component-sized
        const cardContainers = vis.filter(e =>
            !e.isText &&
            e.rect.w >= 100 && e.rect.w <= 700 &&
            e.rect.h >= 60 && e.rect.h <= 700 &&
            Math.min(
                e.paddingTop ?? 0,
                e.paddingBottom ?? 0,
                e.paddingLeft ?? 0,
                e.paddingRight ?? 0
            ) >= 8
        );

        const paradoxes = [];
        for (const container of cardContainers) {
            // Collect elements fully inside the container
            const inside = vis.filter(c =>
                c !== container &&
                c.rect.x > container.rect.x &&
                c.rect.y > container.rect.y &&
                c.rect.x + c.rect.w < container.rect.x + container.rect.w &&
                c.rect.y + c.rect.h < container.rect.y + container.rect.h &&
                c.rect.w >= 16 && c.rect.h >= 10
            );
            if (inside.length < 3) continue;

            // Keep only "top-level" children: those not fully enclosed by a sibling
            const topLevel = inside.filter(c =>
                !inside.some(o =>
                    o !== c &&
                    o.rect.x <= c.rect.x && o.rect.y <= c.rect.y &&
                    o.rect.x + o.rect.w >= c.rect.x + c.rect.w &&
                    o.rect.y + o.rect.h >= c.rect.y + c.rect.h
                )
            );
            if (topLevel.length < 3) continue;

            // Sort by vertical position and measure gaps between adjacent children
            const sorted = [...topLevel].sort((a, b) => a.rect.y - b.rect.y);
            const gaps = [];
            for (let i = 0; i < sorted.length - 1; i++) {
                const gap = sorted[i + 1].rect.y - (sorted[i].rect.y + sorted[i].rect.h);
                if (gap > 0) gaps.push(gap);
            }
            if (gaps.length < 2) continue;

            const maxInnerGap = Math.max(...gaps);
            const containerMinPad = Math.min(
                container.paddingTop ?? 0,
                container.paddingBottom ?? 0,
                container.paddingLeft ?? 0,
                container.paddingRight ?? 0
            );
            // Paradox fires when the largest inner gap is more than 2.5× the container's
            // minimum padding AND is at least 24px in absolute terms
            if (containerMinPad > 0 && maxInnerGap > containerMinPad * 2.5 && maxInnerGap >= 24) {
                paradoxes.push({ container, maxInnerGap, containerMinPad });
            }
        }

        if (paradoxes.length >= 2) {
            paradoxes.sort((a, b) =>
                (b.maxInnerGap / b.containerMinPad) - (a.maxInnerGap / a.containerMinPad)
            );
            const worst = paradoxes[0];
            const ratio = (worst.maxInnerGap / worst.containerMinPad).toFixed(1);
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: paradoxes.length >= 4 ? 'warning' : 'info',
                element: `${paradoxes.length} component${paradoxes.length !== 1 ? 's' : ''} have larger gaps between inner items than between items and the container edge (worst: ${Math.round(worst.maxInnerGap)}px inner gap vs ${Math.round(worst.containerMinPad)}px outer padding — ${ratio}× ratio)`,
                issue: `${paradoxes.length} container${paradoxes.length !== 1 ? 's' : ''} exhibit the containment paradox: the space between their internal items is larger than the padding between those items and the container's own edge. The worst case has ${Math.round(worst.maxInnerGap)}px between children but only ${Math.round(worst.containerMinPad)}px of outer padding. When inner spacing exceeds outer spacing, items in the component feel visually uncontained — they look like they belong to the surrounding page more than to their parent box. The container's boundary loses its grouping power.`,
                recommendation: `Increase the container's padding to always exceed the largest internal gap: if items inside have ${Math.round(worst.maxInnerGap)}px between them, the container should have at least ${Math.round(worst.maxInnerGap) + 4}px of padding on all sides. Alternatively, reduce inter-item spacing. The rule is simple: outer padding ≥ inner gap. This ensures the container feels like a cohesive unit rather than a loose wrapper.`,
                boundingBox: toBBox(worst.container.rect, vpW, vpH),
            });
        } else if (paradoxes.length === 0 && cardContainers.length >= 3) {
            strengths.push('Component spacing is well-contained — outer padding consistently exceeds inner item gaps, keeping content anchored inside its parent boundaries.');
        }
    }

    // ── CHECK 25 — Tiny Text Near or On Images ────────────────────────────────
    // Text that is very small (< 11px) and sits directly on or immediately adjacent
    // to an image or background-image element is nearly always unreadable. This is
    // distinct from the contrast check: even perfect-contrast 9px text is illegible
    // at normal viewing distances.
    {
        const tinyText = vis.filter(e => e.isText && e.fontSize < 11 && e.fontSize >= 1);
        const imageEls = vis.filter(e => e.tag === 'img' || e.hasBackgroundImage);

        const tinyNearImage = tinyText.filter(el => {
            const cx = el.rect.x + el.rect.w / 2;
            const cy = el.rect.y + el.rect.h / 2;
            return imageEls.some(img => {
                // "near" = centre of text is within the image bounds + 40px halo
                const halo = 40;
                return cx >= img.rect.x - halo && cx <= img.rect.x + img.rect.w + halo &&
                    cy >= img.rect.y - halo && cy <= img.rect.y + img.rect.h + halo;
            });
        });

        if (tinyNearImage.length >= 2) {
            const worst = tinyNearImage.reduce((a, b) => a.fontSize < b.fontSize ? a : b);
            findings.push({
                id: nid(),
                category: 'Readability',
                severity: tinyNearImage.length >= 4 ? 'critical' : 'warning',
                element: `${tinyNearImage.length} text element${tinyNearImage.length !== 1 ? 's' : ''} under 11px appear near images (smallest: ${worst.fontSize.toFixed(0)}px)`,
                issue: `${tinyNearImage.length} text elements smaller than 11px are placed on or directly next to images or graphic backgrounds. Text this small is essentially unreadable at any normal screen distance — it appears as a visual blur rather than readable content. When placed near complex images, even the shape of letters becomes indistinct.`,
                recommendation: 'Set a minimum font size of 12–14px for any text that appears near or overlaid on images. If the text is a caption or label, display it below the image on a plain background instead of over the graphic. If it is decorative and not meant to be read, remove it or replace it with a purely visual element.',
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
        }
    }

    // ── CHECK 26 — Image and Avatar Minimum Size ──────────────────────────────
    // SVG icons are vector and legible at any size — skip them entirely.
    // For bitmap images (img), the threshold depends on what the image contains:
    //   • Decorative images (alt="") carry no information — skip.
    //   • Face / avatar photos need ~40px to show a recognisable face.
    //   • Logo / brand images need ~24px to remain a legible mark.
    //   • All other meaningful images use 24px as a conservative minimum.
    {
        const imgEls = vis.filter(e =>
            e.tag === 'img' &&
            e.rect.w >= 8 && e.rect.h >= 8 &&
            // skip decorative images (explicit empty alt)
            e.alt !== ''
        );
        // Use alt text to guess image type and apply appropriate threshold.
        const FACE_WORDS = /\b(avatar|profile|photo|face|person|user|headshot|member|author|team)\b/i;
        const LOGO_WORDS = /\b(logo|brand|icon|badge|seal|mark)\b/i;
        const tooSmall = imgEls.filter(e => {
            const minDim = Math.min(e.rect.w, e.rect.h);
            const alt = e.alt || '';
            if (FACE_WORDS.test(alt)) return minDim < 40;
            if (LOGO_WORDS.test(alt)) return minDim < 24;
            return minDim < 24; // default threshold for unclassified meaningful images
        });

        if (tooSmall.length >= 3) {
            const worst = tooSmall.reduce((a, b) =>
                Math.min(a.rect.w, a.rect.h) < Math.min(b.rect.w, b.rect.h) ? a : b
            );
            const worstSize = Math.round(Math.min(worst.rect.w, worst.rect.h));
            const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
            const worstLabel = worst.alt ? ` ('${worst.alt.slice(0, 40)}')` : '';
            findings.push({
                id: nid(),
                category: 'Icon & Image Size',
                severity: tooSmall.length >= 6 ? 'warning' : 'info',
                element: `${tooSmall.length} image${tooSmall.length !== 1 ? 's' : ''} are too small to convey their content clearly (smallest: ${worstSize}px${worstLabel}, ${zone})`,
                issue: `${tooSmall.length} images are below the minimum size at which their content remains recognisable. This commonly affects avatar strips, partner logos, and social proof sections. Images this small look squished and indistinct: faces become featureless blobs and logos become illegible marks. The overall effect is that supporting content meant to build trust (faces, brand logos) becomes visual noise instead.`,
                recommendation: `Size images based on their content: face/avatar photos need at least 40×40px to show a recognisable face; logos and brand marks need at least 24×24px to remain legible. For avatar strips showing social proof, 40px is the sweet spot — small enough to group naturally, large enough to show distinct faces.`,
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
        }
    }

    // ── CHECK 29 — Horizontal Row Spacing Outlier (Nav / Toolbar) ────────────
    // In a horizontal navigation row, all inter-item gaps should be roughly the
    // same order of magnitude. A single gap that is many times larger than the
    // median signals visual disconnection — viewers read the items on each side
    // as separate groups even if they are semantically related (e.g. nav links
    // and a CTA button that are visually split by an implicit flex spacer).
    {
        const topRowEls = vis.filter(e =>
            e.rect.y + e.rect.h / 2 < vpH * 0.15 &&
            e.rect.h < 80 &&
            e.rect.w >= 12 && e.rect.w < vpW * 0.6
        );
        if (topRowEls.length >= 4) {
            const sorted = [...topRowEls].sort((a, b) => a.rect.x - b.rect.x);
            const gaps = [];
            for (let i = 0; i < sorted.length - 1; i++) {
                const gap = sorted[i + 1].rect.x - (sorted[i].rect.x + sorted[i].rect.w);
                if (gap >= 0 && gap < vpW * 0.5) gaps.push({ gap, a: sorted[i], b: sorted[i + 1] });
            }
            if (gaps.length >= 3) {
                const vals = gaps.map(g => g.gap).sort((a, b) => a - b);
                const median = vals[Math.floor(vals.length / 2)];
                const maxEntry = gaps.reduce((a, b) => b.gap > a.gap ? b : a);
                const ratio = median > 0 ? maxEntry.gap / median : 0;
                if (ratio >= 6 && maxEntry.gap >= 80) {
                    // A gap centred in the middle 60% of the viewport is the standard
                    // "brand left / links right" split-nav pattern — intentional by design.
                    const gapCentreX = (maxEntry.a.rect.x + maxEntry.a.rect.w + maxEntry.b.rect.x) / 2;
                    const isIntentionalSplit = gapCentreX > vpW * 0.20 && gapCentreX < vpW * 0.80;
                    const aLabel = elQ(maxEntry.a);
                    const bLabel = elQ(maxEntry.b);
                    const groupDesc = (aLabel && bLabel)
                        ? `between ${aLabel} and ${bLabel}`
                        : aLabel
                            ? `after ${aLabel}`
                            : bLabel
                                ? `before ${bLabel}`
                                : `of ${Math.round(maxEntry.gap)}px`;
                    findings.push({
                        id: nid(),
                        category: 'Spacing & Layout',
                        severity: (!isIntentionalSplit && ratio >= 12) ? 'warning' : 'info',
                        element: `Navigation row has a gap ${groupDesc} — ${Math.round(ratio)}× larger than the typical ${Math.round(median)}px spacing between items`,
                        issue: `The top navigation row has one unusually large gap (${Math.round(maxEntry.gap)}px) while all other inter-item spaces are around ${Math.round(median)}px. A ratio of ${Math.round(ratio)}× means the navigation visually splits into two disconnected groups. Even if this is intentional (brand name left, utility links right), the implicit gap alone does not communicate that structure — visitors may perceive an uneven or unfinished layout rather than a deliberate two-group composition.`,
                        recommendation: `If the large gap is intentional (e.g. left-aligned links / right-aligned CTA), reinforce the split explicitly: add a visual divider, use a differently-styled group, or apply \`justify-content: space-between\` only at the group level. If the gap is unintentional, use a flex container with uniform \`gap\` so inter-item spacing stays consistent throughout the row.`,
                        boundingBox: toBBox(maxEntry.a.rect, vpW, vpH),
                    });
                }
            }
        }
    }

    // ── CHECK 30 — Content Group Separation ───────────────────────────────────
    // Within a content column, elements of clearly different semantic weight
    // (heading, body text, interactive control, caption) need a visible breath
    // between them to register as separate "groups." When mixed-scale elements
    // share < 8px of vertical gap, the eye cannot parse content hierarchy at a
    // glance and all content reads as a single undifferentiated block.
    {
        const colEls = vis.filter(e =>
            (e.isText || e.isInteractive) &&
            e.rect.w >= 56 && e.rect.h >= 12 &&
            e.rect.w < vpW * 0.9
        );
        // Group elements into 100px-wide horizontal buckets
        const bucketW = 100;
        /** @type {Map<number, typeof colEls>} */
        const buckets = new Map();
        for (const el of colEls) {
            const bk = Math.floor(el.rect.x / bucketW);
            if (!buckets.has(bk)) buckets.set(bk, []);
            buckets.get(bk).push(el);
        }
        let mergeCount = 0;
        let worstEl = null;
        for (const [, col] of buckets) {
            if (col.length < 3) continue;
            const sorted = col.slice().sort((a, b) => a.rect.y - b.rect.y);
            for (let i = 0; i < sorted.length - 1; i++) {
                const a = sorted[i], b = sorted[i + 1];
                const gap = b.rect.y - (a.rect.y + a.rect.h);
                if (gap < 0 || gap > 8) continue;
                // "type differs" = different size tier OR different interactivity
                const aLarge = a.fontSize >= 18;
                const bLarge = b.fontSize >= 18;
                const typeDiffers = (aLarge !== bLarge) || (a.isInteractive !== b.isInteractive);
                if (typeDiffers) {
                    mergeCount++;
                    if (!worstEl) worstEl = a;
                }
            }
        }
        if (mergeCount >= 2 && worstEl) {
            const zone = zoneDesc(worstEl.rect.x + worstEl.rect.w / 2, worstEl.rect.y + worstEl.rect.h / 2, vpW, vpH);
            findings.push({
                id: nid(),
                category: 'Spacing & Layout',
                severity: mergeCount >= 5 ? 'warning' : 'info',
                element: `${mergeCount} place${mergeCount !== 1 ? 's' : ''} where different content types share almost no vertical gap (${zone})`,
                issue: `${mergeCount} location${mergeCount !== 1 ? 's' : ''} on the page have heading-scale, body-scale, or interactive elements stacked with less than 8px between them, despite being visually different types. The vertical gap between a heading and its following paragraph, between a paragraph and a CTA button, or between a button and a caption strip carries semantic meaning — it signals "new group." When that gap approaches zero, all content collapses into a single undifferentiated block and the visitor must consciously decode the hierarchy rather than perceiving it instantly.`,
                recommendation: `Between each logical content group (title block, description, action zone, social proof strip), use at least 16px of vertical space — 24–32px is preferable when the adjacent elements differ greatly in size. In CSS, applying \`margin-bottom\` on the last element of each group (rather than \`margin-top\` on the next) avoids margin-collapse surprises.`,
                boundingBox: toBBox(worstEl.rect, vpW, vpH),
            });
        }
    }

    // ── CHECK 31 — Layout Column Alignment ────────────────────────────────────
    // In a hero or content column, elements that share the same left edge should
    // also have consistent widths — a heading, paragraph, and button group are
    // implicitly treated as a unified block. When their widths diverge by more
    // than ~30% it breaks the implied column grid, so the eye detects the ragged
    // right edge as disorder rather than intentional asymmetry.
    {
        // Find elements with the same (or very similar) left edge
        const colCandidates = vis.filter(e =>
            (e.isText || e.isInteractive) &&
            e.rect.w >= 80 && e.rect.h >= 12 &&
            e.rect.w < vpW * 0.75 &&
            e.rect.y < vpH * 0.85
        );
        // Bucket by left edge (within 20px tolerance)
        /** @type {Map<number, typeof colCandidates>} */
        const leftBuckets = new Map();
        for (const el of colCandidates) {
            const key = Math.round(el.rect.x / 20) * 20;
            if (!leftBuckets.has(key)) leftBuckets.set(key, []);
            leftBuckets.get(key).push(el);
        }
        let widthOutliers = 0;
        /** @type {any} */
        let outlierEl = null;
        for (const [, col] of leftBuckets) {
            if (col.length < 3) continue;
            const widths = col.map(e => e.rect.w);
            const maxW = Math.max(...widths);
            const minW = Math.min(...widths);
            if (maxW === 0) continue;
            // Only flag when there are both a clearly wide and a clearly narrow item
            // (the difference must be > 30% of the widest element)
            if ((maxW - minW) / maxW > 0.30) {
                const narrowEl = col.reduce((a, b) => b.rect.w < a.rect.w ? b : a);
                widthOutliers++;
                if (!outlierEl) outlierEl = narrowEl;
            }
        }
        if (widthOutliers >= 2 && outlierEl) {
            const zone = zoneDesc(outlierEl.rect.x + outlierEl.rect.w / 2, outlierEl.rect.y + outlierEl.rect.h / 2, vpW, vpH);
            const label = elQ(outlierEl);
            findings.push({
                id: nid(),
                category: 'Layout Order',
                severity: widthOutliers >= 4 ? 'warning' : 'info',
                element: label
                    ? `${label} has a different width than the other elements in its column (${zone})`
                    : `${widthOutliers} content column${widthOutliers !== 1 ? 's' : ''} contain elements with inconsistent widths (${zone})`,
                issue: `${widthOutliers} vertical content group${widthOutliers !== 1 ? 's' : ''} have elements that share the same left edge but have noticeably different widths — a heading, paragraph, and button block that start at the same x-position but end at different x-positions leave a ragged right edge inside the column. Even when individually sized correctly, this variation breaks the perceived alignment grid, so the column reads as a loose collection of items rather than a unified content block.`,
                recommendation: `Within each content column, align sibling elements to a consistent width — either by giving the column a fixed width and letting children fill it (\`width: 100%\` on children), or by explicitly setting the same \`max-width\` on the heading, paragraph, and button group. A common culprit is a paragraph with no explicit width that wraps to its intrinsic size while the heading above it is wider due to larger font.`,
                boundingBox: toBBox(outlierEl.rect, vpW, vpH),
            });
        }
    }

    // ── CHECK 27 — Visual Center of Mass: Coloured Top Banner ─────────────────
    // A full-width coloured bar positioned at the very top of the page creates a
    // strong perceptual anchor. High-saturation colours carry disproportionate
    // visual weight relative to neutral areas; a wide coloured strip above the
    // hero shifts the page's perceptual centre of mass upward and competes with
    // the intended primary focal point below.
    {
        const topBars = vis.filter(e => {
            if (e.isText) return false;
            if (e.rect.y > 80) return false;               // must start near page top
            if (e.rect.w < vpW * 0.5) return false;        // must span most of the viewport
            if (!e.bg || e.bg[0] === undefined) return false;
            const [, s, l] = rgbToHsl(e.bg[0], e.bg[1], e.bg[2]);
            return s > 0.30 && l > 0.05 && l < 0.95;      // non-neutral, non-white, non-black
        });

        if (topBars.length > 0) {
            const heaviest = topBars.reduce((a, b) => {
                const [, sa] = rgbToHsl(a.bg[0], a.bg[1], a.bg[2]);
                const [, sb] = rgbToHsl(b.bg[0], b.bg[1], b.bg[2]);
                return sb > sa ? b : a;
            });
            const [, s] = rgbToHsl(heaviest.bg[0], heaviest.bg[1], heaviest.bg[2]);
            const satPct = Math.round(s * 100);

            // Sub-check: text inside the banner is small or tightly padded
            const bannerTextEls = textEls.filter(e => {
                const cy = e.rect.y + e.rect.h / 2;
                return cy >= heaviest.rect.y && cy <= heaviest.rect.y + heaviest.rect.h;
            });
            if (bannerTextEls.length > 0) {
                const smallBannerText = bannerTextEls.filter(e => e.fontSize < 13);
                if (smallBannerText.length >= 1) {
                    const sample = smallBannerText[0];
                    const textLabel = elQ(sample);
                    findings.push({
                        id: nid(),
                        category: 'Readability',
                        severity: 'info',
                        element: textLabel
                            ? `The text ${textLabel} in the top banner is small or tightly padded`
                            : `Text in the top banner is small or tightly padded (${Math.round(sample.fontSize)}px)`,
                        issue: `Text inside the coloured top banner is ${smallBannerText.length > 0 ? `only ${Math.round(smallBannerText[0].fontSize)}px` : 'tightly contained with almost no vertical padding'}. Announcement banners are often the first thing a visitor reads — if the text is too small or the banner is too narrow to breathe, the message is lost. Users skip past content they cannot immediately parse, defeating the purpose of the announcement.`,
                        recommendation: `Increase the font size inside the banner to at least 13px (14px preferred), and add at least 8–10px of vertical padding inside the bar so the text has room to breathe. For short announcements, a slightly bolder weight (500–600) also improves readability against a coloured background.`,
                        boundingBox: toBBox(sample.rect, vpW, vpH),
                    });
                }
            }

            findings.push({
                id: nid(),
                category: 'Visual Weight',
                severity: 'info',
                element: `Full-width coloured bar near the top of the page (${satPct}% colour saturation)`,
                issue: `A wide, coloured bar at the very top of the page carries significant visual weight — its background colour is ${satPct}% saturated. Because the human eye anchors to the brightest and most saturated element first, a high-contrast banner above the hero section can shift the page's perceptual centre of mass upward, drawing attention away from the intended primary content. Even a bar capturing 5–10% of viewport height can make the hero below feel lower on the page than it actually is.`,
                recommendation: `If the banner contains time-sensitive information (sale, announcement), keep it but reduce saturation or brightness slightly so it reads as secondary to the hero below. If it is a notification or cookie bar, consider making it dismissible or moving it to a slide-in from the bottom screen edge, which avoids competing with above-the-fold content.`,
                boundingBox: toBBox(heaviest.rect, vpW, vpH),
            });
        }
    }

    // ── CHECK 28 — Perceptual Contrast: Text Placed on Image Areas ────────────
    // CSS colour values alone cannot confirm legibility when text sits over a
    // photographic or patterned-background element — the image pixels beneath
    // individual letterforms vary and may create low-contrast regions directly
    // under the text. This is especially problematic for patterned backgrounds
    // and mid-tone images, where even nominally correct measured contrast ratios
    // break down at the glyph level.
    {
        // Exclude hasBackgroundImage elements that span most of the viewport — these
        // are decorative page-wide textures (grid patterns, subtle noise fills) rather
        // than foreground content images. A wrapper covering > 65% of the viewport
        // area is almost always a background texture, not a meaningful image area.
        const vpArea = vpW * vpH;
        const imgAreas = vis.filter(e => {
            if (e.tag === 'img') return e.rect.w >= 60 && e.rect.h >= 40;
            if (e.hasBackgroundImage) {
                const area = e.rect.w * e.rect.h;
                // Exclude page-wide textures (>65% of viewport) — these are decorative fills.
                // Also exclude elements whose own CSS opacity is low — a background-image
                // element with opacity < 0.35 is a subtle decorative overlay, not a
                // foreground visual that competes with text legibility.
                const opacity = (e.opacity !== undefined) ? e.opacity : 1;
                return e.rect.w >= 60 && e.rect.h >= 40 && area < vpArea * 0.65 && opacity >= 0.35;
            }
            return false;
        });

        const textOnImg = textEls.filter(el => {
            const cx = el.rect.x + el.rect.w / 2;
            const cy = el.rect.y + el.rect.h / 2;
            const overImg = imgAreas.some(img =>
                cx > img.rect.x &&
                cx < img.rect.x + img.rect.w &&
                cy > img.rect.y &&
                cy < img.rect.y + img.rect.h &&
                img.rect.w * img.rect.h > el.rect.w * el.rect.h
            );
            if (!overImg) return false;
            // If there is a solid overlay providing enough APCA contrast, the image
            // beneath is effectively masked — the text is readable and shouldn't fire.
            const lcMin = (sz) => sz < 14 ? 60 : sz < 18 ? 45 : sz < 24 ? 35 : 25;
            const fgL = luma(el.color[0], el.color[1], el.color[2]);
            const bgL = luma(el.bg[0], el.bg[1], el.bg[2]);
            const lc = Math.abs(apcaLc(fgL, bgL));
            return lc < lcMin(el.fontSize);
        });

        if (textOnImg.length >= 2) {
            const worst = textOnImg.reduce((a, b) => a.fontSize < b.fontSize ? a : b);
            const zone = zoneDesc(worst.rect.x + worst.rect.w / 2, worst.rect.y + worst.rect.h / 2, vpW, vpH);
            const worstQuote = elQ(worst);
            findings.push({
                id: nid(),
                category: 'Readability',
                severity: textOnImg.length >= 5 ? 'warning' : 'info',
                element: worstQuote
                    ? `${textOnImg.length} text element${textOnImg.length !== 1 ? 's' : ''} over image areas — e.g. ${worstQuote} (${Math.round(worst.fontSize)}px, ${zone})`
                    : `${textOnImg.length} text element${textOnImg.length !== 1 ? 's' : ''} placed over image or pattern areas (smallest: ${Math.round(worst.fontSize)}px, ${zone})`,
                issue: `${textOnImg.length} text element${textOnImg.length !== 1 ? 's' : ''} are positioned over image or patterned-background areas. CSS colour values alone cannot confirm legibility here — the image beneath the text contains pixel variations that may create low-contrast regions directly under letterforms. This is especially problematic for small text and for images with mid-tone, textured, or busy patterns. Readers often need to squint or re-read text that falls over such areas.`,
                recommendation: `Protect text legibility over images with one of: (1) a semi-transparent dark or light scrim placed behind the text (e.g. rgba(0,0,0,0.4)); (2) a text-shadow or drop-shadow matching the text colour's luminance; (3) repositioning text to a solid-colour area adjacent to the image; (4) a solid-colour badge or pill background behind the text. The scrim approach is most robust for photographic content.`,
                boundingBox: toBBox(worst.rect, vpW, vpH),
            });
        }
    }

    // ── Score + return ─────────────────────────────────────────────────────────
    const penalty = findings.reduce(
        (acc, f) => acc + (f.severity === 'critical' ? 15 : f.severity === 'warning' ? 7 : 2), 0
    );
    // Cap penalty so the minimum score stays meaningful (not zero for busy pages)
    const overallScore = Math.max(20, Math.min(100, 100 - Math.min(penalty, 70)));

    if (strengths.length === 0) {
        strengths.push('The overall layout looks balanced and well-structured.');
        strengths.push('No major visual problems were detected across the design.');
    } else if (strengths.length === 1) {
        strengths.push('Brightness is used consistently across the design.');
    }

    // ── Deduplication: remove redundant vertical-direction centroid findings ────
    // CHECK 2a (centroid offset) and CHECK 2b (top/bottom ratio) can both fire for
    // the same vertical imbalance, producing two near-identical findings. When CHECK 2b
    // already emits a dedicated top/bottom finding, suppress any purely-vertical
    // centroid finding from CHECK 2a ("Visual weight sits toward the upward/downward").
    {
        const hasTopBottomFinding = findings.some(f =>
            f.category === 'Visual Weight' && f.element.includes('top–bottom imbalance')
        );
        if (hasTopBottomFinding) {
            const purelyVertical = /^Visual weight sits toward the (upward|downward)$/;
            for (let i = findings.length - 1; i >= 0; i--) {
                if (findings[i].category === 'Visual Weight' && purelyVertical.test(findings[i].element)) {
                    findings.splice(i, 1);
                }
            }
        }
    }

    const categories = [...new Set(findings.map(f => f.category))];
    return {
        summary: findings.length === 0
            ? 'No significant perceptual issues detected. The page passes all checks.'
            : `Analysis found ${findings.length} issue${findings.length !== 1 ? 's' : ''} across ${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'}: ${categories.join(', ')}.`,
        overallScore,
        findings,
        strengths: strengths.slice(0, 6),
        expertNote: 'This report covers 31 perceptual check groups (each with multiple sub-cases): text contrast — APCA per size tier, contrast-as-hierarchy, tiny text, harsh all-maximum contrast; optical centering — centre-of-mass, left/right, top/bottom, quadrant concentration, diagonal axis; visual focus — mosaic detection, moderate competition, weak dominance, focal-point location; tonal range — band count, mid-range clustering, dark-mode text errors, monotonous backgrounds; colour palette — hue diversity, accent overuse, button colour consistency; typography — heading/size scale, font-weight range, heading colour, line length, leading, heading leading, letter-spacing, font family count, inverse leading on display type, all-caps letter-spacing; spacing rhythm — hotspot density, vertical gap consistency, edge margins, tap-target size, adjacent-target spacing, containment paradox; visual hierarchy — ghost buttons, link affordance, primary/secondary button distinction, CTA clustering, heading document hierarchy, level skipping, orphaned headings, row alignment, column alignment, text-align consistency, border overuse; heading proximity; excessive heading levels; elevation consistency — z-index vs shadow blur paradoxes, upward shadow direction; text readability — tiny text near images; image/avatar minimum size (img and svg); visual center of mass — coloured full-width top bar; text on images — text over foreground image areas (page-wide background textures excluded); nav row gap outlier — one horizontal gap much larger than others in a navigation row; content group separation — heading, body, and interactive elements merged with < 8px gap between types; layout column alignment — elements sharing a left edge with inconsistent widths. All derived from computed CSS and live layout geometry at 1440×900px. Hover/focus states, CSS animations, and content loaded after the initial render are not included.',
    };
}
