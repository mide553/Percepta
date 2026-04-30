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

	// Analyze color palette
	const colors = cssData.colors;
	if (colors.length > 0) {
		if (colors.length > 30) {
			findings.push({
				category: 'Colour Palette',
				severity: 'info',
				issue: `The CSS uses ${colors.length} different color values. A large number of unique colors can make the design feel inconsistent and harder to maintain.`,
				recommendation: 'Consider consolidating to a defined color palette using CSS variables. Aim for 8-12 shades per color family (greys, primary, accents).',
			});
		} else if (colors.length <= 15 && cssData.cssVariables.some(v => v.name.includes('color'))) {
			strengths.push('CSS uses a well-defined color palette with CSS variables for consistency.');
		}
	}

	// Analyze font families
	const definedFonts = cssData.fonts || [];
	const usedFonts = cssData.usedFonts || [];
	const fontMetric = usedFonts.length > 0 ? usedFonts.length : definedFonts.length;
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

	// Analyze media queries for responsive design
	const allMediaQueries = cssData.stylesheets.flatMap(s => s.mediaQueries);
	if (allMediaQueries.length === 0) {
		findings.push({
			category: 'Spacing & Layout',
			severity: 'warning',
			issue: 'No responsive media queries detected. The site may not adapt well to different screen sizes.',
			recommendation: 'Add media queries to adjust layout, spacing, and font sizes for mobile, tablet, and desktop viewports.',
		});
	} else {
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
	} else {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: 'No CSS custom properties (variables) detected. Using CSS variables makes themes and design system changes much easier.',
			recommendation: 'Define CSS variables for colors, spacing, and font sizes in :root to enable easy theme adjustments.',
		});
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

	if (rulesWithShadows.length === 0) {
		findings.push({
			category: 'Visual Polish',
			severity: 'info',
			issue: 'No box-shadow properties detected. Subtle shadows add depth and help distinguish interactive elements from the background.',
			recommendation: 'Add subtle shadows to cards, buttons, and floating elements. Example: box-shadow: 0 2px 4px rgba(0,0,0,0.1);',
		});
	} else {
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
	const textAlignRules = cssData.stylesheets.flatMap(sheet =>
		sheet.rules.filter(rule => rule.styles['text-align'])
	);

	const centerAlignedCount = textAlignRules.filter(r => r.styles['text-align'] === 'center').length;
	if (centerAlignedCount > textAlignRules.length * 0.5 && textAlignRules.length > 10) {
		findings.push({
			category: 'Typography',
			severity: 'info',
			issue: `Many elements use center text alignment (${centerAlignedCount} rules). Center-aligned body text is harder to read than left-aligned text.`,
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
		summary: `Analyzed ${cssData.stylesheets.length} stylesheets with ${colors.length} colors and ${fontMetric} font families.`,
	};
}
