/**
 * HTML Structure Analysis Module
 * Analyzes HTML structure, semantics, and accessibility
 */

/**
 * Extracts and analyzes HTML structure from a page using Puppeteer
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Object>} HTML analysis results
 */
export async function extractAndAnalyzeHTML(page) {
	const htmlData = await page.evaluate(() => {
		const results = {
			doctype: document.doctype ? document.doctype.name : null,
			lang: document.documentElement.lang || null,
			metaTags: [],
			headings: [],
			links: [],
			images: [],
			forms: [],
			semanticElements: {
				header: 0,
				nav: 0,
				main: 0,
				article: 0,
				section: 0,
				aside: 0,
				footer: 0,
			},
			ariaAttributes: [],
			altTextMissing: 0,
			headingStructure: [],
			blockquotes: [],
			tables: [],
			buttons: [],
			dropdowns: [],
			checkboxRadio: [],
			icons: [],
			modals: [],
			lists: [],
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

		// Extract meta tags (keep all — they're document-level, not position-dependent)
		document.querySelectorAll('meta').forEach(meta => {
			results.metaTags.push({
				name: meta.getAttribute('name') || meta.getAttribute('property'),
				content: meta.getAttribute('content'),
			});
		});

		// Extract heading hierarchy — ONLY visible headings
		const headingTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
		headingTags.forEach(tag => {
			document.querySelectorAll(tag).forEach(heading => {
				if (isInViewport(heading)) {
					results.headings.push({
						level: parseInt(tag[1]),
						text: heading.textContent.trim().slice(0, 100),
						hasId: !!heading.id,
					});
				}
			});
		});

		// Build heading structure tree
		let currentH1 = null;
		let currentH2 = null;
		results.headings.forEach(h => {
			if (h.level === 1) {
				currentH1 = { ...h, children: [] };
				results.headingStructure.push(currentH1);
				currentH2 = null;
			} else if (h.level === 2 && currentH1) {
				currentH2 = { ...h, children: [] };
				currentH1.children.push(currentH2);
			} else if (h.level >= 3 && currentH2) {
				currentH2.children.push(h);
			}
		});

		// Extract links — ONLY visible links
		document.querySelectorAll('a').forEach(link => {
			if (isInViewport(link)) {
				results.links.push({
					href: link.href,
					text: link.textContent.trim().slice(0, 50),
					hasTitle: !!link.title,
					isExternal: link.hostname !== window.location.hostname,
					opensNewTab: link.target === '_blank',
				});
			}
		});

		// Extract images — ONLY visible images
		document.querySelectorAll('img').forEach(img => {
			if (isInViewport(img)) {
				const hasAlt = img.hasAttribute('alt');
				const altText = img.getAttribute('alt');
				results.images.push({
					src: img.src,
					hasAlt,
					altText: hasAlt ? altText : null,
					isDecorative: hasAlt && altText === '',
				});
				if (!hasAlt) results.altTextMissing++;
			}
		});

		// Extract forms — ONLY visible forms
		document.querySelectorAll('form').forEach(form => {
			if (isInViewport(form)) {
				const formData = {
					action: form.action,
					method: form.method,
					inputs: [],
				};

				form.querySelectorAll('input, textarea, select').forEach(input => {
					formData.inputs.push({
						type: input.type || input.tagName.toLowerCase(),
						name: input.name,
						id: input.id,
						hasLabel: !!form.querySelector(`label[for="${input.id}"]`) || !!input.closest('label'),
						required: input.hasAttribute('required'),
						placeholder: input.placeholder,
					});
				});

				results.forms.push(formData);
			}
		});

		// Count semantic elements — ONLY visible ones
		Object.keys(results.semanticElements).forEach(tag => {
			const allElements = document.querySelectorAll(tag);
			results.semanticElements[tag] = Array.from(allElements).filter(el => isInViewport(el)).length;
		});

		// Extract ARIA attributes — ONLY from visible elements
		document.querySelectorAll('[role], [aria-label], [aria-labelledby], [aria-describedby]').forEach(el => {
			if (isInViewport(el)) {
				results.ariaAttributes.push({
					tag: el.tagName.toLowerCase(),
					role: el.getAttribute('role'),
					ariaLabel: el.getAttribute('aria-label'),
					ariaLabelledby: el.getAttribute('aria-labelledby'),
					ariaDescribedby: el.getAttribute('aria-describedby'),
				});
			}
		});

		// Extract blockquote elements (testimonials) — ONLY visible
		document.querySelectorAll('blockquote').forEach(blockquote => {
			if (isInViewport(blockquote)) {
				results.blockquotes.push({
					text: blockquote.textContent.trim().slice(0, 100),
					hasCite: !!blockquote.querySelector('cite'),
				});
			}
		});

		// Extract table elements — ONLY visible
		document.querySelectorAll('table').forEach(table => {
			if (isInViewport(table)) {
				results.tables.push({
					hasCaption: !!table.querySelector('caption'),
					hasThead: !!table.querySelector('thead'),
					rowCount: table.querySelectorAll('tr').length,
				});
			}
		});

		// Extract button elements — ONLY visible
		document.querySelectorAll('button, input[type="button"], input[type="submit"]').forEach(btn => {
			if (isInViewport(btn)) {
				results.buttons.push({
					text: btn.textContent.trim().slice(0, 50),
					type: btn.type || 'button',
					disabled: btn.disabled,
				});
			}
		});

		// Extract dropdown/select elements — ONLY visible
		document.querySelectorAll('select, [aria-expanded]').forEach(el => {
			if (isInViewport(el)) {
				results.dropdowns.push({
					tag: el.tagName.toLowerCase(),
					ariaExpanded: el.getAttribute('aria-expanded'),
					hasOptions: el.tagName.toLowerCase() === 'select',
				});
			}
		});

		// Extract checkbox and radio inputs — ONLY visible
		document.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach(input => {
			if (isInViewport(input)) {
				results.checkboxRadio.push({
					type: input.type,
					name: input.name,
					checked: input.checked,
				});
			}
		});

		// Extract SVG elements and small images (icons) — ONLY visible
		document.querySelectorAll('svg').forEach(svg => {
			if (isInViewport(svg)) {
				const rect = svg.getBoundingClientRect();
				results.icons.push({
					type: 'svg',
					width: rect.width,
					height: rect.height,
				});
			}
		});

		document.querySelectorAll('img').forEach(img => {
			if (isInViewport(img)) {
				const rect = img.getBoundingClientRect();
				// Consider images smaller than 64x64 as icons
				if (rect.width <= 64 && rect.height <= 64) {
					results.icons.push({
						type: 'img',
						width: rect.width,
						height: rect.height,
						src: img.src,
					});
				}
			}
		});

		// Extract modal/dialog elements — ONLY visible
		document.querySelectorAll('[role="dialog"], dialog').forEach(dialog => {
			if (isInViewport(dialog)) {
				results.modals.push({
					tag: dialog.tagName.toLowerCase(),
					ariaLabel: dialog.getAttribute('aria-label'),
					ariaLabelledby: dialog.getAttribute('aria-labelledby'),
				});
			}
		});

		// Extract list elements — ONLY visible
		document.querySelectorAll('ul, ol').forEach(list => {
			if (isInViewport(list)) {
				results.lists.push({
					type: list.tagName.toLowerCase(),
					itemCount: list.querySelectorAll('li').length,
				});
			}
		});

		return results;
	});

	// Analyze the extracted HTML data
	return analyzeHTML(htmlData);
}

/**
 * Analyzes extracted HTML data for structure, semantics, and accessibility
 * @param {Object} htmlData - Extracted HTML data
 * @returns {Object} Analysis results with findings
 */
function analyzeHTML(htmlData) {
	const findings = [];
	const strengths = [];

	// Check DOCTYPE
	if (!htmlData.doctype || htmlData.doctype !== 'html') {
		findings.push({
			category: 'Code Quality',
			severity: 'warning',
			issue: 'Missing or incorrect DOCTYPE declaration. This can trigger quirks mode in browsers.',
			recommendation: 'Add <!DOCTYPE html> as the first line of your HTML document.',
		});
	}

	// Check lang attribute
	if (!htmlData.lang) {
		findings.push({
			category: 'Accessibility',
			severity: 'warning',
			issue: 'No lang attribute on <html> element. Screen readers need this to pronounce text correctly.',
			recommendation: 'Add lang="en" (or appropriate language code) to the <html> tag.',
		});
	}

	// Check heading hierarchy
	const h1Count = htmlData.headings.filter(h => h.level === 1).length;
	if (h1Count === 0) {
		findings.push({
			category: 'Accessibility',
			severity: 'warning',
			issue: 'No <h1> heading found. Every page should have exactly one main heading that describes the page content.',
			recommendation: 'Add a single <h1> element as the main page heading.',
		});
	} else if (h1Count > 1) {
		findings.push({
			category: 'Accessibility',
			severity: 'info',
			issue: `${h1Count} <h1> headings found. Best practice is to use a single <h1> per page.`,
			recommendation: 'Use only one <h1> for the main page title, and use <h2>-<h6> for subheadings.',
		});
	}

	// Check for heading level skips
	for (let i = 1; i < htmlData.headings.length; i++) {
		const prev = htmlData.headings[i - 1].level;
		const curr = htmlData.headings[i].level;
		if (curr > prev + 1) {
			findings.push({
				category: 'Accessibility',
				severity: 'info',
				issue: `Heading hierarchy skips from <h${prev}> to <h${curr}>. Screen reader users rely on logical heading order.`,
				recommendation: 'Keep heading levels sequential: h1 → h2 → h3, not h1 → h3.',
			});
			break; // Only report once
		}
	}

	// Check semantic HTML usage
	const { header, nav, main, footer } = htmlData.semanticElements;
	if (!header && !nav && !main && !footer) {
		findings.push({
			category: 'Accessibility',
			severity: 'warning',
			issue: 'No semantic HTML5 elements detected (<header>, <nav>, <main>, <footer>). Using divs everywhere makes the page structure unclear.',
			recommendation: 'Replace generic <div> containers with semantic elements like <header>, <nav>, <main>, <article>, <section>, and <footer>.',
		});
	} else {
		const semanticCount = header + nav + main + footer;
		strengths.push(`Semantic HTML5 elements are used (${semanticCount} landmarks detected), improving accessibility.`);
	}

	// Check for multiple <main> elements
	if (htmlData.semanticElements.main > 1) {
		findings.push({
			category: 'Accessibility',
			severity: 'warning',
			issue: `${htmlData.semanticElements.main} <main> elements found. A page should have only one <main> landmark.`,
			recommendation: 'Use a single <main> element to wrap the primary content of the page.',
		});
	}

	// Check alt text on images
	if (htmlData.altTextMissing > 0) {
		findings.push({
			category: 'Accessibility',
			severity: 'critical',
			issue: `${htmlData.altTextMissing} images are missing alt attributes. Screen readers cannot describe these images to users.`,
			recommendation: 'Add descriptive alt text to all images. Use alt="" for purely decorative images.',
		});
	} else if (htmlData.images.length > 0) {
		strengths.push('All images have alt attributes — screen reader users can understand image content.');
	}

	// Check meta tags for SEO
	const hasViewport = htmlData.metaTags.some(m => m.name === 'viewport');
	const hasDescription = htmlData.metaTags.some(m => m.name === 'description');
	const hasTitle = htmlData.metaTags.some(m => m.name === 'title' || m.name === 'og:title');

	if (!hasViewport) {
		findings.push({
			category: 'Code Quality',
			severity: 'warning',
			issue: 'No viewport meta tag. The page may not scale correctly on mobile devices.',
			recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0"> to the <head>.',
		});
	}

	if (!hasDescription) {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: 'No meta description tag. Search engines use this to display page summaries.',
			recommendation: 'Add <meta name="description" content="..."> with a 150-160 character page summary.',
		});
	}

	// Check forms for accessibility
	const formsWithoutLabels = htmlData.forms.reduce((count, form) => {
		return count + form.inputs.filter(input => !input.hasLabel).length;
	}, 0);

	if (formsWithoutLabels > 0) {
		findings.push({
			category: 'Accessibility',
			severity: 'critical',
			issue: `${formsWithoutLabels} form input${formsWithoutLabels !== 1 ? 's' : ''} without associated labels. Users cannot tell what these fields are for.`,
			recommendation: 'Associate every input with a <label> using for/id or by wrapping the input in the label.',
		});
	}

	// Check external links without rel
	const externalLinksCount = htmlData.links.filter(l => l.isExternal && l.opensNewTab).length;
	if (externalLinksCount > 0) {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: `${externalLinksCount} external link${externalLinksCount !== 1 ? 's' : ''} open in new tabs. Consider adding rel="noopener" for security.`,
			recommendation: 'Add rel="noopener noreferrer" to links with target="_blank" to prevent security risks.',
		});
	}

	// ARIA usage
	if (htmlData.ariaAttributes.length > 0) {
		strengths.push(`ARIA attributes are being used (${htmlData.ariaAttributes.length} elements) to enhance accessibility.`);
	}

	// Check for blockquotes (testimonials)
	if (htmlData.blockquotes.length > 0) {
		strengths.push(`Blockquotes/testimonials are present (${htmlData.blockquotes.length} found) — effective for social proof.`);

		const quotesWithoutCite = htmlData.blockquotes.filter(q => !q.hasCite).length;
		if (quotesWithoutCite > 0) {
			findings.push({
				category: 'Code Quality',
				severity: 'info',
				issue: `${quotesWithoutCite} blockquote${quotesWithoutCite !== 1 ? 's' : ''} without <cite> elements. Citations add credibility to quotes.`,
				recommendation: 'Add <cite> elements inside blockquotes to attribute the source. Example: <blockquote><p>Quote text</p><cite>Author Name</cite></blockquote>',
			});
		}
	}

	// Check for tables
	if (htmlData.tables.length > 0) {
		strengths.push(`Tables are used for structured data (${htmlData.tables.length} found).`);

		const tablesWithoutHeaders = htmlData.tables.filter(t => !t.hasThead).length;
		if (tablesWithoutHeaders > 0) {
			findings.push({
				category: 'Accessibility',
				severity: 'warning',
				issue: `${tablesWithoutHeaders} table${tablesWithoutHeaders !== 1 ? 's' : ''} without <thead> elements. Screen readers need table headers to understand table structure.`,
				recommendation: 'Wrap header rows in <thead> and use <th> elements for column headers. Example: <thead><tr><th>Column 1</th></tr></thead>',
			});
		}
	}

	// Check for buttons
	if (htmlData.buttons.length > 0) {
		strengths.push(`Interactive buttons detected (${htmlData.buttons.length} buttons) for user actions.`);

		if (htmlData.buttons.length > 20) {
			findings.push({
				category: 'Code Quality',
				severity: 'info',
				issue: `${htmlData.buttons.length} buttons on page. Too many buttons can overwhelm users and dilute primary actions.`,
				recommendation: 'Establish a clear visual hierarchy with primary, secondary, and tertiary button styles. Limit primary action buttons per section.',
			});
		}
	}

	// Check for dropdowns
	if (htmlData.dropdowns.length > 0) {
		strengths.push(`Dropdown/expandable elements present (${htmlData.dropdowns.length} found) for progressive disclosure.`);
	}

	// Check for checkboxes and radio buttons
	if (htmlData.checkboxRadio.length > 0) {
		const checkboxes = htmlData.checkboxRadio.filter(i => i.type === 'checkbox').length;
		const radios = htmlData.checkboxRadio.filter(i => i.type === 'radio').length;

		if (checkboxes > 0 || radios > 0) {
			strengths.push(`Form inputs include ${checkboxes} checkbox${checkboxes !== 1 ? 'es' : ''} and ${radios} radio button${radios !== 1 ? 's' : ''}.`);
		}
	}

	// Check for icons
	if (htmlData.icons.length > 0) {
		strengths.push(`Icons detected (${htmlData.icons.length} visual elements) for improved visual communication.`);

		const svgIcons = htmlData.icons.filter(i => i.type === 'svg').length;
		if (svgIcons > 0) {
			strengths.push(`SVG icons used (${svgIcons} found) — scalable and resolution-independent.`);
		}
	}

	// Check for modals
	if (htmlData.modals.length > 0) {
		strengths.push(`Modal dialogs implemented (${htmlData.modals.length} found) for focused interactions.`);

		const modalsWithoutLabels = htmlData.modals.filter(m => !m.ariaLabel && !m.ariaLabelledby).length;
		if (modalsWithoutLabels > 0) {
			findings.push({
				category: 'Accessibility',
				severity: 'warning',
				issue: `${modalsWithoutLabels} modal${modalsWithoutLabels !== 1 ? 's' : ''} without aria-label or aria-labelledby. Screen reader users need to know what the dialog is for.`,
				recommendation: 'Add aria-label or aria-labelledby to all modal dialogs. Example: <div role="dialog" aria-label="Confirm deletion">',
			});
		}
	}

	// Check for lists
	if (htmlData.lists.length > 0) {
		const unorderedLists = htmlData.lists.filter(l => l.type === 'ul').length;
		const orderedLists = htmlData.lists.filter(l => l.type === 'ol').length;

		strengths.push(`Lists used for structured content (${unorderedLists} unordered, ${orderedLists} ordered).`);
	}

	return {
		htmlData,
		findings,
		strengths,
		summary: `Analyzed HTML with ${htmlData.headings.length} headings, ${htmlData.images.length} images, ${htmlData.links.length} links, and ${htmlData.forms.length} forms.`,
	};
}
