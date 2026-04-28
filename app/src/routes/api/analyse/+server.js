import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SYSTEM_PROMPT, ALGO_AI_PROMPT } from '$lib/ai/prompt.js';
import { BOOK_KNOWLEDGE } from '$lib/ai/bookKnowledge.js';
import { BOOK_IMAGE_MAP, BOOK_IMAGES } from '$lib/ai/bookImages.js';
import puppeteer from 'puppeteer';
import { analyseAlgorithmically } from '$lib/analysis/algorithmic.js';
import { extractAndAnalyzeCSS } from '$lib/analysis/css.js';
import { extractAndAnalyzeHTML } from '$lib/analysis/html.js';
import { extractAndAnalyzeJS } from '$lib/analysis/js.js';

const VP_W = 1440;
const VP_H = 900;

// Singleton browser — shared across all requests, one isolated context per request.
/** @type {import('puppeteer').Browser | null} */
let _browser = null;

async function getBrowser() {
	if (_browser?.connected) return _browser;
	_browser = await puppeteer.launch({
		headless: true,
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
		],
	});
	_browser.on('disconnected', () => { _browser = null; });
	return _browser;
}

async function callGemini(apiKey, screenshotB64, codeContext = null) {
	const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

	// Build the analysis prompt with optional code context
	let analysisPrompt = 'Analyse this UI screenshot for optical balance. Return JSON.';
	if (codeContext) {
		analysisPrompt = `Analyse this UI screenshot for optical balance. Return JSON.

Additional context about the website's code and implementation:

CSS Analysis:
- Stylesheets: ${codeContext.css.stylesheets.length} stylesheet(s)
- Colors: ${codeContext.css.colors.length} unique colors (${codeContext.css.colors.slice(0, 10).join(', ')}${codeContext.css.colors.length > 10 ? '...' : ''})
- Fonts: ${codeContext.css.fonts.length} font families (${codeContext.css.fonts.join(', ')})
- CSS Variables: ${codeContext.css.cssVariables.length} custom properties defined
- Media Queries: ${codeContext.css.mediaQueries.length} responsive breakpoints
- Inline Styles: ${codeContext.css.inlineStyles.length} elements with inline styles

HTML Structure:
- DOCTYPE: ${codeContext.html.doctype || 'missing'}
- Lang attribute: ${codeContext.html.lang || 'missing'}
- Headings: ${codeContext.html.headings.length} total (${codeContext.html.headings.filter(h => h.level === 1).length} h1, ${codeContext.html.headings.filter(h => h.level === 2).length} h2)
- Images: ${codeContext.html.images.length} total (${codeContext.html.altTextMissing} missing alt text)
- Links: ${codeContext.html.links.length} total (${codeContext.html.links.filter(l => l.isExternal).length} external)
- Forms: ${codeContext.html.forms.length} form(s)
- Semantic elements: header=${codeContext.html.semanticElements.header}, nav=${codeContext.html.semanticElements.nav}, main=${codeContext.html.semanticElements.main}, footer=${codeContext.html.semanticElements.footer}
- ARIA attributes: ${codeContext.html.ariaAttributes.length} elements with ARIA

JavaScript Analysis:
- Scripts: ${codeContext.js.scripts.length} total (${codeContext.js.scripts.filter(s => !s.inline).length} external, ${codeContext.js.scripts.filter(s => s.inline).length} inline)
- Frameworks detected: ${Object.entries(codeContext.js.frameworks).filter(([_, detected]) => detected).map(([name]) => name).join(', ') || 'none'}
- Console errors: ${codeContext.js.consoleErrors.length}
- Console warnings: ${codeContext.js.consoleWarnings.length}
- Page errors: ${codeContext.js.pageErrors.length}
- Global variables: ${codeContext.js.globalVariables}
- Storage: localStorage=${codeContext.js.localStorage} items, sessionStorage=${codeContext.js.sessionStorage} items
- Cookies: ${codeContext.js.cookiesCount}
- Service Worker: ${codeContext.js.serviceWorker ? 'yes' : 'no'}

Use this technical context to provide more informed recommendations about the visual design. For example:
- If there are many colors, comment on color consistency
- If semantic HTML is missing, suggest it affects both accessibility and visual hierarchy
- If console errors exist, note they may affect user experience
- If responsive design (media queries) is missing, address mobile layout concerns
- Consider the frameworks used when making technical recommendations`;
	}

	const body = JSON.stringify({
		system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
		contents: [{
			parts: [
				{ inline_data: { mime_type: 'image/png', data: screenshotB64 } },
				{ text: analysisPrompt }
			]
		}],
		generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' }
	});

	const RETRYABLE = new Set([429, 500, 502, 503, 504]);
	let lastErr = /** @type {Error | null} */ (null);

	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) {
			// Exponential backoff: 4s, 12s
			await new Promise(r => setTimeout(r, 4000 * Math.pow(3, attempt - 1)));
		}
		const response = await fetch(geminiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body
		});
		if (response.ok) {
			const data = await response.json();
			const text = data.candidates?.[0]?.content?.parts
				?.map((/** @type {{ text?: string }} */ p) => p.text ?? '').join('') ?? '';
			console.log('[Percepta] raw Gemini text:', text.slice(0, 300));
			const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
			return JSON.parse(cleaned);
		}
		const isRetryable = RETRYABLE.has(response.status);
		const errBody = await response.json().catch(() => ({}));
		const msg = errBody.error?.message ?? `Gemini API error ${response.status}`;
		lastErr = new Error(msg);
		if (!isRetryable) break;
	}
	throw lastErr ?? new Error('Gemini request failed');
}

/**
 * Pre-filter images by checking if basic conditions are met based on finding text.
 * Returns true if the image should be kept (condition likely met or no clear condition).
 * Returns false if the condition is clearly not met.
 */
function checkImageConditionAgainstFinding(imageDesc, findingText, findingCategory) {
	const descLower = imageDesc.toLowerCase();
	const textLower = findingText.toLowerCase();

	// Extract condition from "show this only if X" or "show this image only if X" patterns
	const onlyIfMatch = descLower.match(/show this (?:image )?only if (.+?)(?:\.|$|together|shown)/);
	if (!onlyIfMatch) {
		// No explicit "only if" condition, keep the image
		return true;
	}

	const condition = onlyIfMatch[1].trim();

	// Check for common condition patterns
	const conditionChecks = [
		// Table-related
		{ pattern: /table/i, keywords: ['table', 'column', 'row', 'cell', 'grid'] },
		// Form-related
		{ pattern: /form|label-to-input/i, keywords: ['form', 'input', 'field', 'label'] },
		// Button-related with quantity
		{ pattern: /2 or more buttons/i, keywords: ['buttons', 'multiple buttons', 'three buttons', 'several buttons'] },
		{ pattern: /button.*destructive/i, keywords: ['delete', 'remove', 'destructive', 'danger'] },
		// Heading-related
		{ pattern: /heading.*big/i, keywords: ['heading', 'large heading', 'oversized heading', 'h1', 'h2', 'title'] },
		// Background color
		{ pattern: /background color.*content area/i, keywords: ['background', 'content area', 'colored background'] },
		// Text contrast
		{ pattern: /gray.*text.*colored background/i, keywords: ['gray text', 'grey text', 'colored background', 'tinted background'] },
		// Color palette
		{ pattern: /only.*\d.*colors/i, keywords: ['color', 'palette', 'limited colors', 'few colors'] },
		{ pattern: /accent color/i, keywords: ['accent', 'status', 'semantic', 'info', 'warning', 'error', 'success'] },
		{ pattern: /natural gray/i, keywords: ['gray', 'grey', 'desaturated', 'neutral'] },
		// Icons
		{ pattern: /icon.*40\+px/i, keywords: ['large icon', 'oversized icon', 'icon size'] },
		{ pattern: /icon.*next to text/i, keywords: ['icon', 'text', 'label'] },
		// Images
		{ pattern: /user-uploaded image/i, keywords: ['image', 'photo', 'upload', 'gallery'] },
		{ pattern: /\d\+ avatars/i, keywords: ['avatar', 'profile picture', 'user image'] },
		{ pattern: /text.*photo|text.*image/i, keywords: ['text on photo', 'text on image', 'overlay'] },
		// Typography
		{ pattern: /text.*relative unit.*em/i, keywords: ['em unit', 'relative unit', 'responsive text'] },
		{ pattern: /paragraph.*\d\+ lines/i, keywords: ['paragraph', 'long text', 'body text'] },
		{ pattern: /line.*90-110 char/i, keywords: ['line length', 'character count', 'wide text'] },
		// Layout
		{ pattern: /element.*lot of text.*spacing.*small/i, keywords: ['tight spacing', 'cramped', 'padding'] },
		{ pattern: /input.*spread out/i, keywords: ['form', 'input', 'stretched', 'wide'] },
		{ pattern: /article.*section.*heading/i, keywords: ['article', 'section', 'heading'] },
		{ pattern: /bulleted list/i, keywords: ['list', 'bullet', 'ul', 'li'] },
		{ pattern: /cards.*container.*listed item/i, keywords: ['card', 'list', 'item'] },
		// Modal/dropdown
		{ pattern: /modal.*dialog/i, keywords: ['modal', 'dialog', 'popup', 'overlay'] },
		{ pattern: /dropdown/i, keywords: ['dropdown', 'select', 'menu'] },
		// Graphs
		{ pattern: /graph/i, keywords: ['graph', 'chart', 'visualization', 'trend'] },
		// Links
		{ pattern: /link.*no styling/i, keywords: ['link', 'anchor', 'href'] },
		// Custom styling
		{ pattern: /checkbox.*radio button.*no styling/i, keywords: ['checkbox', 'radio', 'input'] },
		{ pattern: /basic bullet point/i, keywords: ['bullet', 'list', 'ul'] },
		{ pattern: /testimonial/i, keywords: ['testimonial', 'quote', 'review'] },
		// Background
		{ pattern: /\d\+.*element.*white background/i, keywords: ['background', 'panel', 'card', 'section'] },
		{ pattern: /\d\+.*same background.*section/i, keywords: ['section', 'background', 'panel'] },
		// Split layout (horizontal balance)
		{ pattern: /split layout|left-right|one side.*heavier/i, keywords: ['split', 'two column', 'left-right', 'horizontal', 'balance'] },
	];

	// Check if we can verify the condition
	for (const check of conditionChecks) {
		if (check.pattern.test(condition)) {
			// This condition matches one of our known patterns
			// Check if the finding text contains relevant keywords
			const hasKeyword = check.keywords.some(kw => textLower.includes(kw.toLowerCase()));
			if (!hasKeyword) {
				// Condition pattern matched but finding doesn't mention relevant keywords
				return false;
			}
			// Keywords found, condition might be met
			return true;
		}
	}

	// Condition pattern not recognized or too complex to check algorithmically
	// Let Gemini decide, but be conservative
	return true;
}

async function callGeminiWithFindings(apiKey, findings, overallScore, codeContext = null) {
	const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

	const categoriesPresent = [...new Set(findings.map(f => f.category))];
	const bookKnowledgeContext = Object.fromEntries(
		categoriesPresent
			.filter(cat => BOOK_KNOWLEDGE[cat])
			.map(cat => [cat, BOOK_KNOWLEDGE[cat].excerpt])
	);

	// Build code context summary if provided
	let codeContextSummary = '';
	if (codeContext) {
		codeContextSummary = `

CODE CONTEXT — Use this technical information about the website's implementation to enrich your analysis:

CSS (${codeContext.css.stylesheets.length} stylesheets):
- ${codeContext.css.colors.length} unique colors: ${codeContext.css.colors.slice(0, 8).join(', ')}${codeContext.css.colors.length > 8 ? '...' : ''}
- ${codeContext.css.fonts.length} font families: ${codeContext.css.fonts.join(', ')}
- ${codeContext.css.cssVariables.length} CSS custom properties
- ${codeContext.css.mediaQueries.length} responsive media queries
- ${codeContext.css.inlineStyles.length} elements with inline styles

HTML Structure:
- Semantic elements: <header>×${codeContext.html.semanticElements.header}, <nav>×${codeContext.html.semanticElements.nav}, <main>×${codeContext.html.semanticElements.main}, <footer>×${codeContext.html.semanticElements.footer}
- ${codeContext.html.headings.length} headings (h1: ${codeContext.html.headings.filter(h => h.level === 1).length})
- ${codeContext.html.images.length} images (${codeContext.html.altTextMissing} missing alt text)
- ${codeContext.html.forms.length} forms, ${codeContext.html.links.length} links
- ARIA: ${codeContext.html.ariaAttributes.length} elements with accessibility attributes

JavaScript (${codeContext.js.scripts.length} scripts):
- Frameworks: ${Object.entries(codeContext.js.frameworks).filter(([_, d]) => d).map(([n]) => n).join(', ') || 'none'}
- Console errors: ${codeContext.js.consoleErrors.length}, warnings: ${codeContext.js.consoleWarnings.length}
- ${codeContext.js.globalVariables} global variables
- Storage: ${codeContext.js.localStorage} localStorage, ${codeContext.js.sessionStorage} sessionStorage, ${codeContext.js.cookiesCount} cookies

When rewriting findings, incorporate this code-level context to make recommendations more specific and actionable. For example:
- Link color palette issues to the actual number of colors used
- Reference the specific frameworks when suggesting improvements
- Mention actual accessibility gaps (missing alt text, ARIA usage)
- Note console errors that may affect user experience`;
	}

	const systemInstruction = `${ALGO_AI_PROMPT}
${codeContextSummary}

---
IMAGE SELECTION — CRITICAL INSTRUCTIONS

Each finding has an "availableImages" array. Each image entry contains:
  src      — exact filename to use in bookImages
  desc     — MANDATORY CONDITION + description. This is NOT just a description — it contains a CONDITION that MUST be satisfied.
  pair     — (optional) companion image for ❌/✅ before/after sets

⚠️ MANDATORY CONDITIONAL LOGIC — READ EVERY WORD:

The desc field contains CONDITIONS written as "show this only if X" or "show this image only if X". These are HARD REQUIREMENTS, not suggestions.

YOU MUST FOLLOW THIS DECISION PROCESS FOR EVERY IMAGE:

1. READ the finding description carefully
2. READ the image's desc field — look for "only if", "ONLY if", "show this only", "show this image only"
3. EXTRACT the condition: what specific element/state/property must be present?
4. EVALUATE: Does this finding's description explicitly mention or demonstrate that condition?
   - If YES → condition is satisfied, you MAY select this image
   - If NO → condition is NOT satisfied, you MUST NOT select this image, even if the topic seems related
5. If unsure whether condition is met → DO NOT select the image (err on the side of NOT selecting)

CONCRETE EXAMPLES:

❌ WRONG:
  Finding: "Buttons lack visual hierarchy"
  Image desc: "show this only if there are 2 or more buttons next to each with same weight inside of a container/label"
  → Finding mentions buttons but does NOT say "2 or more buttons next to each other with same weight"
  → CONDITION NOT MET → DO NOT SELECT

✅ CORRECT:
  Finding: "Three equal-weight filled buttons offer no signal about which action is primary"
  Image desc: "show this only if there are 2 or more buttons next to each with same weight inside of a container/label"
  → Finding explicitly states "three equal-weight filled buttons" = 2+ buttons with same weight
  → CONDITION MET → MAY SELECT

❌ WRONG:
  Finding: "Text contrast is insufficient"
  Image desc: "show this image only if there is background color in content area"
  → Finding is about contrast, not about background color in content area
  → CONDITION NOT MET → DO NOT SELECT

✅ CORRECT:
  Finding: "Main content area has a colored background that competes with sidebar"
  Image desc: "show this image only if there is background color in content area"
  → Finding explicitly mentions "colored background" in "content area"
  → CONDITION MET → MAY SELECT

ADDITIONAL RULES:
- "shown only with imageXX" → NEVER select independently, only as pair partner
- If desc has NO explicit "only if" condition → select when it closely matches the finding
- PAIRING: if you select an image with a "pair" field → you MUST include the pair partner
- When in doubt → return [] rather than selecting an image with unmet conditions

STRICTNESS: It is BETTER to return [] (no images) than to return images with unmet conditions. The user has explicitly requested that conditions be respected.

For each selected image, return an object with:
  src     — the exact filename
  caption — a 1-2 sentence direct statement about what this image demonstrates in context of this finding. Start with the action or observation directly (e.g. "A small high-contrast button can counterbalance a much larger photo in a split layout."). Do NOT start with "This image shows", "This shows", or any meta-phrase. Do NOT copy the desc verbatim.`;

	const findingsWithImages = findings.map(f => {
		const available = BOOK_IMAGES
			.filter(img => img.tags.includes(f.category))
			// Pre-filter by checking basic conditions against finding text
			.filter(img => checkImageConditionAgainstFinding(img.desc, f.issue, f.category))
			.map(({ src, desc, pair }) => {
				/** @type {{ src: string, desc: string, pair?: string }} */
				const entry = { src, desc };
				if (pair) entry.pair = pair;
				return entry;
			});

		// Debug logging
		if (available.length > 0) {
			console.log(`[Percepta] Finding ${f.id} (${f.category}): ${available.length} available images after pre-filter`);
		}

		return { ...f, availableImages: available };
	});

	const body = JSON.stringify({
		system_instruction: { parts: [{ text: systemInstruction }] },
		contents: [{
			parts: [{ text: JSON.stringify({ overallScore, findings: findingsWithImages, bookKnowledge: bookKnowledgeContext }) }]
		}],
		generationConfig: { maxOutputTokens: 32768, responseMimeType: 'application/json' }
	});

	const RETRYABLE = new Set([429, 500, 502, 503, 504]);
	let lastErr = /** @type {Error | null} */ (null);

	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) {
			await new Promise(r => setTimeout(r, 4000 * Math.pow(3, attempt - 1)));
		}
		const response = await fetch(geminiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body
		});
		if (response.ok) {
			const data = await response.json();
			const text = data.candidates?.[0]?.content?.parts
				?.map((/** @type {{ text?: string }} */ p) => p.text ?? '').join('') ?? '';
			console.log('[Percepta] raw Gemini findings text:', text.slice(0, 300));
			const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
			const result = JSON.parse(cleaned);
			if (Array.isArray(result.findings)) {
				// First pass: resolve & validate images per finding
				result.findings = result.findings.map(f => {
					const rawImages = Array.isArray(f.bookImages) ? f.bookImages : [];
					console.log(`[Percepta] Gemini selected ${rawImages.length} images for finding ${f.id}`);
					const captionMap = new Map();
					for (const item of rawImages) {
						if (item && typeof item === 'object' && typeof item.src === 'string' && BOOK_IMAGE_MAP[item.src]) {
							captionMap.set(item.src, item.caption || BOOK_IMAGE_MAP[item.src].desc);
						} else if (typeof item === 'string' && BOOK_IMAGE_MAP[item]) {
							captionMap.set(item, BOOK_IMAGE_MAP[item].desc);
						}
					}
					// Auto-add missing pair partners
					for (const src of [...captionMap.keys()]) {
						const partner = BOOK_IMAGE_MAP[src].pair;
						if (partner && BOOK_IMAGE_MAP[partner] && !captionMap.has(partner)) {
							captionMap.set(partner, BOOK_IMAGE_MAP[partner].desc);
						}
					}
					const bookImages = [...captionMap.entries()].map(([src, caption]) => ({ src, caption }));
					return { ...f, bookImages };
				});

				// Second pass: deduplicate — each image may only appear in one finding
				const usedImages = new Set();
				result.findings = result.findings.map(f => {
					const deduped = (f.bookImages ?? []).filter(img => {
						if (usedImages.has(img.src)) return false;
						usedImages.add(img.src);
						return true;
					});
					if (deduped.length !== (f.bookImages ?? []).length) {
						console.log(`[Percepta] Finding ${f.id}: deduplicated ${(f.bookImages ?? []).length} -> ${deduped.length} images`);
					}
					return { ...f, bookImages: deduped };
				});

				// Log final image count summary
				const finalCounts = result.findings.map(f => `${f.id}: ${(f.bookImages ?? []).length}`).join(', ');
				console.log(`[Percepta] Final bookImages per finding: ${finalCounts}`);
			}
			return result;
		}
		const isRetryable = RETRYABLE.has(response.status);
		const errBody = await response.json().catch(() => ({}));
		const msg = errBody.error?.message ?? `Gemini API error ${response.status}`;
		lastErr = new Error(msg);
		if (!isRetryable) break;
	}
	throw lastErr ?? new Error('Gemini request failed');
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
	const apiKey = env.GEMINI_API_KEY;
	if (!apiKey) {
		throw error(500, 'GEMINI_API_KEY is not configured. Create a .env file with your key.');
	}

	let body;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	let { url: pageUrl, mode } = body;
	if (!pageUrl || typeof pageUrl !== 'string') {
		throw error(400, 'Missing or invalid url field');
	}
	if (!mode || (mode !== 'algo' && mode !== 'ai' && mode !== 'algo-ai' && mode !== 'compare' && mode !== 'compare-algo-ai')) {
		throw error(400, 'mode must be "algo", "ai", "algo-ai", "compare", or "compare-algo-ai"');
	}

	if (!/^https?:\/\//i.test(pageUrl)) {
		pageUrl = 'https://' + pageUrl;
	}

	const browser = await getBrowser();
	const context = await browser.createBrowserContext();
	try {
		const page = await context.newPage();
		await page.setViewport({ width: VP_W, height: VP_H, deviceScaleFactor: 1 });

		try {
			await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 25000 });
		} catch {
			await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
		}

		// ── Dismiss cookie/GDPR popups ────────────────────────────────────────
		// 1. Click common "accept" buttons by visible text
		await page.evaluate(async () => {
			const ACCEPT_TEXTS = [
				'accept all', 'accept cookies', 'agree', 'i agree', 'allow all',
				'allow cookies', 'got it', 'ok', 'okay', 'continue', 'close',
				'zustimmen', 'alle akzeptieren', 'akzeptieren',  // German
				'tout accepter', 'accepter', 'fermer',            // French
				'acceptar', 'aceptar todas',                      // Spanish
			];
			const buttons = Array.from(document.querySelectorAll(
				'button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]'
			));
			for (const btn of buttons) {
				const text = (btn.textContent ?? '').trim().toLowerCase();
				if (ACCEPT_TEXTS.some(t => text.includes(t))) {
					/** @type {HTMLElement} */ (btn).click();
					await new Promise(r => setTimeout(r, 150));
					break;
				}
			}
		});

		// 2. Remove remaining popups — specific known frameworks + safe heuristics only
		await page.evaluate(() => {
			const KNOWN_SELECTORS = [
				// OneTrust
				'#onetrust-consent-sdk', '#onetrust-banner-sdk', '#onetrust-pc-sdk',
				// Cookiebot
				'#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
				// Cookie Consent (insites)
				'.cc-window', '#cc-main', '.cc-banner', '.cc-dialog',
				// Cookie Notice / Cookie Law Info (WordPress plugins)
				'#cookie-notice', '.cookie-notice',
				'#cookie-law-info-bar', '.cli-bar-container',
				// cookieyes / termly / usercentrics
				'#cookieyes-banner', '.cky-consent-container',
				'#termly-code-snippet-support', '.t-gdpr-banner',
				'[id^="uc-banner"]', '[id^="usercentrics-"]',
				// Borlabs Cookie (WordPress)
				'#BorlabsCookieBox', '.borlabs-cookie-box',
				// Generic but precise compound selectors (id/class must contain both words)
				'[id="cookie-popup"]', '[id="cookie-banner"]', '[id="cookie-bar"]',
				'[id="gdpr-banner"]', '[id="gdpr-overlay"]', '[id="gdpr-popup"]',
				'[id="consent-banner"]', '[id="consent-popup"]',
				'[id="privacy-banner"]', '[id="privacy-popup"]',
			];
			for (const sel of KNOWN_SELECTORS) {
				document.querySelectorAll(sel).forEach(el => {
					/** @type {HTMLElement} */ (el).style.display = 'none';
				});
			}

			// Heuristic: full-page backdrops and bottom cookie bars
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			document.querySelectorAll('*').forEach(el => {
				const style = window.getComputedStyle(el);
				if (style.position !== 'fixed' && style.position !== 'absolute') return;
				if ((parseInt(style.zIndex) || 0) < 100) return;
				const r = el.getBoundingClientRect();
				const isFullBackdrop = r.width >= vw * 0.85 && r.height >= vh * 0.85;
				const isBottomCookieBar = r.width >= vw * 0.85 && r.height <= 280
					&& r.bottom >= vh * 0.75 && style.position === 'fixed';
				if (isFullBackdrop || isBottomCookieBar) {
					/** @type {HTMLElement} */ (el).style.display = 'none';
				}
			});

			// Re-enable body scroll that popups often lock
			document.body.style.overflow = '';
			document.documentElement.style.overflow = '';
		});

		// Small pause so any close animations complete before screenshot
		await new Promise(r => setTimeout(r, 300));

		const screenshotBuf = await page.screenshot({
			type: 'png',
			clip: { x: 0, y: 0, width: VP_W, height: VP_H }
		});
		const screenshotB64 = Buffer.from(screenshotBuf).toString('base64');
		const screenshotDataUrl = `data:image/png;base64,${screenshotB64}`;

		// ── Extract and analyze CSS, HTML, and JavaScript ──────────────────────
		const cssAnalysis = await extractAndAnalyzeCSS(page);
		const htmlAnalysis = await extractAndAnalyzeHTML(page);
		const jsAnalysis = await extractAndAnalyzeJS(page);

		if (mode === 'algo') {
			const { elements, vpW, vpH } = await page.evaluate(() => {
				/**
				 * @param {string} str
				 * @returns {number[]}
				 */
				function parseColor(str) {
					if (!str || str === 'transparent') return [255, 255, 255, 0];
					const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
					if (!m) return [128, 128, 128, 1];
					return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
				}

				/**
				 * @param {Element} el
				 * @returns {number[]}
				 */
				function getEffectiveBg(el) {
					let cur = el;
					while (cur && cur !== document.documentElement) {
						const bg = window.getComputedStyle(cur).backgroundColor;
						const parsed = parseColor(bg);
						if (parsed[3] > 0.05) return parsed;
						cur = /** @type {Element} */ (cur.parentElement);
					}
					return [255, 255, 255, 1];
				}

				const all = Array.from(document.querySelectorAll('*'));
				const vW = window.innerWidth;
				const vH = window.innerHeight;
				const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
				const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
				/** @type {any[]} */
				const results = [];
				for (const el of all) {
					const r = el.getBoundingClientRect();
					if (r.width < 2 || r.height < 2) continue;
					if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
					const cs = window.getComputedStyle(el);
					const tag = el.tagName.toLowerCase();
					results.push({
						tag,
						rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
						color: parseColor(cs.color),
						bg: getEffectiveBg(el),
						fontSize: parseFloat(cs.fontSize) || 14,
						fontWeight: parseInt(cs.fontWeight) || 400,
						lineHeight: parseFloat(cs.lineHeight) || 0,
						fontFamily: (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
						textAlign: cs.textAlign || 'left',
						textDecoration: (cs.textDecorationLine && cs.textDecorationLine !== 'none')
							? cs.textDecorationLine
							: ((cs.textDecoration || '').includes('underline') ? 'underline' : 'none'),
						letterSpacing: parseFloat(cs.letterSpacing) || 0,
						paddingTop: parseFloat(cs.paddingTop) || 0,
						paddingBottom: parseFloat(cs.paddingBottom) || 0,
						paddingLeft: parseFloat(cs.paddingLeft) || 0,
						paddingRight: parseFloat(cs.paddingRight) || 0,
						hasShadow: !!cs.boxShadow && cs.boxShadow !== 'none',
						boxShadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
						zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex) || 0),
						borderWidth: Math.max(
							parseFloat(cs.borderTopWidth) || 0,
							parseFloat(cs.borderRightWidth) || 0,
							parseFloat(cs.borderBottomWidth) || 0,
							parseFloat(cs.borderLeftWidth) || 0
						),
						textTransform: cs.textTransform || 'none',
						hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none',
						opacity: parseFloat(cs.opacity) || 1,
						isText: TEXT_TAGS.has(tag),
						isInteractive: INTERACTIVE_TAGS.has(tag),
						textContent: (TEXT_TAGS.has(tag) || INTERACTIVE_TAGS.has(tag))
							? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
							: '',
						alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
					});
				}
				return { elements: results, vpW: vW, vpH: vH };
			});

			const analysis = analyseAlgorithmically(elements, vpW, vpH);

			// Merge all analysis findings and strengths
			const allFindings = [
				...analysis.findings,
				...cssAnalysis.findings,
				...htmlAnalysis.findings,
				...jsAnalysis.findings,
			];
			const allStrengths = [
				...analysis.strengths,
				...cssAnalysis.strengths,
				...htmlAnalysis.strengths,
				...jsAnalysis.strengths,
			];

			return json({
				screenshot: screenshotDataUrl,
				...analysis,
				findings: allFindings,
				strengths: allStrengths,
			});
		} else if (mode === 'algo-ai') {
			// algo-ai: run rule-based analysis, then ask AI to rewrite findings in plain language
			const { elements, vpW, vpH } = await page.evaluate(() => {
				/**
				 * @param {string} str
				 * @returns {number[]}
				 */
				function parseColor(str) {
					if (!str || str === 'transparent') return [255, 255, 255, 0];
					const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
					if (!m) return [128, 128, 128, 1];
					return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
				}

				/**
				 * @param {Element} el
				 * @returns {number[]}
				 */
				function getEffectiveBg(el) {
					let cur = el;
					while (cur && cur !== document.documentElement) {
						const bg = window.getComputedStyle(cur).backgroundColor;
						const parsed = parseColor(bg);
						if (parsed[3] > 0.05) return parsed;
						cur = /** @type {Element} */ (cur.parentElement);
					}
					return [255, 255, 255, 1];
				}

				const all = Array.from(document.querySelectorAll('*'));
				const vW = window.innerWidth;
				const vH = window.innerHeight;
				const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
				const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
				/** @type {any[]} */
				const results = [];
				for (const el of all) {
					const r = el.getBoundingClientRect();
					if (r.width < 2 || r.height < 2) continue;
					if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
					const cs = window.getComputedStyle(el);
					const tag = el.tagName.toLowerCase();
					results.push({
						tag,
						rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
						color: parseColor(cs.color),
						bg: getEffectiveBg(el),
						fontSize: parseFloat(cs.fontSize) || 14,
						fontWeight: parseInt(cs.fontWeight) || 400,
						lineHeight: parseFloat(cs.lineHeight) || 0,
						fontFamily: (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
						textAlign: cs.textAlign || 'left',
						textDecoration: (cs.textDecorationLine && cs.textDecorationLine !== 'none')
							? cs.textDecorationLine
							: ((cs.textDecoration || '').includes('underline') ? 'underline' : 'none'),
						letterSpacing: parseFloat(cs.letterSpacing) || 0,
						paddingTop: parseFloat(cs.paddingTop) || 0,
						paddingBottom: parseFloat(cs.paddingBottom) || 0,
						paddingLeft: parseFloat(cs.paddingLeft) || 0,
						paddingRight: parseFloat(cs.paddingRight) || 0,
						hasShadow: !!cs.boxShadow && cs.boxShadow !== 'none',
						boxShadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
						zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex) || 0),
						borderWidth: Math.max(
							parseFloat(cs.borderTopWidth) || 0,
							parseFloat(cs.borderRightWidth) || 0,
							parseFloat(cs.borderBottomWidth) || 0,
							parseFloat(cs.borderLeftWidth) || 0
						),
						textTransform: cs.textTransform || 'none',
						hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none',
						opacity: parseFloat(cs.opacity) || 1,
						isText: TEXT_TAGS.has(tag),
						isInteractive: INTERACTIVE_TAGS.has(tag),
						textContent: (TEXT_TAGS.has(tag) || INTERACTIVE_TAGS.has(tag))
							? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
							: '',
						alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
					});
				}
				return { elements: results, vpW: vW, vpH: vH };
			});

			const algoAnalysis = analyseAlgorithmically(elements, vpW, vpH);
			let aiRewrite = null;
			try {
				// Merge algorithmic findings with CSS/HTML/JS findings before AI rewrite
				const mergedFindings = [
					...algoAnalysis.findings,
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				];
				const codeContext = {
					css: cssAnalysis.cssData,
					html: htmlAnalysis.htmlData,
					js: jsAnalysis.jsData,
				};
				aiRewrite = await callGeminiWithFindings(apiKey, mergedFindings, algoAnalysis.overallScore, codeContext);
			} catch (aiErr) {
				console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
			}

			const allStrengths = [
				...(aiRewrite?.strengths ?? algoAnalysis.strengths),
				...cssAnalysis.strengths,
				...htmlAnalysis.strengths,
				...jsAnalysis.strengths,
			];

			return json({
				screenshot: screenshotDataUrl,
				overallScore: algoAnalysis.overallScore,
				summary: aiRewrite?.summary ?? algoAnalysis.summary,
				findings: aiRewrite?.findings ?? [
					...algoAnalysis.findings,
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				],
				strengths: allStrengths,
				expertNote: algoAnalysis.expertNote,
			});
		} else if (mode === 'compare-algo-ai') {
			// compare-algo-ai: run algo, then ask AI to rewrite — return both for prose diff view
			const { elements, vpW, vpH } = await page.evaluate(() => {
				/** @param {string} str @returns {number[]} */
				function parseColor(str) {
					if (!str || str === 'transparent') return [255, 255, 255, 0];
					const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
					if (!m) return [128, 128, 128, 1];
					return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
				}
				/** @param {Element} el @returns {number[]} */
				function getEffectiveBg(el) {
					let cur = el;
					while (cur && cur !== document.documentElement) {
						const bg = window.getComputedStyle(cur).backgroundColor;
						const parsed = parseColor(bg);
						if (parsed[3] > 0.05) return parsed;
						cur = /** @type {Element} */ (cur.parentElement);
					}
					return [255, 255, 255, 1];
				}
				const all = Array.from(document.querySelectorAll('*'));
				const vW = window.innerWidth;
				const vH = window.innerHeight;
				const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
				const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
				/** @type {any[]} */
				const results = [];
				for (const el of all) {
					const r = el.getBoundingClientRect();
					if (r.width < 2 || r.height < 2) continue;
					if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
					const cs = window.getComputedStyle(el);
					const tag = el.tagName.toLowerCase();
					results.push({
						tag,
						rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
						color: parseColor(cs.color),
						bg: getEffectiveBg(el),
						fontSize: parseFloat(cs.fontSize) || 14,
						fontWeight: parseInt(cs.fontWeight) || 400,
						lineHeight: parseFloat(cs.lineHeight) || 0,
						fontFamily: (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
						textAlign: cs.textAlign || 'left',
						textDecoration: (cs.textDecorationLine && cs.textDecorationLine !== 'none')
							? cs.textDecorationLine
							: ((cs.textDecoration || '').includes('underline') ? 'underline' : 'none'),
						letterSpacing: parseFloat(cs.letterSpacing) || 0,
						paddingTop: parseFloat(cs.paddingTop) || 0,
						paddingBottom: parseFloat(cs.paddingBottom) || 0,
						paddingLeft: parseFloat(cs.paddingLeft) || 0,
						paddingRight: parseFloat(cs.paddingRight) || 0,
						hasShadow: !!cs.boxShadow && cs.boxShadow !== 'none',
						boxShadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
						zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex) || 0),
						borderWidth: Math.max(
							parseFloat(cs.borderTopWidth) || 0,
							parseFloat(cs.borderRightWidth) || 0,
							parseFloat(cs.borderBottomWidth) || 0,
							parseFloat(cs.borderLeftWidth) || 0
						),
						textTransform: cs.textTransform || 'none',
						hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none',
						opacity: parseFloat(cs.opacity) || 1,
						isText: TEXT_TAGS.has(tag),
						isInteractive: INTERACTIVE_TAGS.has(tag),
						textContent: (TEXT_TAGS.has(tag) || INTERACTIVE_TAGS.has(tag))
							? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
							: '',
						alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
					});
				}
				return { elements: results, vpW: vW, vpH: vH };
			});

			const algoResult = analyseAlgorithmically(elements, vpW, vpH);
			let aiRewrite = null;
			try {
				// Merge algorithmic findings with CSS/HTML/JS findings before AI rewrite
				const mergedFindings = [
					...algoResult.findings,
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				];
				const codeContext = {
					css: cssAnalysis.cssData,
					html: htmlAnalysis.htmlData,
					js: jsAnalysis.jsData,
				};
				aiRewrite = await callGeminiWithFindings(apiKey, mergedFindings, algoResult.overallScore, codeContext);
			} catch (aiErr) {
				console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
			}

			// Merge algo findings with CSS/HTML/JS findings for the "algo" side
			const algoWithExtensions = {
				...algoResult,
				findings: [
					...algoResult.findings,
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				],
				strengths: [
					...algoResult.strengths,
					...cssAnalysis.strengths,
					...htmlAnalysis.strengths,
					...jsAnalysis.strengths,
				],
			};

			return json({
				mode: 'compare-algo-ai',
				screenshot: screenshotDataUrl,
				overallScore: algoResult.overallScore,
				algo: algoWithExtensions,
				algoAi: {
					summary: aiRewrite?.summary ?? algoResult.summary,
					findings: aiRewrite?.findings ?? algoWithExtensions.findings,
					strengths: aiRewrite?.strengths ?? algoWithExtensions.strengths,
				},
			});
		} else if (mode === 'ai') {
			// AI mode - pass code context for better analysis
			const codeContext = {
				css: cssAnalysis.cssData,
				html: htmlAnalysis.htmlData,
				js: jsAnalysis.jsData,
			};
			const result = await callGemini(apiKey, screenshotB64, codeContext);
			return json({
				screenshot: screenshotDataUrl,
				...result,
				// Add CSS/HTML/JS findings to AI results
				findings: [
					...(result.findings || []),
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				],
				strengths: [
					...(result.strengths || []),
					...cssAnalysis.strengths,
					...htmlAnalysis.strengths,
					...jsAnalysis.strengths,
				],
			});
		} else {
			// compare mode — run both algo and AI, return side-by-side with CSS/HTML/JS analysis
			const { elements, vpW, vpH } = await page.evaluate(() => {
				/**
				 * @param {string} str
				 * @returns {number[]}
				 */
				function parseColor(str) {
					if (!str || str === 'transparent') return [255, 255, 255, 0];
					const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
					if (!m) return [128, 128, 128, 1];
					return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
				}

				/**
				 * @param {Element} el
				 * @returns {number[]}
				 */
				function getEffectiveBg(el) {
					let cur = el;
					while (cur && cur !== document.documentElement) {
						const bg = window.getComputedStyle(cur).backgroundColor;
						const parsed = parseColor(bg);
						if (parsed[3] > 0.05) return parsed;
						cur = /** @type {Element} */ (cur.parentElement);
					}
					return [255, 255, 255, 1];
				}

				const all = Array.from(document.querySelectorAll('*'));
				const vW = window.innerWidth;
				const vH = window.innerHeight;
				const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
				const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
				/** @type {any[]} */
				const results = [];
				for (const el of all) {
					const r = el.getBoundingClientRect();
					if (r.width < 2 || r.height < 2) continue;
					if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
					const cs = window.getComputedStyle(el);
					const tag = el.tagName.toLowerCase();
					results.push({
						tag,
						rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
						color: parseColor(cs.color),
						bg: getEffectiveBg(el),
						fontSize: parseFloat(cs.fontSize) || 14,
						fontWeight: parseInt(cs.fontWeight) || 400,
						lineHeight: parseFloat(cs.lineHeight) || 0,
						fontFamily: (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
						textAlign: cs.textAlign || 'left',
						textDecoration: (cs.textDecorationLine && cs.textDecorationLine !== 'none')
							? cs.textDecorationLine
							: ((cs.textDecoration || '').includes('underline') ? 'underline' : 'none'),
						letterSpacing: parseFloat(cs.letterSpacing) || 0,
						paddingTop: parseFloat(cs.paddingTop) || 0,
						paddingBottom: parseFloat(cs.paddingBottom) || 0,
						paddingLeft: parseFloat(cs.paddingLeft) || 0,
						paddingRight: parseFloat(cs.paddingRight) || 0,
						hasShadow: !!cs.boxShadow && cs.boxShadow !== 'none',
						boxShadow: (cs.boxShadow && cs.boxShadow !== 'none') ? cs.boxShadow : '',
						zIndex: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex) || 0),
						borderWidth: Math.max(
							parseFloat(cs.borderTopWidth) || 0,
							parseFloat(cs.borderRightWidth) || 0,
							parseFloat(cs.borderBottomWidth) || 0,
							parseFloat(cs.borderLeftWidth) || 0
						),
						textTransform: cs.textTransform || 'none',
						hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none',
						opacity: parseFloat(cs.opacity) || 1,
						isText: TEXT_TAGS.has(tag),
						isInteractive: INTERACTIVE_TAGS.has(tag),
						textContent: (TEXT_TAGS.has(tag) || INTERACTIVE_TAGS.has(tag))
							? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
							: '',
						alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
					});
				}
				return { elements: results, vpW: vW, vpH: vH };
			});

			const algoResult = analyseAlgorithmically(elements, vpW, vpH);
			const codeContext = {
				css: cssAnalysis.cssData,
				html: htmlAnalysis.htmlData,
				js: jsAnalysis.jsData,
			};
			const aiResult = await callGemini(apiKey, screenshotB64, codeContext);

			// Merge algo findings with CSS/HTML/JS findings
			const algoWithExtensions = {
				...algoResult,
				findings: [
					...algoResult.findings,
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				],
				strengths: [
					...algoResult.strengths,
					...cssAnalysis.strengths,
					...htmlAnalysis.strengths,
					...jsAnalysis.strengths,
				],
			};

			// Merge AI findings with CSS/HTML/JS findings
			const aiWithExtensions = {
				...aiResult,
				findings: [
					...(aiResult.findings || []),
					...cssAnalysis.findings,
					...htmlAnalysis.findings,
					...jsAnalysis.findings,
				],
				strengths: [
					...(aiResult.strengths || []),
					...cssAnalysis.strengths,
					...htmlAnalysis.strengths,
					...jsAnalysis.strengths,
				],
			};

			return json({
				mode: 'compare',
				screenshot: screenshotDataUrl,
				algo: algoWithExtensions,
				ai: aiWithExtensions,
			});
		}
	} finally {
		await context.close();
	}
}
