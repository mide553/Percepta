/**
 * Percepta — DOM-based Perceptual Analysis Engine
 * Pure Node.js — no browser APIs required.
 * Receives element data extracted by Puppeteer from the live page.
 *
 * Checks:
 *  1. Text Contrast            — APCA on actual CSS color + effective background
 *  2. Optical Centering        — element area-weighted centre of mass
 *  3. Visual Focus             — competing prominence zones
 *  4. Tonal Range              — luminance band coverage across all CSS colours
 *  5. Colour Palette           — hue diversity and chromatic balance
 *  6. Text Hierarchy           — font-size and contrast-tier spread
 *  7. Spacing Rhythm           — element density per 8x8 grid cell
 *  8. Edge Margins             — elements pressing against viewport boundary
 *  9. Vertical Weight          — top / middle / bottom third balance
 * 10. Simultaneous Contrast    — adjacent elements with complementary saturated colours
 * 11. Grid Alignment           — left-edge x-position clustering
 * 12. Colour Temperature       — hue consistency between light and dark zones
 * 13. Line Length              — estimated characters per line for body text
 * 14. Grey Temperature Tinting — pure neutral greys in a coloured interface
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

    // ── CHECK 1 — Text Contrast ────────────────────────────────────────────────
    {
        const failing = [];
        for (const el of textEls) {
            const fgL = luma(el.color[0], el.color[1], el.color[2]);
            const bgL = luma(el.bg[0], el.bg[1], el.bg[2]);
            if (Math.abs(fgL - bgL) < 0.01) continue;
            const lc = Math.abs(apcaLc(fgL, bgL));
            if (lc < 38) failing.push({ lc, el });
        }
        // Only flag if a meaningful proportion of text fails — avoids firing on
        // a single placeholder or disabled-state label in an otherwise good design.
        const failRatio = textEls.length > 0 ? failing.length / textEls.length : 0;
        if (failing.length > 0 && (failRatio > 0.15 || failing[0]?.lc < 22)) {
            failing.sort((a, b) => a.lc - b.lc);
            const worst = failing[0];
            const zone = zoneDesc(worst.el.rect.x + worst.el.rect.w / 2, worst.el.rect.y + worst.el.rect.h / 2, vpW, vpH);
            findings.push({
                id: nid(),
                category: 'Perceptual Contrast',
                severity: failRatio > 0.30 || worst.lc < 18 ? 'critical' : 'warning',
                element: `${failing.length} text area${failing.length !== 1 ? 's' : ''} with low contrast (worst: ${zone} area)`,
                issue: `Found ${failing.length} place${failing.length !== 1 ? 's' : ''} where text does not stand out enough from the background. The hardest spot to read is in the ${zone} section of the page.`,
                recommendation: `Make the text darker (or the background lighter) in the ${zone} area. Apply the same fix to the other problem areas. A quick test: squint at the screen — if text starts merging with the background, the contrast needs improving.`,
                boundingBox: toBBox(worst.el.rect, vpW, vpH),
            });
        } else if (textEls.length > 0) {
            strengths.push('Text and icons have strong contrast throughout — everything should be easy to read.');
        }
    }

    // ── CHECK 2 — Optical Centering ────────────────────────────────────────────
    {
        let wx = 0, wy = 0, wTotal = 0, leftW = 0, rightW = 0;
        for (const el of vis) {
            // Images: CSS background is their parent's colour (usually white), not the
            // image content. Use an estimated mid-tone luminance so photos register
            // with meaningful visual weight instead of near-zero.
            const bgL = el.tag === 'img' ? 0.35 : luma(el.bg[0], el.bg[1], el.bg[2]);
            const area = el.rect.w * el.rect.h;
            const w = area * (1 - bgL);
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
        if (offsetMag > 0.10) {
            const parts = [];
            if (Math.abs(dxN) > 0.06) parts.push(dxN > 0 ? 'right' : 'left');
            if (Math.abs(dyN) > 0.06) parts.push(dyN > 0 ? 'downward' : 'upward');
            findings.push({
                id: nid(),
                category: 'Optical Centering',
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
        const lrTotal = leftW + rightW;
        const lrRatio = lrTotal > 0 ? Math.abs(leftW - rightW) / lrTotal : 0;
        if (lrRatio > 0.40) {
            const heavy = leftW > rightW ? 'left' : 'right';
            const light = heavy === 'left' ? 'right' : 'left';
            findings.push({
                id: nid(),
                category: 'Optical Centering',
                severity: lrRatio > 0.55 ? 'warning' : 'info',
                element: `Noticeably more visual weight on the ${heavy} side`,
                issue: `The ${heavy} side holds significantly more visual weight than the ${light} — this is often intentional in split-screen or sidebar layouts. If so, make sure your key content sits on the heavier side to take advantage of where the eye naturally lands first.`,
                recommendation: `If the imbalance is planned, no fix needed. If it surprised you, check whether a large dark container or image on the ${heavy} side can be lightened or resized without breaking the design intent.`,
                boundingBox: heavy === 'left' ? [0, 0, 1000, 500] : [0, 500, 1000, 1000],
            });
        } else {
            strengths.push('Left–right visual weight is well balanced.');
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
                // Same image fix as Check 2: treat img as mid-tone so photos count as focal points
                const fgL = e.tag === 'img' ? 0.35 : luma(e.bg[0], e.bg[1], e.bg[2]);
                const contrast = Math.abs(fgL - pageBgL);
                const area = (e.rect.w * e.rect.h) / (vpW * vpH);
                return { e, score: contrast * Math.sqrt(area) };
            })
            .filter(s => s.score > 0.01)
            .sort((a, b) => b.score - a.score);
        if (scored.length > 0) {
            const top = scored[0];
            const competing = scored.filter(s => s.score > top.score * 0.75).length;
            const dominanceRatio = scored.length > 1 ? top.score / scored[1].score : 999;
            if (competing >= 12) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: competing >= 18 ? 'warning' : 'info',
                    element: `No clear focal point: ${competing} areas pull attention equally`,
                    issue: `${competing} different areas of the page stand out at almost the same level, with no single spot clearly dominating. When everything looks equally important, people do not know where to look first and have to scan the whole page to understand it.`,
                    recommendation: 'Pick one area as the main focus — your headline, main button, or key information. Make everything else slightly less prominent: lighter backgrounds, smaller type, or less vivid colour.',
                    boundingBox: toBBox(top.e.rect, vpW, vpH),
                });
            } else if (competing <= 4 && dominanceRatio > 1.3) {
                strengths.push('There is a clear focal point — one area stands out right away, making it easy to know where to look first.');
            }
        }
    }

    // ── CHECK 4 — Tonal Range ──────────────────────────────────────────────────
    {
        const BANDS = 10;
        const hist = new Array(BANDS).fill(0);
        const seen = new Set();
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const key = `${Math.round(c[0] / 20)},${Math.round(c[1] / 20)},${Math.round(c[2] / 20)}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    const L = luma(c[0], c[1], c[2]);
                    hist[Math.min(BANDS - 1, Math.floor(L * BANDS))]++;
                }
            }
        }
        const total = seen.size;
        const threshold = Math.max(2, total * 0.03);
        const populated = hist.filter(c => c > threshold).length;
        if (populated <= 2) {
            findings.push({
                id: nid(),
                category: 'Tonal Range',
                severity: populated <= 1 ? 'warning' : 'info',
                element: `Very narrow tonal range, only ${populated} distinct brightness level${populated !== 1 ? 's' : ''} across the palette`,
                issue: `The whole design uses very few different levels of brightness. This can make it hard to tell backgrounds, cards, borders, and text apart at a glance. Some designs do this intentionally (monochromatic palettes can look very clean) but it is worth checking whether the page still reads clearly at different zoom levels.`,
                recommendation: 'If the tight palette is intentional, make sure there is enough contrast between key layers such as background, cards, and text. If it is not intentional, try introducing a few more distinct shades so that different parts of the page feel visually separate.',
            });
        } else if (populated >= 7) {
            strengths.push('Good range of light and dark shades — different parts of the page feel distinct and easy to tell apart.');
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
        if (chromaticRatio < 0.05) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'info',
                element: 'Almost no colour used',
                issue: 'The design is nearly all grey — there is almost no colour anywhere. Without colour, it is hard to spot buttons, links, or alerts at a glance. People have to read every label to know what is clickable or important.',
                recommendation: 'Add at least one colour for your main buttons or links, and consider green for success and red for errors. Even a single well-placed colour makes navigation much easier.',
            });
        } else if (dominantHues > 6) {
            findings.push({
                id: nid(),
                category: 'Colour Palette',
                severity: 'warning',
                element: `Too many colours: ${dominantHues} different colour families`,
                issue: `There are ${dominantHues} different colours competing for attention. When too many colours are used, none of them stand out and people cannot tell what is a button, what is a warning, or what is just decoration.`,
                recommendation: 'Stick to one main colour for buttons and links, and 2-3 extra colours for success, warning, and error messages. Ask yourself what does this colour mean — if you cannot answer clearly, it probably is not needed.',
            });
        } else if (dominantHues >= 2 && dominantHues <= 5 && chromaticRatio > 0.04) {
            strengths.push(`Colour is used sparingly — ${dominantHues} colour families keep things focused and meaningful.`);
        }
    }

    // ── CHECK 6 — Text Hierarchy ───────────────────────────────────────────────────
    {
        if (textEls.length >= 4) {
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
                    severity: 'warning',
                    element: 'All text looks the same size and weight',
                    issue: 'All text across the page is very similar in size and darkness — headings and body text look nearly identical. People have to read everything to figure out what is most important instead of spotting it at a glance.',
                    recommendation: 'Make your main headings noticeably bigger and bolder than body text, and make supporting labels slightly lighter or smaller. A clear size difference of at least 1.5x between headings and body text helps people scan quickly.',
                });
            } else if (sizeSpread >= 1.5 && lcSpread >= 25) {
                strengths.push('Text hierarchy is clear — there is a noticeable difference between headings and body text.');
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
        // Use a higher multiplier to avoid flagging navbars/footers with many nested DOM elements
        const hotThreshold = Math.max(median * 5, 15);
        const hotspots = [];
        for (let i = 0; i < SG * SG; i++) {
            if (cellCount[i] > hotThreshold) hotspots.push({ ri: Math.floor(i / SG), ci: i % SG, count: cellCount[i] });
        }
        if (hotspots.length >= 5) {
            hotspots.sort((a, b) => b.count - a.count);
            const worst = hotspots[0];
            const v = worst.ri < SG * 0.33 ? 'top' : worst.ri < SG * 0.67 ? 'middle' : 'bottom';
            const hDir = worst.ci < SG * 0.33 ? 'left' : worst.ci < SG * 0.67 ? 'centre' : 'right';
            findings.push({
                id: nid(),
                category: 'Spacing Rhythm',
                severity: hotspots.length >= 8 ? 'warning' : 'info',
                element: `${hotspots.length} overcrowded area${hotspots.length !== 1 ? 's' : ''}, most dense in the ${v}-${hDir}`,
                issue: `${hotspots.length} area${hotspots.length !== 1 ? 's' : ''} on the page have significantly more elements packed in than the rest of the layout. Crowded zones make it hard to separate content from structure and can feel overwhelming.`,
                recommendation: 'Add more breathing room in the crowded areas — increase space inside and around elements, and consider moving less-important content to a secondary section so the main content can breathe.',
                boundingBox: [
                    Math.round((worst.ri / SG) * 1000),
                    Math.round((worst.ci / SG) * 1000),
                    Math.round(((worst.ri + 1) / SG) * 1000),
                    Math.round(((worst.ci + 1) / SG) * 1000),
                ],
            });
        } else {
            strengths.push('Good spacing throughout — areas have enough breathing room and nothing feels too cramped.');
        }
    }

    // ── CHECK 8 — Edge Margin Breathing Room ───────────────────────────────────
    {
        const minMargin = Math.min(vpW, vpH) * 0.035;
        const edgePressers = vis.filter(e => {
            // Exclude full-width backgrounds and intentional edge-to-edge sections
            if (e.rect.w >= vpW * 0.92 || e.rect.h >= vpH * 0.92) return false;
            // Exclude elements in the top nav band or bottom footer band
            if (e.rect.y < vpH * 0.07 || e.rect.y + e.rect.h > vpH * 0.93) return false;
            return (
                e.rect.x < minMargin || e.rect.x + e.rect.w > vpW - minMargin
            );
        });
        if (edgePressers.length > 15) {
            findings.push({
                id: nid(),
                category: 'Spacing Rhythm',
                severity: 'warning',
                element: `${edgePressers.length} elements pressing against the screen edge`,
                issue: `${edgePressers.length} elements are placed very close to the edge of the screen with almost no gap around them. This can make the page feel cramped and unfinished — like a photo printed right to the edge of the paper.`,
                recommendation: 'Add a consistent space (at least 24 to 48 px on desktop) around all four sides of your content. This one change makes the design feel noticeably more polished and professional.',
                boundingBox: toBBox(edgePressers[0].rect, vpW, vpH),
            });
        } else {
            strengths.push('There is good space around the edges — the page feels contained and not cramped.');
        }
    }

    // ── CHECK 9 — Vertical Weight Distribution ──────────────────────────────────
    {
        const third = vpH / 3;
        let topW = 0, midW = 0, botW = 0;
        for (const el of vis) {
            const cy = el.rect.y + el.rect.h / 2;
            // Same image fix: use mid-tone estimate so photos in hero/bottom sections have weight
            const bgL = el.tag === 'img' ? 0.35 : luma(el.bg[0], el.bg[1], el.bg[2]);
            const w = (el.rect.w * el.rect.h) / (vpW * vpH) * (1 - bgL);
            if (cy < third) topW += w;
            else if (cy < third * 2) midW += w;
            else botW += w;
        }
        const botVsMid = midW > 0 ? botW / midW : 1;
        const topVsBot = botW > 0 ? topW / botW : 1;
        if (botVsMid > 1.8 && botW > topW) {
            findings.push({
                id: nid(),
                category: 'Optical Centering',
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
                if (hdiff >= 0.28 && hdiff <= 0.65) vibEdges++;
            }
        }
        if (chromaEdges > 5) {
            const vibRatio = vibEdges / chromaEdges;
            if (vibRatio > 0.30) {
                findings.push({
                    id: nid(),
                    category: 'Perceptual Contrast',
                    severity: vibRatio > 0.50 ? 'warning' : 'info',
                    element: 'Clashing colour pairs: vivid opposite colours placed directly next to each other',
                    issue: 'Some vivid colours sit directly next to their opposite colours (like bright red next to cyan, or orange next to blue). When two strong opposite colours touch, the edge between them can appear to shimmer or vibrate, making the design tiring to look at.',
                    recommendation: 'Place a thin line of white, grey, or black between the clashing colour pairs, or make one of the colours less vivid.',
                });
            } else {
                strengths.push('No clashing colour pairs — vivid colours are well-separated, so edges look clean and stable.');
            }
        }
    }

    // ── CHECK 11 — Grid Alignment Signal ──────────────────────────────────────
    {
        const leftEdges = vis
            .filter(e => e.rect.w < vpW * 0.85 && e.rect.w > 20)
            .map(e => Math.round(e.rect.x / 8) * 8);
        if (leftEdges.length >= 10) {
            const edgeCounts = {};
            leftEdges.forEach(x => { edgeCounts[x] = (edgeCounts[x] || 0) + 1; });
            const values = Object.values(edgeCounts).sort((a, b) => b - a);
            const top5 = values.slice(0, 5).reduce((s, v) => s + v, 0);
            const concentration = top5 / leftEdges.length;
            const peakBins = values.filter(v => v >= Math.max(3, values[0] * 0.4)).length;
            if (concentration < 0.22 && peakBins < 2) {
                findings.push({
                    id: nid(),
                    category: 'Visual Hierarchy',
                    severity: 'info',
                    element: 'Elements do not share a consistent column structure',
                    issue: 'Elements across the page start at many different positions instead of lining up with each other. This makes the layout feel like things were placed individually rather than following a plan, and can feel messy even when each piece looks fine on its own.',
                    recommendation: 'Try to align the left edges of your content to a few shared positions — imagine invisible vertical guide lines running down the page. Even aligning to just 2 or 3 shared positions makes the layout look much more organised.',
                });
            } else if (concentration >= 0.30 && peakBins >= 2 && peakBins <= 8) {
                strengths.push(`Good structure — elements line up in ${peakBins} consistent columns, giving the page an organised look.`);
            }
        }
    }

    // ── CHECK 12 — Colour Temperature Consistency ─────────────────────────────
    {
        let shSin = 0, shCos = 0, shN = 0, hiSin = 0, hiCos = 0, hiN = 0;
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
                if (s < 0.1) continue;
                const angle = h * 2 * Math.PI;
                if (l < 0.25) { shSin += Math.sin(angle); shCos += Math.cos(angle); shN++; }
                else if (l > 0.70) { hiSin += Math.sin(angle); hiCos += Math.cos(angle); hiN++; }
            }
        }
        if (shN >= 5 && hiN >= 5) {
            const shMean = ((Math.atan2(shSin / shN, shCos / shN) / (2 * Math.PI)) + 1) % 1;
            const hiMean = ((Math.atan2(hiSin / hiN, hiCos / hiN) / (2 * Math.PI)) + 1) % 1;
            const wrapped = Math.min(Math.abs(shMean - hiMean), 1 - Math.abs(shMean - hiMean));
            const isWarm = (h) => h < 0.17 || h > 0.88;
            const isCool = (h) => h > 0.50 && h < 0.72;
            if (wrapped < 0.04) {
                findings.push({
                    id: nid(),
                    category: 'Colour Temperature',
                    severity: 'info',
                    element: 'Light and dark areas use the same colour tone',
                    issue: 'The light and dark areas of the design lean toward the same colour temperature — both warm or both cool. Professional designs pair warm highlights with cool shadows (or the reverse), which gives the palette a sense of depth and richness.',
                    recommendation: 'Try making your bright areas slightly warmer (a hint of cream or ivory) while letting your dark areas go a touch cooler (a hint of blue-grey), or vice versa. This small shift adds life to the palette without changing the overall look.',
                });
            } else if (wrapped >= 0.10 && ((isWarm(shMean) && isCool(hiMean)) || (isCool(shMean) && isWarm(hiMean)))) {
                strengths.push('Light and dark areas use complementary colour tones — this gives the design a sense of depth and richness.');
            }
        }
    }

    // ── CHECK 13 — Line Length ──────────────────────────────────────────────────
    // Source: Refactoring UI — "Line Length Thresholds"
    // Optimal reading line: 45–75 characters. Estimated from rect.w / (fontSize × 0.55).
    {
        const charWidthFactor = 0.55;
        const maxChars = 75;
        const bodyFontMin = 13;
        const bodyFontMax = 22;
        const minWidth = 200;
        const minViolations = 3;
        const warningCount = 6;
        const bodyText = vis.filter(e =>
            e.isText &&
            e.fontSize >= bodyFontMin &&
            e.fontSize <= bodyFontMax &&
            e.rect.w >= minWidth
        );
        const tooWide = bodyText.filter(
            e => (e.rect.w / (e.fontSize * charWidthFactor)) > maxChars
        );
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
        } else if (bodyText.length >= 3) {
            strengths.push('Text blocks are a comfortable width for reading.');
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
        const chromaticSamples = [];
        const greySats = [];
        for (const el of vis) {
            for (const c of [el.color, el.bg]) {
                const [h, s, l] = rgbToHsl(c[0], c[1], c[2]);
                if (s >= chromaticSatMin && l > 0.1 && l < 0.9) {
                    chromaticSamples.push(h);
                }
                if (s < greySatMax && l >= greyLumaMin && l <= greyLumaMax) {
                    greySats.push(s);
                }
            }
        }
        if (chromaticSamples.length >= minChromatic && greySats.length >= minGreys) {
            const avgGreySat = greySats.reduce((a, s) => a + s, 0) / greySats.length;
            if (avgGreySat < tintedSatMin) {
                findings.push({
                    id: nid(),
                    category: 'Colour Palette',
                    severity: 'info',
                    element: 'Grey surfaces appear completely neutral against the primary colour',
                    issue: 'The interface has a defined primary colour but its grey backgrounds and borders are pure neutral grey with no hint of that colour. Pure greys can feel slightly cold or disconnected from the rest of the palette, especially next to vivid or warm tones.',
                    recommendation: 'Try adding a very small amount of your primary hue to grey backgrounds and borders — just enough that the grey reads as warm or cool rather than completely neutral. Often a 2 to 5% saturation shift is all it takes.',
                });
            }
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

    const categories = [...new Set(findings.map(f => f.category))];
    return {
        summary: findings.length === 0
            ? 'No significant perceptual issues detected. The page passes all checks.'
            : `Analysis found ${findings.length} issue${findings.length !== 1 ? 's' : ''} across ${categories.length} categor${categories.length !== 1 ? 'ies' : 'y'}: ${categories.join(', ')}.`,
        overallScore,
        findings,
        strengths: strengths.slice(0, 6),
        expertNote: 'These results are based on computed CSS values and element positions extracted from the live page. Results may differ at different screen sizes or in browsers with different font rendering. Interactive states (hover, focus, animation) and dynamically loaded content after the initial render are not captured in the audit snapshot.',
    };
}
