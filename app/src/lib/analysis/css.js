/**
 * CSS Analysis Module
 * Analyzes stylesheets extracted from inspected websites
 */

/**
 * Extracts and analyzes CSS from a page using Puppeteer
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Object>} CSS analysis results
 */
export async function extractAndAnalyzeCSS(page) {
	const cssData = await page.evaluate(() => {
		const results = {
			stylesheets: [],
			inlineStyles: [],
			computedStyles: {},
			cssVariables: [],
			mediaQueries: [],
			keyframes: [],
			fonts: new Set(),
			usedFonts: new Set(),
			colors: new Set(),
		};

		// Helper: check if element is in viewport (visible in screenshot area)
		const isInViewport = (el) => {
			const rect = el.getBoundingClientRect();
			const vpWidth = window.innerWidth;
			const vpHeight = window.innerHeight;
			// Element is in viewport if it overlaps with visible area (at least partially)
			return (
				rect.bottom > 0 &&
				rect.right > 0 &&
				rect.top < vpHeight &&
				rect.left < vpWidth
			);
		};

		// Extract all stylesheets
		const sheets = Array.from(document.styleSheets);
		for (const sheet of sheets) {
			try {
				const rules = Array.from(sheet.cssRules || sheet.rules || []);
				const sheetData = {
					href: sheet.href,
					rules: [],
					mediaQueries: [],
					keyframes: [],
				};

				for (const rule of rules) {
					// Handle different rule types
					if (rule instanceof CSSStyleRule) {
						const ruleData = {
							selector: rule.selectorText,
							styles: {},
						};

						for (let i = 0; i < rule.style.length; i++) {
							const prop = rule.style[i];
							const value = rule.style.getPropertyValue(prop);
							ruleData.styles[prop] = value;

							// Extract colors
							if (value.match(/#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|hsla\(/)) {
								results.colors.add(value);
							}

							// Extract fonts — normalize to primary family name so "Inter, sans-serif"
							// and '"Inter", sans-serif' don't count as separate entries.
							if (prop === 'font-family') {
								const primary = value.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
								if (primary) results.fonts.add(primary);
							}
						}

						sheetData.rules.push(ruleData);
					} else if (rule instanceof CSSMediaRule) {
						sheetData.mediaQueries.push({
							media: rule.conditionText || rule.media.mediaText,
							rules: Array.from(rule.cssRules).map(r => ({
								selector: r.selectorText,
								text: r.cssText,
							})),
						});
					} else if (rule instanceof CSSKeyframesRule) {
						sheetData.keyframes.push({
							name: rule.name,
							keyframes: Array.from(rule.cssRules).map(kf => ({
								keyText: kf.keyText,
								style: kf.style.cssText,
							})),
						});
					}
				}

				results.stylesheets.push(sheetData);
			} catch (e) {
				// CORS or other access errors - skip this stylesheet
				console.warn('Cannot access stylesheet:', sheet.href, e.message);
			}
		}

		// Extract inline styles — ONLY from elements visible in viewport
		const elementsWithInlineStyles = document.querySelectorAll('[style]');
		elementsWithInlineStyles.forEach(el => {
			if (isInViewport(el)) {
				results.inlineStyles.push({
					tag: el.tagName.toLowerCase(),
					style: el.getAttribute('style'),
				});
			}
		});

		// Extract fonts actually used by visible text-like elements in the viewport.
		// This avoids overcounting every declared fallback stack in the stylesheet.
		const textLikeEls = document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,a,button,label,li,input,textarea,select');
		textLikeEls.forEach(el => {
			if (!isInViewport(el)) return;
			const ff = window.getComputedStyle(el).fontFamily || '';
			const primary = ff.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
			if (primary) results.usedFonts.add(primary);
		});

		// Extract CSS variables
		const rootStyles = window.getComputedStyle(document.documentElement);
		for (let i = 0; i < rootStyles.length; i++) {
			const prop = rootStyles[i];
			if (prop.startsWith('--')) {
				results.cssVariables.push({
					name: prop,
					value: rootStyles.getPropertyValue(prop).trim(),
				});
			}
		}

		// Convert Sets to Arrays for JSON serialization
		return {
			...results,
			fonts: Array.from(results.fonts),
			usedFonts: Array.from(results.usedFonts),
			colors: Array.from(results.colors),
		};
	});

	// Analyze the extracted CSS data
	return analyzeCSS(cssData);
}

/**
 * Analyzes extracted CSS data for patterns and issues
 * @param {Object} cssData - Extracted CSS data
 * @returns {Object} Analysis results with findings
 */
function analyzeCSS(cssData) {
	const findings = [];
	const strengths = [];

	const normalizeColor = (input) => {
		if (!input || typeof input !== 'string') return null;
		const color = input.trim().toLowerCase();

		const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
		if (hex) {
			let h = hex[1];
			if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
			const r = parseInt(h.slice(0, 2), 16);
			const g = parseInt(h.slice(2, 4), 16);
			const b = parseInt(h.slice(4, 6), 16);
			return `${r},${g},${b}`;
		}

		const rgb = color.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		if (rgb) {
			return `${Math.min(255, +rgb[1])},${Math.min(255, +rgb[2])},${Math.min(255, +rgb[3])}`;
		}

		const hsl = color.match(/^hsla?\(([-\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/);
		if (hsl) {
			const h = ((+hsl[1] % 360) + 360) % 360;
			const s = Math.max(0, Math.min(1, +hsl[2] / 100));
			const l = Math.max(0, Math.min(1, +hsl[3] / 100));
			const c = (1 - Math.abs(2 * l - 1)) * s;
			const x = c * (1 - Math.abs((h / 60) % 2 - 1));
			const m = l - c / 2;
			let r = 0, g = 0, b = 0;
			if (h < 60) [r, g, b] = [c, x, 0];
			else if (h < 120) [r, g, b] = [x, c, 0];
			else if (h < 180) [r, g, b] = [0, c, x];
			else if (h < 240) [r, g, b] = [0, x, c];
			else if (h < 300) [r, g, b] = [x, 0, c];
			else [r, g, b] = [c, 0, x];
			return `${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)}`;
		}

		return null;
	};

	// Analyze color palette
	const colors = cssData.colors;
	const normalizedColors = new Set(colors.map(normalizeColor).filter(Boolean));
	const uniqueColorCount = normalizedColors.size;
	if (colors.length > 0) {
		if (uniqueColorCount > 50) {
			findings.push({
				category: 'Colour Palette',
				severity: 'info',
				issue: `The CSS uses about ${uniqueColorCount} distinct colors after normalization. A large number of unique colors can make the design feel inconsistent and harder to maintain.`,
				recommendation: 'Consolidate to a smaller, intentional palette. Reuse existing shades before introducing new ones, and keep color roles consistent across components.',
			});
		} else if (uniqueColorCount <= 15 && cssData.cssVariables.some(v => v.name.includes('color'))) {
			strengths.push('CSS uses a well-defined color palette with CSS variables for consistency.');
		}
	}

	// Analyze font families
	const definedFonts = cssData.fonts || [];
	const usedFonts = cssData.usedFonts || [];
	const FONT_IGNORE = [
		'font awesome', 'material icons', 'ionicons', 'bootstrap-icons',
		'arial', 'helvetica', 'sans-serif', 'serif', 'monospace',
		'system-ui', '-apple-system', 'segoe ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace'
	];
	const filterFonts = (fonts) => fonts.filter(font => !FONT_IGNORE.some(ignore => font.includes(ignore)));
	const effectiveUsedFonts = filterFonts(usedFonts);
	const effectiveDefinedFonts = filterFonts(definedFonts);
	const fontMetric = effectiveUsedFonts.length > 0 ? effectiveUsedFonts.length : effectiveDefinedFonts.length;
	if (fontMetric > 4) {
		findings.push({
			category: 'Typography',
			severity: 'warning',
			issue: `${fontMetric} different font families are used in visible text. Using too many fonts creates visual inconsistency and slows page load.`,
			recommendation: 'Limit to 2-3 font families maximum: one for headings, one for body text, and optionally one for monospace code.',
		});
	} else if (fontMetric <= 3) {
		strengths.push('Font usage is restrained — limited to a focused set of typefaces.');
	}

	// Analyze media queries for responsive design (advisory only; no finding)
	const allMediaQueries = cssData.stylesheets.flatMap(s => s.mediaQueries);
	if (allMediaQueries.length > 0) {
		strengths.push(`Responsive design detected with ${allMediaQueries.length} media queries for different screen sizes.`);
	}

	// Analyze CSS animations
	const animations = cssData.stylesheets.flatMap(s => s.keyframes);
	if (animations.length > 10) {
		findings.push({
			category: 'Visual Polish',
			severity: 'info',
			issue: `${animations.length} CSS animations defined. Excessive animations can distract users and impact performance.`,
			recommendation: 'Review which animations are essential. Reserve motion for meaningful transitions and feedback, not decoration.',
		});
	}

	// Analyze inline styles
	if (cssData.inlineStyles.length > 20) {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: `${cssData.inlineStyles.length} elements use inline styles. Inline styles are harder to maintain and override CSS cascade rules.`,
			recommendation: 'Move inline styles to CSS classes for better maintainability and consistency.',
		});
	}

	// Analyze CSS variables usage
	if (cssData.cssVariables.length > 0) {
		strengths.push(`CSS custom properties (variables) are being used — ${cssData.cssVariables.length} variables defined.`);
	}

	// Check for !important overuse
	const importantCount = cssData.stylesheets.reduce((count, sheet) => {
		return count + sheet.rules.filter(rule =>
			Object.values(rule.styles).some(v => v.includes('!important'))
		).length;
	}, 0);

	if (importantCount > 15) {
		findings.push({
			category: 'Code Quality',
			severity: 'warning',
			issue: `${importantCount} CSS rules use !important. Overusing !important indicates specificity problems and makes styles harder to override.`,
			recommendation: 'Refactor CSS to use proper specificity instead of !important. Reserve !important only for utility classes.',
		});
	}

	// Check for border usage patterns
	const rulesWithBorders = cssData.stylesheets.flatMap(sheet =>
		sheet.rules.filter(rule =>
			rule.styles['border'] || rule.styles['border-top'] || rule.styles['border-bottom'] ||
			rule.styles['border-left'] || rule.styles['border-right']
		)
	);

	if (rulesWithBorders.length > 0) {
		strengths.push(`Borders are used in ${rulesWithBorders.length} rules for visual separation and emphasis.`);
	}

	// Check for box-shadow usage
	const rulesWithShadows = cssData.stylesheets.flatMap(sheet =>
		sheet.rules.filter(rule => rule.styles['box-shadow'] && rule.styles['box-shadow'] !== 'none')
	);

	if (rulesWithShadows.length > 0) {
		strengths.push(`Shadows are used effectively in ${rulesWithShadows.length} rules for depth and hierarchy.`);
	}

	// Check for letter-spacing on uppercase text
	const letterSpacingRules = cssData.stylesheets.flatMap(sheet =>
		sheet.rules.filter(rule =>
			rule.styles['letter-spacing'] && rule.styles['text-transform'] === 'uppercase'
		)
	);

	if (letterSpacingRules.length > 0) {
		strengths.push('Letter-spacing is applied to uppercase text for improved readability.');
	}

	// Check for text-align usage
	const centeredBodyText = cssData.stylesheets.flatMap(sheet =>
		sheet.rules.filter(rule => {
			const align = (rule.styles['text-align'] || '').trim().toLowerCase();
			if (align !== 'center') return false;
			const selector = (rule.selector || '').toLowerCase();
			return /(^|[\s>+~,])(p|article|body|main)\b|\.text\b|\.content\b/.test(selector);
		})
	);

	if (centeredBodyText.length > 3) {
		findings.push({
			category: 'Typography',
			severity: 'info',
			issue: `Centered alignment is used on body-text selectors in ${centeredBodyText.length} CSS rules. Long-form body text is usually easier to read when left-aligned.`,
			recommendation: 'Reserve center alignment for headings and short text. Use left alignment (or right for RTL languages) for paragraphs and body content.',
		});
	}

	// Check for em/rem unit usage
	const emRemUnits = [];
	cssData.stylesheets.forEach(sheet => {
		sheet.rules.forEach(rule => {
			Object.entries(rule.styles).forEach(([prop, value]) => {
				if (value && (value.includes('em') || value.includes('rem')) && !value.includes('rem')) {
					emRemUnits.push({ selector: rule.selector, property: prop, value });
				}
			});
		});
	});

	if (emRemUnits.length > 10) {
		strengths.push('Relative units (em/rem) are used for flexible, scalable typography and spacing.');
	}

	// Check for consistent spacing patterns
	const spacingProperties = ['margin', 'padding', 'gap'];
	const spacingValues = new Set();
	cssData.stylesheets.forEach(sheet => {
		sheet.rules.forEach(rule => {
			spacingProperties.forEach(prop => {
				if (rule.styles[prop]) {
					spacingValues.add(rule.styles[prop]);
				}
				// Also check directional properties
				['top', 'bottom', 'left', 'right'].forEach(dir => {
					const fullProp = `${prop}-${dir}`;
					if (rule.styles[fullProp]) {
						spacingValues.add(rule.styles[fullProp]);
					}
				});
			});
		});
	});

	if (spacingValues.size > 40) {
		findings.push({
			category: 'Spacing & Layout',
			severity: 'info',
			issue: `${spacingValues.size} different spacing values detected. Inconsistent spacing creates a disjointed visual rhythm.`,
			recommendation: 'Establish a spacing scale (e.g., 4px, 8px, 16px, 24px, 32px) and use CSS variables. Example: --spacing-sm: 8px; --spacing-md: 16px;',
		});
	}

	return {
		cssData,
		findings,
		strengths,
		summary: `Analyzed ${cssData.stylesheets.length} stylesheets with ${uniqueColorCount} distinct colors and ${fontMetric} non-system font families.`,
	};
}
