import { error } from '@sveltejs/kit';
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
const MAX_FINDINGS_PER_CATEGORY = 3;

/**
 * Strict allowlist of image examples to reduce false positives.
 * Only checks that map to these desc-driven images remain active.
 *
 * @type {Record<string, Set<string>>}
 */
const ALLOWED_IMAGE_SRCS_BY_CATEGORY = {
	'Readability': new Set([
		'image183.jpg',
		'image185.jpg',
		'image122.jpg',
		'image124.jpg',
		'image225.png',
	]),
	'Visual Weight': new Set([
		'image54.png',
		'image55.png',
		'image277.jpg',
		'image281.jpg',
		'image282.jpg',
	]),
	'Visual Hierarchy': new Set([
		'image51.png',
		'image52.png',
		'image53.png',
		'image58.png',
		'image59.png',
		'image127.png',
		'image128.png',
		'image129.png',
		'image251.jpeg',
	]),
	'Typography': new Set([
		'image14.jpg',
		'image23.jpeg',
		'image102.png',
		'image112.jpg',
		'image141.jpg',
		'image132.jpg',
		'image133.jpg',
	]),
	'Colour Palette': new Set([
		'image37.png',
		'image41.png',
		'image151.jpeg',
		'image153.png',
		'image183.jpg',
		'image180.png',
		'image181.png',
	]),
	'Spacing & Layout': new Set([
		'image63.jpeg',
		'image65.jpeg',
		'image72.png',
		'image102.png',
		'image105.png',
	]),
	'Interactive Targets': new Set([
		'image58.png',
		'image59.png',
		'image94.png',
		'image95.png',
		'image205.png',
		'image251.jpeg',
	]),
	'Icon & Image Size': new Set([
		'image225.png',
		'image227.png',
		'image230.png',
		'image233.jpg',
		'image242.png',
	]),
};

/**
 * @param {string} category
 * @param {string} src
 */
function isAllowedImageForCategory(category, src) {
	const allowed = ALLOWED_IMAGE_SRCS_BY_CATEGORY[category];
	if (!allowed) return false;
	return allowed.has(src);
}

/**
 * Strip internal AI-instruction sentences from a bookImage desc so it reads
 * as a plain user-facing caption.  Sentences that start with imperative
 * directives ("show this only if �", "used to show how �", "together with �",
 * etc.) are removed; the remaining descriptive sentences are joined and
 * returned.  If nothing survives the filter the original string is returned
 * unchanged so the fallback is never empty.
 */
function cleanCaption(desc) {
	if (!desc) return '';
	// Split on sentence boundaries (period/exclamation/question + whitespace).
	// We keep the delimiter attached to the preceding sentence.
	const sentences = desc.split(/(?<=[.!?])\s+/);
	const instructional = [
		/^used to show\b/i,
		/^show this\b/i,
		/^show only\b/i,
		/^show if\b/i,
		/^shown\b/i,        // "shown with �", "shown only when �", "shown together �"
		/^together with\b/i,
		/^only show\b/i,
	];
	const kept = sentences.filter(s => !instructional.some(re => re.test(s.trim())));
	return kept.join(' ').trim() || desc;
}
const VP_H = 900;

// Singleton browser � shared across all requests, one isolated context per request.
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
		const _attemptT = Date.now();
		console.log(`[Percepta:perf] callGemini attempt ${attempt + 1}/3 � sending request...`);
		const response = await fetch(geminiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body
		});
		console.log(`[Percepta:perf] callGemini attempt ${attempt + 1}/3 � response ${response.status} in ${Date.now() - _attemptT}ms`);
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

function getInlineImagePart(candidates, { includeThought = false } = {}) {
	for (let ci = 0; ci < (candidates?.length ?? 0); ci++) {
		const parts = candidates?.[ci]?.content?.parts ?? [];
		for (const part of parts) {
			if (!includeThought && part?.thought) continue;
			const inline = part?.inline_data ?? part?.inlineData;
			if (inline?.data && (inline?.mime_type || inline?.mimeType)) {
				return {
					data: inline.data,
					mimeType: inline.mime_type ?? inline.mimeType,
					candidateIndex: ci,
					thought: !!part?.thought,
				};
			}
		}
	}
	return null;
}


// ---------------------------------------------------------------------------
// Gemini image generation — private helpers
// ---------------------------------------------------------------------------

const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const GEMINI_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function buildGeminiImageRequestBody(prompt, imageB64, mimeType = 'image/png') {
	return JSON.stringify({
		contents: [{
			role: 'user',
			parts: [
				{ text: prompt },
				{ inlineData: { mimeType, data: imageB64 } }
			]
		}],
		generationConfig: {
			responseModalities: ['IMAGE']
		}
	});
}

function parseStreamedImageResponse(rawText) {
	let chunks;
	try {
		chunks = JSON.parse(rawText);
	} catch {
		try {
			chunks = JSON.parse('[' + rawText.replace(/,\s*$/, '') + ']');
		} catch {
			throw new Error('Failed to parse streamed image response as JSON');
		}
	}
	if (!Array.isArray(chunks)) chunks = [chunks];

	for (const chunk of chunks) {
		const inline = getInlineImagePart(chunk?.candidates, { includeThought: false });
		if (inline?.data && inline?.mimeType) return inline;
	}
	for (const chunk of chunks) {
		const inline = getInlineImagePart(chunk?.candidates, { includeThought: true });
		if (inline?.data && inline?.mimeType) return inline;
	}
	return null;
}

async function postGeminiImageRequest(apiKey, body, { timeoutMs = 150000 } = {}) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:streamGenerateContent?key=${apiKey}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (response.ok) return response;
		const retryable = GEMINI_RETRYABLE_STATUS.has(response.status);
		const errBody = await response.json().catch(() => ({}));
		const message = errBody.error?.message ?? `Gemini API error ${response.status}`;
		console.warn(`[Percepta] Gemini image attempt ${attempt + 1} failed: ${response.status} - ${message}`, JSON.stringify(errBody?.error ?? errBody));
		if (!retryable) throw new Error(message);
	}
	throw new Error('Gemini image request failed after retries');
}

// ---------------------------------------------------------------------------
// Public: generate an image from a prompt + input image via Gemini
// Returns a data URI string, e.g. "data:image/png;base64,..."
// ---------------------------------------------------------------------------
async function geminiGenerateImage(apiKey, prompt, imageB64, { mimeType = 'image/png', timeoutMs = 150000 } = {}) {
	const body = buildGeminiImageRequestBody(prompt, imageB64, mimeType);
	const response = await postGeminiImageRequest(apiKey, body, { timeoutMs });
	const rawText = await response.text();
	const inline = parseStreamedImageResponse(rawText);
	if (!inline?.data || !inline?.mimeType) {
		throw new Error(`Gemini image response contained no image part (raw length: ${rawText.length})`);
	}
	return `data:${inline.mimeType};base64,${inline.data}`;
}

const ANALYSIS_STEP_TIMEOUT_MS = 60000;

function createStepTimeoutError(label) {
	const err = new Error(`Analysis timed out during ${label}. Please try again.`);
	err.name = 'AnalysisStepTimeoutError';
	return err;
}

async function withStepTimeout(promise, label, timeoutMs = ANALYSIS_STEP_TIMEOUT_MS) {
	let timerId;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timerId = setTimeout(() => reject(createStepTimeoutError(label)), timeoutMs);
			})
		]);
	} finally {
		clearTimeout(timerId);
	}
}

async function withOptionalStepTimeout(promise, label, onTimeout, timeoutMs = ANALYSIS_STEP_TIMEOUT_MS) {
	try {
		return await withStepTimeout(promise, label, timeoutMs);
	} catch (err) {
		if (err?.name === 'AnalysisStepTimeoutError') {
			return await onTimeout(err);
		}
		throw err;
	}
}

async function captureViewportScreenshot(page, vpW, vpH, perf) {
	const withTimeout = async (promise, timeoutMs, message) => {
		let timerId;
		try {
			return await Promise.race([
				promise,
				new Promise((_, reject) => {
					timerId = setTimeout(() => reject(new Error(message)), timeoutMs);
				})
			]);
		} finally {
			clearTimeout(timerId);
		}
	};

	// Stop any ongoing page loads / pending frames
	try { await page.evaluate(() => window.stop()); } catch { /* ignore */ }

	// Use CDP directly — bypasses Puppeteer v22+'s internal "settle" waiting logic
	// so page.screenshot() doesn't hang on pages with infinite animations/rAF loops.
	const client = await page.createCDPSession();
	try {
		perf('screenshot capture started');
		try {
			const { data } = await withTimeout(
				client.send('Page.captureScreenshot', {
					format: 'png',
					clip: { x: 0, y: 0, width: vpW, height: vpH, scale: 1 },
					fromSurface: true,
					captureBeyondViewport: false,
				}),
				15000,
				'Viewport screenshot timed out'
			);
			return Buffer.from(data, 'base64');
		} catch (err) {
			console.warn('[Percepta] Primary screenshot capture failed, retrying without clip:', err.message);
			perf('screenshot fallback started');
			const { data } = await withTimeout(
				client.send('Page.captureScreenshot', {
					format: 'png',
					fromSurface: true,
				}),
				15000,
				'Simple screenshot fallback timed out'
			);
			return Buffer.from(data, 'base64');
		}
	} finally {
		try { await client.detach(); } catch { /* ignore */ }
	}
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

const HEATMAP_PROMPT =
	'Create a predictive visual-attention heatmap overlay for this exact webpage screenshot. ' +
	'Keep the original screenshot geometry and content. Do not redesign, restyle, crop, or replace the UI. ' +
	'Highlight only likely attention hotspots over real UI elements and keep low-attention areas mostly unchanged. ' +
	'Do not add any annotations, arrows, lines, circles, boxes, labels, captions, legends, or explanatory marks. ' +
	'Do not add any new text at all. Keep only the text that already exists in the original screenshot. ' +
	'Do not add logos, icons, symbols, or extra UI elements. ' +
	'Use translucent red/orange/yellow heat, with clear local hotspots rather than one full-page glow. ' +
	'Return only one final image that is the original screenshot plus heat overlay.';

async function buildHeatmap(apiKey, screenshotB64, elements, vpW, vpH) {
	const HEATMAP_TIMEOUT_MS = 60000;
	const heatmapPipeline = (async () => {
		try {
			const result = await geminiGenerateImage(apiKey, HEATMAP_PROMPT, screenshotB64, { timeoutMs: 55000 });
			console.info('[Percepta] Heatmap generated with', GEMINI_IMAGE_MODEL);
			return result;
		} catch (err) {
			console.warn('[Percepta] Gemini heatmap unavailable, skipping heatmap:', err.message);
			return null;
		}
	})();

	const timeoutResult = await Promise.race([
		heatmapPipeline,
		new Promise(resolve => setTimeout(() => resolve('__HEATMAP_TIMEOUT__'), HEATMAP_TIMEOUT_MS)),
	]);

	if (timeoutResult === '__HEATMAP_TIMEOUT__') {
		console.warn(`[Percepta] Heatmap generation exceeded ${HEATMAP_TIMEOUT_MS / 1000}s — currently unavailable.`);
		return null;
	}

	return timeoutResult;
}

/**
 * Pre-filter images by checking if basic conditions are met based on full finding context.
 * Returns true if the image should be kept (condition likely met or no clear condition).
 * Returns false if the condition is clearly not met.
 */
function checkImageConditionAgainstFinding(imageSrc, imageDesc, finding) {
	const descLower = imageDesc.toLowerCase();
	const textLower = `${finding?.id || ''} ${finding?.category || ''} ${finding?.element || ''} ${finding?.issue || ''} ${finding?.recommendation || ''}`.toLowerCase();

	const hasAny = (arr) => arr.some(k => textLower.includes(k));

	// "shown only with imageXX" examples should not be selected directly.
	// They are still included automatically when their paired primary image is selected.
	if (/only with image\d+|only if image\d+ is shown/.test(descLower)) return false;

	// Strict per-image guards for the currently active image-enabled checks.
	// This enforces desc.txt-style "show only if" requirements.
	const strictRules = {
		'image122.jpg': () => hasAny(['paragraph', 'line spacing', 'line-height', 'tight spacing', 'text block']) && !hasAny(['button', 'link', 'nav', 'menu']),
		'image124.jpg': () => hasAny(['paragraph', 'line spacing', 'line-height', 'tight spacing', 'text block']) && !hasAny(['button', 'link', 'nav', 'menu']),
		'image225.png': () => hasAny(['text over image', 'text over photo', 'placed over image', 'photo', 'overlay', 'patterned background']) && hasAny(['contrast', 'hard to read', 'unreadable']),
		'image227.png': () => hasAny(['text over image', 'text over photo', 'placed over image', 'photo', 'overlay', 'patterned background']) && hasAny(['contrast', 'hard to read', 'unreadable']),
		'image230.png': () => hasAny(['text over image', 'text over photo', 'placed over image', 'photo', 'overlay', 'patterned background']) && hasAny(['contrast', 'hard to read', 'unreadable']),
		'image183.jpg': () => hasAny(['contrast', 'hard to read', 'unreadable']) && hasAny(['text', 'background']),
		'image185.jpg': () => hasAny(['contrast', 'hard to read', 'unreadable']) && hasAny(['text', 'background']),
		'image54.png': () => hasAny(['icon']) && hasAny(['text', 'heavy', 'weight']),
		'image55.png': () => hasAny(['icon']) && hasAny(['text', 'heavy', 'weight']),
		'image277.jpg': () => hasAny(['split', 'left-right', 'two column', 'column']) && hasAny(['imbalance', 'heavy', 'weight']),
		'image281.jpg': () => hasAny(['split', 'left-right', 'two column', 'column']) && hasAny(['imbalance', 'heavy', 'weight']),
		'image282.jpg': () => hasAny(['split', 'left-right', 'two column', 'column']) && hasAny(['imbalance', 'heavy', 'weight']),
		'image51.png': () => hasAny(['heading', 'h1', 'h2']) && hasAny(['oversized', 'too big', 'outweigh', 'hierarchy']),
		'image52.png': () => hasAny(['heading', 'h1', 'h2']) && hasAny(['oversized', 'too big', 'outweigh', 'hierarchy']),
		'image53.png': () => hasAny(['heading', 'h1', 'h2', 'hierarchy']),
		'image58.png': () => hasAny(['button']) && hasAny(['same', 'equal', 'primary', 'secondary', 'tertiary', 'weight']),
		'image59.png': () => hasAny(['button']) && hasAny(['same', 'equal', 'primary', 'secondary', 'tertiary', 'weight']),
		'image127.png': () => hasAny(['link']) && hasAny(['indistinguishable', 'unstyled', 'blend', 'underline', 'same color', 'same colour']),
		'image128.png': () => hasAny(['link']) && hasAny(['indistinguishable', 'unstyled', 'blend', 'underline', 'same color', 'same colour']),
		'image129.png': () => hasAny(['link']) && hasAny(['indistinguishable', 'unstyled', 'blend', 'underline', 'same color', 'same colour']),
		'image251.jpeg': () => hasAny(['link']) && hasAny(['indistinguishable', 'unstyled', 'blend', 'underline', 'same color', 'same colour']),
		'image102.png': () => hasAny(['type scale', 'font size', 'typographic hierarchy', 'arbitrary', 'spacing scale', 'different spacing values', 'inconsistent spacing', 'random spacing']),
		'image105.png': () => hasAny(['type scale', 'font size', 'typographic hierarchy', 'arbitrary', 'spacing scale', 'different spacing values', 'inconsistent spacing', 'random spacing']),
		'image112.jpg': () => hasAny(['line length', 'characters per line', 'text block', 'too wide', '90', '110']),
		'image132.jpg': () => hasAny(['center', 'centred', 'centered', 'alignment']) && hasAny(['line', 'paragraph', 'text']),
		'image133.jpg': () => hasAny(['center', 'centred', 'centered', 'alignment']) && hasAny(['line', 'paragraph', 'text']),
		'image141.jpg': () => hasAny(['all-caps', 'uppercase']) && hasAny(['letter-spacing', 'spacing']),
		'image37.png': () => hasAny(['grey', 'gray']) && hasAny(['colored background', 'coloured background', 'tinted', 'card']),
		'image41.png': () => hasAny(['grey', 'gray']) && hasAny(['colored background', 'coloured background', 'tinted', 'card']),
		'image151.jpeg': () => hasAny(['palette', 'few colors', 'few colours', 'limited']) && hasAny(['color', 'colour', 'grey', 'gray']),
		'image153.png': () => hasAny(['grey', 'gray', 'scale', 'shades']),
		'image180.png': () => hasAny(['grey', 'gray']) && hasAny(['temperature', 'cool', 'warm', 'neutral']),
		'image181.png': () => hasAny(['grey', 'gray']) && hasAny(['temperature', 'cool', 'warm', 'neutral']),
		'image63.jpeg': () => hasAny(['cramped', 'compressed', 'tight spacing', 'padding', 'spacing']) && hasAny(['form', 'field', 'input', 'label', 'text']),
		'image65.jpeg': () => hasAny(['cramped', 'compressed', 'tight spacing', 'padding', 'spacing']) && hasAny(['form', 'field', 'input', 'label', 'text']),
		'image72.png': () => hasAny(['full-width', 'stretched', 'spread out', 'too wide', 'line lengths uncomfortable']),
		'image94.png': () => hasAny(['too small', 'touch target', 'minimum size', '32x32', '31x19']),
		'image95.png': () => hasAny(['too small', 'touch target', 'minimum size', '32x32', '31x19']),
		'image205.png': () => hasAny(['button']) && hasAny(['shadow', 'raised', 'flat']),
		'image233.jpg': () => hasAny(['icon']) && hasAny(['40+px', 'oversized', 'too large', 'scaled']),
		'image242.png': () => hasAny(['aspect ratio', 'variable-height', 'card grid', 'grid alignment']),
	};

	if (strictRules[imageSrc] && !strictRules[imageSrc]()) return false;

	// Hard gate for paragraph-specific examples: only allow when the finding is
	// clearly about paragraph/body-text readability or paragraph line metrics.
	const paragraphOnlyCondition =
		/paragraph|body text|text area has\s*\d+\+?\s*characters|\d+\+?\s*lines/i.test(descLower);
	if (paragraphOnlyCondition) {
		const paragraphSignals = [
			'paragraph',
			'body text',
			'line length',
			'characters per line',
			'lines longer than',
			'text block',
		];
		const nonParagraphSignals = [
			'button',
			'link',
			'nav',
			'menu',
			'icon',
			'target',
		];
		const hasParagraphSignal = paragraphSignals.some(s => textLower.includes(s));
		const hasNonParagraphSignal = nonParagraphSignals.some(s => textLower.includes(s));
		if (!hasParagraphSignal || hasNonParagraphSignal) return false;
	}

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
		{ pattern: /heading.*hierarchy.*issue|heading.*too big|no primary heading|headings fail/i, keywords: ['heading', 'h1', 'hierarchy', 'title', 'structure'] },
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
		{ pattern: /text.*photo|text.*image/i, keywords: ['text on photo', 'text on image', 'text over photo', 'text over image', 'over image', 'over photo', 'overlay', 'low-contrast', 'contrast'] },
		// Typography
		{ pattern: /text.*relative unit.*em/i, keywords: ['em unit', 'relative unit', 'responsive text'] },
		{ pattern: /paragraph.*\d\+ lines/i, keywords: ['paragraph', 'long text', 'body text'] },
		{ pattern: /line.*90-110 char/i, keywords: ['line length', 'character count', 'wide text', 'characters per line'] },
		// Layout
		{ pattern: /element.*lot of text.*spacing.*small/i, keywords: ['tight spacing', 'cramped', 'padding'] },
		{ pattern: /spacing between these elements is too random|spacing.*too random/i, keywords: ['spacing values', 'different spacing', 'inconsistent spacing', 'random spacing', 'too many spacing'] },
		{ pattern: /arbitrary font size choices|defined type scale|typographic hierarchy/i, keywords: ['font size', 'type scale', 'typographic hierarchy', 'inconsistent hierarchy', 'arbitrary'] },
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
		{ pattern: /links.*indistinguishable|links.*unstyled|links.*lack.*visual|links.*blend/i, keywords: ['link', 'indistinguishable', 'unstyled', 'blend', 'body text', 'underline', 'same color', 'same colour'] },
		// Interactive targets
		{ pattern: /small.*interactive.*element|touch target.*minimum|element.*smaller.*32px|small.*touch target/i, keywords: ['element', 'button', 'target', 'touch', 'smaller', '32', 'px'] },
		// Custom styling
		{ pattern: /checkbox.*radio button.*no styling/i, keywords: ['checkbox', 'radio', 'input'] },
		{ pattern: /basic bullet point/i, keywords: ['bullet', 'list', 'ul'] },
		{ pattern: /testimonial/i, keywords: ['testimonial', 'quote', 'review'] },
		// Background
		{ pattern: /\d\+.*element.*white background/i, keywords: ['background', 'panel', 'card', 'section'] },
		{ pattern: /\d\+.*same background.*section/i, keywords: ['section', 'background', 'panel'] },
		// Split layout (left-right column balance only � NOT for top-bar or vertical imbalance)
		{ pattern: /split layout|left-right column|left-right.*imbalance/i, keywords: ['split', 'two column', 'left-right', 'column', 'split-screen'] },
		// Centered text alignment (image132, image133)
		{ pattern: /longer than two or three lines|elements.*more than.*lines.*center|if you want them to be more subtle/i, keywords: ['center', 'centred', 'centered', 'alignment', 'align'] },
		// Warm/cool grey temperature (image180, image181)
		{ pattern: /natural gray/i, keywords: ['gray', 'grey', 'desaturated', 'neutral', 'cool', 'warm', 'temperature', 'hue'] },
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

	// Condition pattern not recognized or too complex to check algorithmically.
	// Stay conservative: allow only if the finding still shares core topical overlap.
	if (finding?.category && !textLower.includes(String(finding.category).toLowerCase())) {
		return hasAny(['text', 'button', 'link', 'spacing', 'heading', 'icon', 'image', 'color', 'colour', 'contrast']);
	}
	return true;
}

/**
 * Detect spacing findings that describe inconsistent/random spacing scale usage
 * (e.g. "67 different spacing values"). These should map to image102/image105.
 * @param {{ category?: string, issue?: string, recommendation?: string, element?: string }} finding
 */
function isSpacingScaleVarianceFinding(finding) {
	if (finding.category !== 'Spacing & Layout') return false;
	const text = `${finding.issue || ''} ${finding.recommendation || ''} ${finding.element || ''}`.toLowerCase();
	return (
		/(\d+)\s+different\s+spacing\s+values/.test(text) ||
		/different\s+spacing\s+values/.test(text) ||
		/inconsistent\s+spacing\s+creates\s+a\s+disjointed\s+visual\s+rhythm/.test(text) ||
		/random\s+spacing/.test(text) ||
		/spacing\s+scale/.test(text)
	);
}

/**
 * Detect text-on-image readability findings (regular and boxed variants).
 * For this issue family, constrain examples to image225/image227/image230.
 * @param {{ category?: string, issue?: string, recommendation?: string, element?: string }} finding
 */
function isTextOverImageFinding(finding) {
	if (finding.category !== 'Readability') return false;
	const text = `${finding.issue || ''} ${finding.recommendation || ''} ${finding.element || ''}`.toLowerCase();
	return /over image areas|placed over image|patterned-background areas|text element.*over image|text over a photo/.test(text);
}

/**
 * Strictly keep only the issue families agreed for the current calibration phase.
 * This removes "first checks win" behavior by eliminating unrelated findings
 * before image selection and per-category capping.
 * @param {{ category?: string, id?: string, issue?: string, recommendation?: string, element?: string, noImages?: boolean }} finding
 */
function isFindingInActiveScope(finding) {
	if (!finding || typeof finding !== 'object') return false;
	const category = finding.category || '';
	const text = `${finding.id || ''} ${finding.issue || ''} ${finding.recommendation || ''} ${finding.element || ''}`.toLowerCase();
	const hasAny = (arr) => arr.some(k => text.includes(k));
	const isSparsePage = hasAny(['very little content', 'almost no visible content', 'near-empty pages', 'splash', 'coming-soon'])
		&& hasAny(['characters', 'interactive element', 'main area']);

	// Allow the sparse-page diagnostic even when it is intentionally image-free.
	if (finding.noImages) return category === 'Visual Hierarchy' && isSparsePage;

	if (category === 'Readability') {
		const lowContrast = hasAny(['contrast', 'apca', 'hard to read', 'unreadable']) && hasAny(['text', 'button', 'link', 'background']);
		const tightLeading = hasAny(['line-height', 'line height', 'tight line spacing', 'spaced too tightly']);
		const textOnImage = hasAny(['text over image', 'text over photo', 'placed over image', 'overlay', 'scrim', 'photo']);
		return lowContrast || tightLeading || textOnImage;
	}

	if (category === 'Visual Weight') {
		const leftRightImbalance = hasAny(['left', 'right']) && hasAny(['imbalance', 'split', 'counterweight', 'column']);
		const iconVsText = hasAny(['icon']) && hasAny(['text', 'heavy', 'weight']);
		const dominantHero = hasAny(['dominant', 'hero', 'counterweight', 'gravitational pull']);
		return leftRightImbalance || iconVsText || dominantHero;
	}

	if (category === 'Visual Hierarchy') {
		const sparsePage = isSparsePage;
		const oversizedHeadings = hasAny(['heading']) && hasAny(['oversized', 'too big', 'outweigh', 'visual weight']);
		const equalButtonWeight = hasAny(['button']) && hasAny(['same', 'equal', 'primary', 'secondary', 'tertiary', 'weight']);
		const linksBlendIn = hasAny(['link']) && hasAny(['indistinguishable', 'unstyled', 'blend', 'underline', 'same color', 'same colour']);
		return sparsePage || oversizedHeadings || equalButtonWeight || linksBlendIn;
	}

	if (category === 'Typography') {
		const typeScale = hasAny(['type scale', 'font size', 'typographic hierarchy', 'arbitrary']);
		const longLineLength = hasAny(['line length', 'characters', 'too wide', '90', '110']);
		const allCapsSpacing = hasAny(['all-caps', 'uppercase']) && hasAny(['letter-spacing', 'spacing']);
		return typeScale || longLineLength || allCapsSpacing;
	}

	if (category === 'Colour Palette') {
		const fewGreys = hasAny(['grey', 'gray']) && hasAny(['few', '1-2', 'three', '9-shade', 'scale']);
		const grayOnColor = hasAny(['grey', 'gray']) && hasAny(['colored background', 'coloured background', 'tinted', 'card']);
		const limitedPalette = hasAny(['limited', 'minimal', 'few colors', 'few colours', 'palette', 'only']) && hasAny(['color', 'colour', 'grey', 'gray']);
		return fewGreys || grayOnColor || limitedPalette;
	}

	if (category === 'Spacing & Layout') {
		const crampedInternal = hasAny(['cramped', 'compressed', 'too close', 'less than 8 pixels', 'tight spacing', 'padding']);
		const overstretchedRows = hasAny(['full-width', 'stretched', 'spread out', 'too wide', 'line lengths uncomfortable']);
		const spacingScale = hasAny(['spacing scale', 'different spacing values', 'inconsistent spacing', 'random spacing']);
		const stackGapInconsistency = hasAny(['vertical content stack', 'vertically stacked', 'gaps between items', 'same stack', 'uniform gap']);
		return crampedInternal || overstretchedRows || spacingScale || stackGapInconsistency;
	}

	if (category === 'Interactive Targets') {
		const tooSmall = hasAny(['too small', 'touch target', 'minimum size', '32x32', '31x19']);
		const notDifferentiated = hasAny(['primary', 'secondary', 'tertiary', 'same weight', 'equal-weight', 'button styles']);
		const tooClose = hasAny(['too close', 'no space', 'accidental taps', 'wrong item']);
		return tooSmall || notDifferentiated || tooClose;
	}

	if (category === 'Icon & Image Size') {
		const oversizedIcons = hasAny(['icon']) && hasAny(['40+px', 'oversized', 'too large', 'scaled']);
		const mixedAspect = hasAny(['aspect ratio', 'variable-height', 'card grid', 'grid alignment']);
		const textOverImage = hasAny(['text']) && hasAny(['image', 'photo', 'overlay']);
		return oversizedIcons || mixedAspect || textOverImage;
	}

	return false;
}

/**
 * @param {Array<any>} findings
 */
function filterFindingsToActiveScope(findings) {
	return (findings || []).filter(isFindingInActiveScope);
}

/** @param {string} s */
function firstQuotedText(s) {
	if (typeof s !== 'string') return null;
	const m = s.match(/'[^']{2,120}'/);
	return m ? m[0] : null;
}

/** @param {string} s */
function firstZoneLabel(s) {
	if (typeof s !== 'string') return null;
	const m = s.match(/\b(top|middle|bottom)-(left|centre|right)\b/i);
	return m ? m[0].toLowerCase() : null;
}

/**
 * Make sure rewritten prose still names the concrete text snippet that triggered the finding.
 * This avoids vague messages like "one text area" with no anchor.
 * @param {any} rewritten
 * @param {any} original
 */
function preserveQuotedReference(rewritten, original) {
	if (!rewritten || !original) return rewritten;
	const source = `${original.issue || ''} ${original.element || ''}`;
	const quote = firstQuotedText(source);
	if (!quote) return rewritten;

	const issue = typeof rewritten.issue === 'string' ? rewritten.issue : '';
	const element = typeof rewritten.element === 'string' ? rewritten.element : '';
	if (issue.includes(quote) || element.includes(quote)) return rewritten;

	const zone = firstZoneLabel(source);
	const suffix = zone
		? ` The affected text is ${quote} in the ${zone}.`
		: ` The affected text is ${quote}.`;
	return { ...rewritten, issue: `${issue.trim()}${suffix}`.trim() };
}

/**
 * @param {number} value
 */
function clamp01(value) {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Lightweight confidence fallback when model omits confidence.
 * @param {any} finding
 */
function inferConfidence(finding) {
	let confidence = 0.85;
	const severity = String(finding?.severity || '').toLowerCase();
	if (severity === 'info') confidence *= 0.8;
	if (severity === 'warning') confidence *= 0.9;

	const text = `${finding?.element || ''} ${finding?.issue || ''}`;
	const m = text.match(/\b(\d+)\b/);
	const affectedCount = m ? parseInt(m[1], 10) : 0;
	if (affectedCount > 0 && affectedCount < 3) confidence *= 0.75;

	if (/\bfooter\b|\bbottom\b/i.test(text)) confidence *= 0.8;

	return Math.round(clamp01(confidence) * 100) / 100;
}

/**
 * Severity-aware AI gate thresholds. Higher-severity findings should not require
 * the same confidence bar as informational polish findings.
 * @param {{ severity?: string }} finding
 */
function confidenceThresholdForFinding(finding) {
	const severity = String(finding?.severity || '').toLowerCase();
	if (severity === 'critical') return 0.55;
	if (severity === 'warning') return 0.65;
	return 0.75;
}

/**
 * Keep score math consistent with algorithmic.js but recompute from a provided
 * findings list so UI score matches the actually displayed findings.
 * @param {Array<{ severity?: string }>} findings
 */
function computeOverallScoreFromFindings(findings) {
	const penalty = (findings || []).reduce(
		(acc, f) => acc + (f.severity === 'critical' ? 12 : f.severity === 'warning' ? 7 : 3),
		0
	);
	return Math.max(20, Math.min(95, 95 - Math.min(penalty, 70)));
}

async function callGeminiWithFindings(apiKey, findings, overallScore, codeContext = null, screenshotB64 = null) {
	const scopedFindings = filterFindingsToActiveScope(findings);
	const sourceById = new Map(scopedFindings.map(f => [f.id, f]));
	const spacingScaleFindingIds = new Set(
		scopedFindings.filter(isSpacingScaleVarianceFinding).map(f => f.id)
	);

	const categoriesPresent = [...new Set(scopedFindings.map(f => f.category))];
	const bookKnowledgeContext = Object.fromEntries(
		categoriesPresent
			.filter(cat => BOOK_KNOWLEDGE[cat])
			.map(cat => [cat, BOOK_KNOWLEDGE[cat].excerpt])
	);

	// Build code context summary if provided
	let codeContextSummary = '';
	if (codeContext) {
		codeContextSummary = `

CODE CONTEXT � Use this technical information about the website's implementation to enrich your analysis:

CSS (${codeContext.css.stylesheets.length} stylesheets):
- ${codeContext.css.colors.length} unique colors: ${codeContext.css.colors.slice(0, 8).join(', ')}${codeContext.css.colors.length > 8 ? '...' : ''}
- ${codeContext.css.fonts.length} font families: ${codeContext.css.fonts.join(', ')}
- ${codeContext.css.cssVariables.length} CSS custom properties
- ${codeContext.css.mediaQueries.length} responsive media queries
- ${codeContext.css.inlineStyles.length} elements with inline styles

HTML Structure:
- Semantic elements: <header>�${codeContext.html.semanticElements.header}, <nav>�${codeContext.html.semanticElements.nav}, <main>�${codeContext.html.semanticElements.main}, <footer>�${codeContext.html.semanticElements.footer}
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
IMAGE SELECTION GUIDE

Each finding has an "availableImages" array. Each entry has:
  src   � exact filename to use in bookImages
  desc  � description that may include a condition ("show this only if X")
  pair  � (optional) companion image for before/after sets

SELECTION PROCESS � for each available image:

1. If the desc contains "show this only if X" or "only if X":
   - Does the finding's issue MENTION or CLEARLY IMPLY X? If yes ? select.
   - Does the finding's topic broadly match X even if not stated verbatim? If yes ? select.
   - Only skip if the condition is clearly about something the finding does NOT involve at all.

2. If the desc has no "only if" condition ? select when it closely matches the finding's topic.

3. PAIRING: if you select an image that has a "pair" field ? also include the pair partner.

4. "shown only with imageXX" ? only include as a pair partner, not independently.

AIM to select 1-3 images per finding when relevant images are available. It is better to include a relevant image than to leave bookImages empty.

For each selected image, return an object with:
  src     � the exact filename
  caption � a 1-2 sentence direct statement about what this image demonstrates in context of this finding. Start with the action or observation directly (e.g. "A small high-contrast button can counterbalance a much larger photo in a split layout."). Do NOT start with "This image shows", "This shows", or any meta-phrase. Do NOT copy the desc verbatim.`;

	const findingsWithImages = scopedFindings.map(f => {
		if (f.noImages) return { ...f, availableImages: [] };
		const isSpacingScaleVariance = isSpacingScaleVarianceFinding(f);
		const isTextOverImage = isTextOverImageFinding(f);
		const available = BOOK_IMAGES
			.filter(img => img.tags.includes(f.category))
			.filter(img => isAllowedImageForCategory(f.category, img.src))
			// Deterministic routing for spacing image pair selection.
			.filter(img => {
				if (isTextOverImage) return img.src === 'image225.png' || img.src === 'image227.png' || img.src === 'image230.png';
				if (f.category !== 'Spacing & Layout') return true;
				if (isSpacingScaleVariance) return img.src === 'image102.png' || img.src === 'image105.png';
				return img.src !== 'image102.png' && img.src !== 'image105.png';
			})
			// Pre-filter by checking basic conditions against finding text
			.filter(img => checkImageConditionAgainstFinding(img.src, img.desc, f))
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

	// Keep only findings backed by at least one allowed, desc-matching image,
	// and cap each category to reduce noise.
	const categoryCount = new Map();
	const gatedFindingsWithImages = [];
	for (const f of findingsWithImages) {
		if (f.noImages) {
			const prevNoImages = categoryCount.get(f.category) || 0;
			if (prevNoImages >= MAX_FINDINGS_PER_CATEGORY) continue;
			categoryCount.set(f.category, prevNoImages + 1);
			gatedFindingsWithImages.push(f);
			continue;
		}
		const availableCount = Array.isArray(f.availableImages) ? f.availableImages.length : 0;
		if (availableCount === 0) continue;
		const prev = categoryCount.get(f.category) || 0;
		if (prev >= MAX_FINDINGS_PER_CATEGORY) continue;
		categoryCount.set(f.category, prev + 1);
		gatedFindingsWithImages.push(f);
	}

	console.log(`[Percepta] findings gated: ${findings.length} -> ${gatedFindingsWithImages.length} (max ${MAX_FINDINGS_PER_CATEGORY}/category)`);

	const bodyPayload = JSON.stringify({ overallScore, findings: gatedFindingsWithImages, bookKnowledge: bookKnowledgeContext });
	const body = JSON.stringify({
		system_instruction: { parts: [{ text: systemInstruction }] },
		contents: [{
			parts: [
				...(screenshotB64 ? [{ inline_data: { mime_type: 'image/png', data: screenshotB64 } }] : []),
				{ text: bodyPayload }
			]
		}],
		generationConfig: {
			maxOutputTokens: 16384,
			responseMimeType: 'application/json',
			thinkingConfig: { thinkingBudget: 0 },
		}
	});
	console.log(`[Percepta:perf] callGeminiWithFindings body size: ${(body.length / 1024).toFixed(1)} KB`);

	const RETRYABLE = new Set([429, 500, 502, 503, 504]);

	/** @param {string} modelId @param {string} reqBody @returns {Promise<any>} */
	async function tryModel(modelId, reqBody) {
		const spacingScaleForcedImgs = ['image102.png', 'image105.png'];
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
		let lastErr = /** @type {Error | null} */ (null);
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				await new Promise(r => setTimeout(r, 4000 * Math.pow(3, attempt - 1)));
			}
			const _attemptT = Date.now();
			console.log(`[Percepta:perf] callGeminiWithFindings(${modelId}) attempt ${attempt + 1}/3 � sending request (${gatedFindingsWithImages.length} findings)...`);
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: reqBody,
				signal: AbortSignal.timeout(90_000),
			});
			console.log(`[Percepta:perf] callGeminiWithFindings(${modelId}) attempt ${attempt + 1}/3 � response ${response.status} in ${Date.now() - _attemptT}ms`);
			if (response.ok) {
				const data = await response.json();
				const text = data.candidates?.[0]?.content?.parts
					?.map((/** @type {{ text?: string }} */ p) => p.text ?? '').join('') ?? '';
				console.log(`[Percepta] raw ${modelId} findings text:`, text.slice(0, 300));
				const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
				const result = JSON.parse(cleaned);
				if (Array.isArray(result.findings)) {
					result.findings = result.findings.map(f => preserveQuotedReference(f, sourceById.get(f.id)));
					const normalizedFindings = result.findings.map(f => {
						const source = sourceById.get(f.id) || {};
						const validated = typeof f.validated === 'boolean' ? f.validated : true;
						const mergedForConfidence = { ...source, ...f };
						const confidence = Math.round(clamp01(
							typeof f.confidence === 'number' ? f.confidence : inferConfidence(mergedForConfidence)
						) * 100) / 100;
						return {
							...f,
							severity: f.severity ?? source.severity,
							validated,
							validationReason: typeof f.validationReason === 'string'
								? f.validationReason
								: (validated ? 'Visually supported in screenshot.' : 'Not visually supported in screenshot.'),
							confidence,
						};
					});
					const dropReasons = { notValidated: 0, lowConfidence: 0 };
					result.findings = normalizedFindings.filter(f => {
						if (!f.validated) {
							dropReasons.notValidated++;
							return false;
						}
						const threshold = confidenceThresholdForFinding(f);
						if (f.confidence < threshold) {
							dropReasons.lowConfidence++;
							return false;
						}
						return true;
					});
					result.gateReport = {
						inputCount: normalizedFindings.length,
						keptCount: result.findings.length,
						droppedCount: normalizedFindings.length - result.findings.length,
						dropReasons,
						thresholds: {
							critical: 0.55,
							warning: 0.65,
							info: 0.75,
						},
					};
					if (result.findings.length === 0) {
						result.summary = result.summary || 'No visually validated issues were confirmed in this screenshot.';
					}
					// First pass: resolve & validate images per finding
					result.findings = result.findings.map(f => {
						const rawImages = Array.isArray(f.bookImages) ? f.bookImages : [];
						console.log(`[Percepta] ${modelId} selected ${rawImages.length} images for finding ${f.id}`);
						const captionMap = new Map();
						for (const item of rawImages) {
							if (item && typeof item === 'object' && typeof item.src === 'string' && BOOK_IMAGE_MAP[item.src]) {
								captionMap.set(item.src, item.caption || cleanCaption(BOOK_IMAGE_MAP[item.src].desc));
							} else if (typeof item === 'string' && BOOK_IMAGE_MAP[item]) {
								captionMap.set(item, cleanCaption(BOOK_IMAGE_MAP[item].desc));
							}
						}
						// Auto-add missing pair partners
						for (const src of [...captionMap.keys()]) {
							const partner = BOOK_IMAGE_MAP[src].pair;
							if (partner && BOOK_IMAGE_MAP[partner] && !captionMap.has(partner)) {
								captionMap.set(partner, cleanCaption(BOOK_IMAGE_MAP[partner].desc));
							}
						}
						// Enforce spacing-scale exemplar pair for CSS003-style findings.
						if (spacingScaleFindingIds.has(f.id)) {
							for (const src of spacingScaleForcedImgs) {
								if (BOOK_IMAGE_MAP[src] && !captionMap.has(src)) {
									captionMap.set(src, cleanCaption(BOOK_IMAGE_MAP[src].desc));
								}
							}
						}
						const bookImages = [...captionMap.entries()].map(([src, caption]) => ({ src, caption }));
						return { ...f, bookImages };
					});
					// Second pass: deduplicate — each image may only appear in one finding.
					// Priority findings (spacing-scale variance) keep their forced images first.
					const usedImages = new Set();
					const ordered = [...result.findings].sort((a, b) => {
						const ap = spacingScaleFindingIds.has(a.id) ? 1 : 0;
						const bp = spacingScaleFindingIds.has(b.id) ? 1 : 0;
						return bp - ap;
					});
					const dedupedById = new Map();
					for (const f of ordered) {
						const deduped = (f.bookImages ?? []).filter(img => {
							if (usedImages.has(img.src)) return false;
							usedImages.add(img.src);
							return true;
						});
						if (deduped.length !== (f.bookImages ?? []).length) {
							console.log(`[Percepta] Finding ${f.id}: deduplicated ${(f.bookImages ?? []).length} -> ${deduped.length} images`);
						}
						dedupedById.set(f.id, deduped);
					}
					result.findings = result.findings.map(f => ({ ...f, bookImages: dedupedById.get(f.id) || [] }));
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
		throw lastErr ?? new Error(`${modelId} request failed`);
	}

	// Try primary model (gemini-2.5-flash, thinking disabled for speed)
	try {
		return await tryModel('gemini-2.5-flash', body);
	} catch (primaryErr) {
		console.warn(`[Percepta] gemini-2.5-flash failed (${primaryErr.message}), trying gemini-2.0-flash fallback...`);
	}

	// Fallback: gemini-2.0-flash � older model, higher availability, no thinkingConfig
	const fallbackBody = JSON.stringify({
		system_instruction: { parts: [{ text: systemInstruction }] },
		contents: [{
			parts: [
				...(screenshotB64 ? [{ inline_data: { mime_type: 'image/png', data: screenshotB64 } }] : []),
				{ text: bodyPayload }
			]
		}],
		generationConfig: {
			maxOutputTokens: 16384,
			responseMimeType: 'application/json',
		}
	});
	return await tryModel('gemini-2.0-flash', fallbackBody);
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

	const encoder = new TextEncoder();
	/** @type {ReadableStreamDefaultController} */
	let sse;
	/** @param {object} evt */
	function send(evt) { try { sse.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`)); } catch { } }
	const stream = new ReadableStream({ start(ctrl) { sse = ctrl; } });

	(async () => {
		try {
			const _t0 = Date.now();
			const _perf = (/** @type {string} */ label) => console.log(`[Percepta:perf] ${label} +${Date.now() - _t0}ms`);
			console.log(`[Percepta:perf] --- request start (mode=${mode}, url=${pageUrl}) ---`);
			send({ type: 'step', step: 0 });
			const browser = await getBrowser();
			_perf('browser acquired');
			const context = await browser.createBrowserContext();
			try {
				const page = await context.newPage();
				await page.setViewport({ width: VP_W, height: VP_H, deviceScaleFactor: 1 });

				try {
					await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 25000 });
				} catch {
					await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
				}
				_perf('page loaded');

				// -- Dismiss cookie/GDPR popups ----------------------------------------
				// 1. Click common "accept" buttons by visible text
				await page.evaluate(async () => {
					const ACCEPT_TEXTS = [
						'accept all', 'accept cookies', 'agree', 'i agree', 'allow all',
						'allow cookies', 'accept', 'accept all cookies', 'allow all cookies',
						'got it', 'ok', 'okay', 'continue', 'close', 'save preferences',
						'zustimmen', 'alle akzeptieren', 'akzeptieren',  // German
						'tout accepter', 'accepter', 'fermer',            // French
						'acceptar', 'aceptar todas',                      // Spanish
						'accetta', 'accetta tutto',                       // Italian
						'aceitar', 'aceitar tudo',                        // Portuguese
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

				// 2. Remove remaining popups — specific known frameworks + robust heuristics
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

					// Hide common CMP iframes (OneTrust/Cookiebot/TrustArc/etc.)
					document.querySelectorAll('iframe').forEach(frame => {
						const src = (frame.getAttribute('src') || '').toLowerCase();
						const title = (frame.getAttribute('title') || '').toLowerCase();
						const name = (frame.getAttribute('name') || '').toLowerCase();
						if (/cookie|consent|onetrust|cookielaw|cookiebot|trustarc|didomi|quantcast|sourcepoint|sp_message/.test(src)
							|| /cookie|consent|gdpr|privacy|cmp|sourcepoint/.test(title)
							|| /cookie|consent|gdpr|privacy|cmp|sp_message/.test(name)) {
					/** @type {HTMLElement} */ (frame).style.display = 'none';
						}
					});

					// Generic keyword selector sweep for common consent containers.
					const KEYWORD_SELECTOR = [
						'[id*="cookie" i]', '[class*="cookie" i]',
						'[id*="consent" i]', '[class*="consent" i]',
						'[id*="gdpr" i]', '[class*="gdpr" i]',
						'[id*="privacy" i]', '[class*="privacy" i]',
						'[data-testid*="cookie" i]', '[data-testid*="consent" i]',
						'[aria-label*="cookie" i]', '[aria-label*="consent" i]'
					].join(',');
					document.querySelectorAll(KEYWORD_SELECTOR).forEach(el => {
						const style = window.getComputedStyle(el);
						const r = el.getBoundingClientRect();
						const edgeLike = r.width >= window.innerWidth * 0.4 && (r.top <= window.innerHeight * 0.3 || r.bottom >= window.innerHeight * 0.7);
						if ((style.position === 'fixed' || style.position === 'absolute' || style.position === 'sticky' || edgeLike) && r.height >= 24) {
					/** @type {HTMLElement} */ (el).style.display = 'none';
						}
					});

					// Heuristic: full-page backdrops and bottom cookie bars
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const CONSENT_KEYWORDS = /cookie|consent|gdpr|privacy|datenschutz|accept|agree|opt.?in|onetrust|cookielaw|cookiebot|didomi|trustarc|cmp/i;
					document.querySelectorAll('*').forEach(el => {
						const style = window.getComputedStyle(el);
						if (style.position !== 'fixed' && style.position !== 'absolute' && style.position !== 'sticky') return;
						if ((parseInt(style.zIndex) || 0) < 10) return;
						const r = el.getBoundingClientRect();
						const isFullCoverage = r.width >= vw * 0.85 && r.height >= vh * 0.85;
						const isBottomCookieBar = r.width >= vw * 0.85 && r.height <= 280
							&& r.bottom >= vh * 0.75 && style.position === 'fixed';
						const isTopCookieBar = r.width >= vw * 0.7 && r.height >= 40 && r.height <= vh * 0.6
							&& r.top <= vh * 0.25;
						const isConsentLikeBar = r.width >= vw * 0.5 && r.height >= 40 && r.height <= vh * 0.6
							&& (r.top <= vh * 0.25 || r.bottom >= vh * 0.75);

						const attrBlob = [
							(el.id || ''),
							(el.className || ''),
							(el.getAttribute('role') || ''),
							(el.getAttribute('aria-label') || ''),
							(el.getAttribute('data-testid') || ''),
							(el.getAttribute('data-cy') || ''),
							(el.getAttribute('data-name') || ''),
						].join(' ').toLowerCase();

						if (isFullCoverage) {
							// Only remove if it looks like a consent/GDPR backdrop:
							// either semi-transparent background (typical dark overlay) or contains consent keywords.
							// Genuine design popups (login walls, welcome modals) are left intact so they
							// can be analysed as part of the page design.
							const bg = style.backgroundColor;
							const alpha = parseFloat((bg.match(/rgba?\([^)]+,\s*([\d.]+)\)/) || [])[1] ?? '1');
							const isSemiTransparent = alpha < 0.85;
							const text = /** @type {HTMLElement} */ (el).innerText || '';
							const hasConsentText = CONSENT_KEYWORDS.test(text);
							const hasConsentAttrs = CONSENT_KEYWORDS.test(attrBlob);
							if (isSemiTransparent || hasConsentText || hasConsentAttrs) {
						/** @type {HTMLElement} */ (el).style.display = 'none';
							}
						} else {
							const text = /** @type {HTMLElement} */ (el).innerText || '';
							const hasConsentText = CONSENT_KEYWORDS.test(text);
							const hasConsentAttrs = CONSENT_KEYWORDS.test(attrBlob);
							if ((isBottomCookieBar || isTopCookieBar || isConsentLikeBar) && (hasConsentText || hasConsentAttrs)) {
					/** @type {HTMLElement} */ (el).style.display = 'none';
							}
						}
					});

					// Re-enable body scroll that popups often lock
					document.body.style.overflow = '';
					document.documentElement.style.overflow = '';
				});

				// Some CMPs inject late; run a second pass after a short delay.
				await new Promise(r => setTimeout(r, 450));
				await page.evaluate(() => {
					const CONSENT_KEYWORDS = /cookie|consent|gdpr|privacy|datenschutz|onetrust|cookiebot|didomi|trustarc|cmp/i;
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					document.querySelectorAll('*').forEach(el => {
						const style = window.getComputedStyle(el);
						if (style.position !== 'fixed' && style.position !== 'absolute' && style.position !== 'sticky') return;
						const r = el.getBoundingClientRect();
						if (r.width < vw * 0.5 || r.height < 40 || r.height > vh * 0.7) return;
						const edgeBar = r.top <= vh * 0.25 || r.bottom >= vh * 0.75;
						if (!edgeBar) return;
						const attrBlob = `${el.id || ''} ${el.className || ''} ${(el.getAttribute('aria-label') || '')}`.toLowerCase();
						const text = /** @type {HTMLElement} */ (el).innerText || '';
						if (CONSENT_KEYWORDS.test(attrBlob) || CONSENT_KEYWORDS.test(text)) {
					/** @type {HTMLElement} */ (el).style.display = 'none';
						}
					});
					document.body.style.overflow = '';
					document.documentElement.style.overflow = '';
				});

				// Third pass for very late CMP injection (1.5s after initial load).
				await new Promise(r => setTimeout(r, 1500));
				await page.evaluate(() => {
					const CONSENT_KEYWORDS = /cookie|consent|gdpr|privacy|datenschutz|onetrust|cookiebot|didomi|trustarc|cmp|sourcepoint|sp_message/i;
					const vw = window.innerWidth;
					const vh = window.innerHeight;

					// Click accept buttons again in case the CMP appeared late.
					const lateButtons = Array.from(document.querySelectorAll('button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]'));
					for (const btn of lateButtons) {
						const txt = ((btn.textContent || '').trim().toLowerCase());
						if (/accept|agree|allow|akzept|zustimm|acept|accepter|accetta|aceitar/.test(txt)) {
					/** @type {HTMLElement} */ (btn).click();
						}
					}

					document.querySelectorAll('*').forEach(el => {
						const style = window.getComputedStyle(el);
						if (style.position !== 'fixed' && style.position !== 'absolute' && style.position !== 'sticky') return;
						const r = el.getBoundingClientRect();
						if (r.width < vw * 0.35 || r.height < 24 || r.height > vh * 0.9) return;
						const edgeBar = r.top <= vh * 0.3 || r.bottom >= vh * 0.7;
						const txt = /** @type {HTMLElement} */ (el).innerText || '';
						const attrs = `${el.id || ''} ${el.className || ''} ${(el.getAttribute('aria-label') || '')} ${(el.getAttribute('data-testid') || '')}`.toLowerCase();
						if (edgeBar && (CONSENT_KEYWORDS.test(txt) || CONSENT_KEYWORDS.test(attrs))) {
					/** @type {HTMLElement} */ (el).style.display = 'none';
						}
					});

					document.querySelectorAll('iframe').forEach(frame => {
						const blob = `${frame.getAttribute('src') || ''} ${frame.getAttribute('title') || ''} ${frame.getAttribute('name') || ''}`.toLowerCase();
						if (CONSENT_KEYWORDS.test(blob)) {
					/** @type {HTMLElement} */ (frame).style.display = 'none';
						}
					});

					document.body.style.overflow = '';
					document.documentElement.style.overflow = '';
				});

				// Small pause so any close animations complete before screenshot
				await new Promise(r => setTimeout(r, 3000));
				_perf('cookies dismissed, taking screenshot');
				send({ type: 'step', step: 1 });
				const screenshotBuf = await withStepTimeout(
					captureViewportScreenshot(page, VP_W, VP_H, _perf),
					'screenshot capture'
				);
				const screenshotB64 = Buffer.from(screenshotBuf).toString('base64');
				const screenshotDataUrl = `data:image/png;base64,${screenshotB64}`;
				_perf('screenshot captured');

				// -- Extract and analyze CSS, HTML, and JavaScript ----------------------
				send({ type: 'step', step: 2 });
				const cssAnalysis = await withStepTimeout(extractAndAnalyzeCSS(page), 'CSS analysis');
				const htmlAnalysis = await withStepTimeout(extractAndAnalyzeHTML(page), 'HTML analysis');
				const jsAnalysis = await withStepTimeout(extractAndAnalyzeJS(page), 'JavaScript analysis');
				cssAnalysis.findings = cssAnalysis.findings.map((f, i) => ({ id: `CSS${String(i + 1).padStart(3, '0')}`, ...f }));
				htmlAnalysis.findings = htmlAnalysis.findings.map((f, i) => ({ id: `HTML${String(i + 1).padStart(3, '0')}`, ...f }));
				jsAnalysis.findings = jsAnalysis.findings.map((f, i) => ({ id: `JS${String(i + 1).padStart(3, '0')}`, ...f }));
				_perf('css/html/js extracted');

				if (mode === 'algo') {
					send({ type: 'step', step: 3 });
					const { elements, vpW, vpH } = await withStepTimeout(page.evaluate(() => {
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
							while (cur) {
								const bg = window.getComputedStyle(cur).backgroundColor;
								const parsed = parseColor(bg);
								if (parsed[3] > 0.05) return parsed;
								if (cur === document.documentElement) break;
								cur = /** @type {Element} */ (cur.parentElement);
							}
							return [255, 255, 255, 1];
						}

						const all = Array.from(document.querySelectorAll('*'));
						const vW = window.innerWidth;
						const vH = window.innerHeight;
						const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
						const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
						const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, span, a, li, label, button, td, th, caption';
						function getRepresentativeTextSource(el) {
							const ownText = ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
							const descendants = Array.from(el.querySelectorAll(TEXT_SELECTOR));
							for (const child of descendants) {
								if (child === el) continue;
								const childRect = child.getBoundingClientRect();
								if (childRect.width < 2 || childRect.height < 2) continue;
								if (childRect.bottom < 0 || childRect.top > vH || childRect.right < 0 || childRect.left > vW) continue;
								const childStyle = window.getComputedStyle(child);
								if (childStyle.display === 'none' || childStyle.visibility === 'hidden' || childStyle.visibility === 'collapse') continue;
								if ((parseFloat(childStyle.opacity) || 0) <= 0) continue;
								const childText = ((child instanceof HTMLElement ? child.innerText : child.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
								if (!childText) continue;
								return { node: child, text: childText };
							}
							return ownText ? { node: el, text: ownText } : null;
						}
						/** @type {any[]} */
						const results = [];
						for (const el of all) {
							const r = el.getBoundingClientRect();
							if (r.width < 2 || r.height < 2) continue;
							if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
							const cs = window.getComputedStyle(el);
							// Ignore elements users cannot see or interact with. This prevents
							// hidden nav mega-menu items from inflating touch-target counts.
							if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
							if ((parseFloat(cs.opacity) || 0) <= 0) continue;
							if (cs.pointerEvents === 'none') continue;
							const tag = el.tagName.toLowerCase();
							const isTextTag = TEXT_TAGS.has(tag);
							const isInteractiveTag = INTERACTIVE_TAGS.has(tag);
							const textSource = (isTextTag || isInteractiveTag) ? getRepresentativeTextSource(el) : null;
							const usesChildTextSource = !!textSource && textSource.node !== el;
							const textStyle = textSource ? window.getComputedStyle(textSource.node) : cs;
							results.push({
								tag,
								rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
								color: parseColor(textStyle.color),
								bg: getEffectiveBg(el),
								fontSize: parseFloat(textStyle.fontSize) || 14,
								fontWeight: parseInt(textStyle.fontWeight) || 400,
								lineHeight: parseFloat(textStyle.lineHeight) || 0,
								fontFamily: (textStyle.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
								textAlign: textStyle.textAlign || 'left',
								textDecoration: (textStyle.textDecorationLine && textStyle.textDecorationLine !== 'none')
									? textStyle.textDecorationLine
									: ((textStyle.textDecoration || '').includes('underline') ? 'underline' : 'none'),
								letterSpacing: parseFloat(textStyle.letterSpacing) || 0,
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
								textTransform: textStyle.textTransform || 'none',
								hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url('),
								opacity: parseFloat(cs.opacity) || 1,
								isText: isTextTag && !!textSource?.text && !usesChildTextSource,
								isInteractive: isInteractiveTag,
								textContent: (isTextTag || isInteractiveTag)
									? (textSource?.text || '')
									: '',
								alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
								fill: (() => { const f = cs.fill; return (f && f !== 'none' && f !== '') ? parseColor(f) : null; })(),
							});
						}
						return { elements: results, vpW: vW, vpH: vH };
					}), 'viewport extraction');

					const analysis = analyseAlgorithmically(elements, vpW, vpH);
					send({ type: 'step', step: 7 });
					_perf('building heatmap (algo mode)...');
					const heatmap = await buildHeatmap(apiKey, screenshotB64, elements, vpW, vpH);
					_perf('heatmap ready (algo mode)');
					_perf('algorithmic analysis done (algo mode)');

					send({ type: 'step', step: 8 });
					send({
						type: 'done', result: {
							screenshot: screenshotDataUrl,
							heatmap,
							...analysis,
							findings: analysis.findings,
							strengths: analysis.strengths,
						}
					});
				} else if (mode === 'algo-ai') {
					// algo-ai: run rule-based analysis, then ask AI to rewrite findings in plain language
					send({ type: 'step', step: 3 });
					const { elements, vpW, vpH } = await withStepTimeout(page.evaluate(() => {
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
							while (cur) {
								const bg = window.getComputedStyle(cur).backgroundColor;
								const parsed = parseColor(bg);
								if (parsed[3] > 0.05) return parsed;
								if (cur === document.documentElement) break;
								cur = /** @type {Element} */ (cur.parentElement);
							}
							return [255, 255, 255, 1];
						}

						const all = Array.from(document.querySelectorAll('*'));
						const vW = window.innerWidth;
						const vH = window.innerHeight;
						const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
						const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
						const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, span, a, li, label, button, td, th, caption';
						function getRepresentativeTextSource(el) {
							const ownText = ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
							const descendants = Array.from(el.querySelectorAll(TEXT_SELECTOR));
							for (const child of descendants) {
								if (child === el) continue;
								const childRect = child.getBoundingClientRect();
								if (childRect.width < 2 || childRect.height < 2) continue;
								if (childRect.bottom < 0 || childRect.top > vH || childRect.right < 0 || childRect.left > vW) continue;
								const childStyle = window.getComputedStyle(child);
								if (childStyle.display === 'none' || childStyle.visibility === 'hidden' || childStyle.visibility === 'collapse') continue;
								if ((parseFloat(childStyle.opacity) || 0) <= 0) continue;
								const childText = ((child instanceof HTMLElement ? child.innerText : child.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
								if (!childText) continue;
								return { node: child, text: childText };
							}
							return ownText ? { node: el, text: ownText } : null;
						}
						/** @type {any[]} */
						const results = [];
						for (const el of all) {
							const r = el.getBoundingClientRect();
							if (r.width < 2 || r.height < 2) continue;
							if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
							const cs = window.getComputedStyle(el);
							// Ignore elements users cannot see or interact with. This prevents
							// hidden nav mega-menu items from inflating touch-target counts.
							if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
							if ((parseFloat(cs.opacity) || 0) <= 0) continue;
							if (cs.pointerEvents === 'none') continue;
							const tag = el.tagName.toLowerCase();
							const isTextTag = TEXT_TAGS.has(tag);
							const isInteractiveTag = INTERACTIVE_TAGS.has(tag);
							const textSource = (isTextTag || isInteractiveTag) ? getRepresentativeTextSource(el) : null;
							const usesChildTextSource = !!textSource && textSource.node !== el;
							const textStyle = textSource ? window.getComputedStyle(textSource.node) : cs;
							results.push({
								tag,
								rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
								color: parseColor(textStyle.color),
								bg: getEffectiveBg(el),
								fontSize: parseFloat(textStyle.fontSize) || 14,
								fontWeight: parseInt(textStyle.fontWeight) || 400,
								lineHeight: parseFloat(textStyle.lineHeight) || 0,
								fontFamily: (textStyle.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
								textAlign: textStyle.textAlign || 'left',
								textDecoration: (textStyle.textDecorationLine && textStyle.textDecorationLine !== 'none')
									? textStyle.textDecorationLine
									: ((textStyle.textDecoration || '').includes('underline') ? 'underline' : 'none'),
								letterSpacing: parseFloat(textStyle.letterSpacing) || 0,
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
								textTransform: textStyle.textTransform || 'none',
								hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url('),
								opacity: parseFloat(cs.opacity) || 1,
								isText: isTextTag && !!textSource?.text && !usesChildTextSource,
								isInteractive: isInteractiveTag,
								textContent: (isTextTag || isInteractiveTag)
									? (textSource?.text || '')
									: '',
								alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
								fill: (() => { const f = cs.fill; return (f && f !== 'none' && f !== '') ? parseColor(f) : null; })(),
							});
						}
						return { elements: results, vpW: vW, vpH: vH };
					}), 'viewport extraction');

					const algoAnalysis = analyseAlgorithmically(elements, vpW, vpH);
					send({ type: 'step', step: 4 });
					_perf('building heatmap (algo-ai mode)...');
					const heatmap = await buildHeatmap(apiKey, screenshotB64, elements, vpW, vpH);
					_perf('heatmap ready (algo-ai mode)');
					_perf('algorithmic analysis done (algo-ai mode)');
					send({ type: 'step', step: 5 });
					const baseFindings = filterFindingsToActiveScope([
						...algoAnalysis.findings,
					]);
					let aiRewrite = null;
					try {
						// Screenshot-only mode: rewrite only viewport-derived algorithmic findings.
						const codeContext = {
							css: cssAnalysis.cssData,
							html: htmlAnalysis.htmlData,
							js: jsAnalysis.jsData,
						};
						_perf('calling Gemini (algo-ai rewrite)...');
						aiRewrite = await withOptionalStepTimeout(
							callGeminiWithFindings(apiKey, baseFindings, algoAnalysis.overallScore, codeContext, screenshotB64),
							'AI summary',
							async (timeoutErr) => {
								console.warn('[Percepta] AI summary unavailable, falling back to algorithmic results:', timeoutErr.message);
								return null;
							}
						);
						_perf('Gemini algo-ai rewrite done');
					} catch (aiErr) {
						console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
					}

					send({ type: 'step', step: 6 });
					const allStrengths = [
						...(aiRewrite?.strengths ?? algoAnalysis.strengths),
					];
					const hasAiFindings = Array.isArray(aiRewrite?.findings) && aiRewrite.findings.length > 0;
					let rescuedHighSeverity = [];
					const displayedFindings = hasAiFindings
						? (() => {
							const aiFindings = filterFindingsToActiveScope(aiRewrite.findings);
							const aiIds = new Set(aiFindings.map(f => f.id));
							rescuedHighSeverity = baseFindings.filter(f =>
								!aiIds.has(f.id) && (f.severity === 'critical' || f.severity === 'warning')
							);
							return filterFindingsToActiveScope([
								...aiFindings,
								...rescuedHighSeverity,
							]);
						})()
						: baseFindings;
					const displayedScore = computeOverallScoreFromFindings(displayedFindings);

					const noImages = hasAiFindings &&
						aiRewrite.findings.every(f => (f.bookImages ?? []).length === 0);
					const displayedSummary = hasAiFindings
						? (aiRewrite?.summary ?? algoAnalysis.summary)
						: algoAnalysis.summary;
					send({ type: 'step', step: 7 });

					send({
						type: 'done', result: {
							screenshot: screenshotDataUrl,
							heatmap,
							overallScore: displayedScore,
							summary: displayedSummary,
							findings: displayedFindings,
							strengths: allStrengths,
							expertNote: algoAnalysis.expertNote,
							aiUnavailable: aiRewrite === null,
							aiGateReport: aiRewrite?.gateReport ?? null,
							rescuedHighSeverityCount: rescuedHighSeverity.length,
							aiFellBackToAlgorithmic: !hasAiFindings && aiRewrite !== null,
							noImages,
						}
					});
				} else if (mode === 'compare-algo-ai') {
					// compare-algo-ai: run algo, then ask AI to rewrite � return both for prose diff view
					send({ type: 'step', step: 3 });
					const { elements, vpW, vpH } = await withStepTimeout(page.evaluate(() => {
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
							while (cur) {
								const bg = window.getComputedStyle(cur).backgroundColor;
								const parsed = parseColor(bg);
								if (parsed[3] > 0.05) return parsed;
								if (cur === document.documentElement) break;
								cur = /** @type {Element} */ (cur.parentElement);
							}
							return [255, 255, 255, 1];
						}
						const all = Array.from(document.querySelectorAll('*'));
						const vW = window.innerWidth;
						const vH = window.innerHeight;
						const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
						const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
						const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, span, a, li, label, button, td, th, caption';
						function getRepresentativeTextSource(el) {
							const ownText = ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
							const descendants = Array.from(el.querySelectorAll(TEXT_SELECTOR));
							for (const child of descendants) {
								if (child === el) continue;
								const childRect = child.getBoundingClientRect();
								if (childRect.width < 2 || childRect.height < 2) continue;
								if (childRect.bottom < 0 || childRect.top > vH || childRect.right < 0 || childRect.left > vW) continue;
								const childStyle = window.getComputedStyle(child);
								if (childStyle.display === 'none' || childStyle.visibility === 'hidden' || childStyle.visibility === 'collapse') continue;
								if ((parseFloat(childStyle.opacity) || 0) <= 0) continue;
								const childText = ((child instanceof HTMLElement ? child.innerText : child.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
								if (!childText) continue;
								return { node: child, text: childText };
							}
							return ownText ? { node: el, text: ownText } : null;
						}
						/** @type {any[]} */
						const results = [];
						for (const el of all) {
							const r = el.getBoundingClientRect();
							if (r.width < 2 || r.height < 2) continue;
							if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
							const cs = window.getComputedStyle(el);
							// Ignore elements users cannot see or interact with. This prevents
							// hidden nav mega-menu items from inflating touch-target counts.
							if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
							if ((parseFloat(cs.opacity) || 0) <= 0) continue;
							if (cs.pointerEvents === 'none') continue;
							const tag = el.tagName.toLowerCase();
							const isTextTag = TEXT_TAGS.has(tag);
							const isInteractiveTag = INTERACTIVE_TAGS.has(tag);
							const textSource = (isTextTag || isInteractiveTag) ? getRepresentativeTextSource(el) : null;
							const usesChildTextSource = !!textSource && textSource.node !== el;
							const textStyle = textSource ? window.getComputedStyle(textSource.node) : cs;
							results.push({
								tag,
								rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
								color: parseColor(textStyle.color),
								bg: getEffectiveBg(el),
								fontSize: parseFloat(textStyle.fontSize) || 14,
								fontWeight: parseInt(textStyle.fontWeight) || 400,
								lineHeight: parseFloat(textStyle.lineHeight) || 0,
								fontFamily: (textStyle.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
								textAlign: textStyle.textAlign || 'left',
								textDecoration: (textStyle.textDecorationLine && textStyle.textDecorationLine !== 'none')
									? textStyle.textDecorationLine
									: ((textStyle.textDecoration || '').includes('underline') ? 'underline' : 'none'),
								letterSpacing: parseFloat(textStyle.letterSpacing) || 0,
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
								textTransform: textStyle.textTransform || 'none',
								hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url('),
								opacity: parseFloat(cs.opacity) || 1,
								isText: isTextTag && !!textSource?.text && !usesChildTextSource,
								isInteractive: isInteractiveTag,
								textContent: (isTextTag || isInteractiveTag)
									? (textSource?.text || '')
									: '',
								alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
								fill: (() => { const f = cs.fill; return (f && f !== 'none' && f !== '') ? parseColor(f) : null; })(),
							});
						}
						return { elements: results, vpW: vW, vpH: vH };
					}), 'viewport extraction');

					const algoResult = analyseAlgorithmically(elements, vpW, vpH);
					send({ type: 'step', step: 4 });
					_perf('building heatmap (compare-algo-ai mode)...');
					const heatmap = await buildHeatmap(apiKey, screenshotB64, elements, vpW, vpH);
					_perf('heatmap ready (compare-algo-ai mode)');
					_perf('algorithmic analysis done (compare-algo-ai mode)');
					send({ type: 'step', step: 5 });
					let aiRewrite = null;
					try {
						// Screenshot-only mode: rewrite only viewport-derived algorithmic findings.
						const mergedFindings = filterFindingsToActiveScope([
							...algoResult.findings,
						]);
						const codeContext = {
							css: cssAnalysis.cssData,
							html: htmlAnalysis.htmlData,
							js: jsAnalysis.jsData,
						};
						_perf('calling Gemini (compare-algo-ai rewrite)...');
						aiRewrite = await withOptionalStepTimeout(
							callGeminiWithFindings(apiKey, mergedFindings, algoResult.overallScore, codeContext, screenshotB64),
							'AI summary',
							async (timeoutErr) => {
								console.warn('[Percepta] AI summary unavailable, falling back to algorithmic results:', timeoutErr.message);
								return null;
							}
						);
						_perf('Gemini compare-algo-ai rewrite done');
					} catch (aiErr) {
						console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
					}

					send({ type: 'step', step: 7 });
					// Screenshot-only mode: keep only viewport-derived algorithmic findings.
					const algoWithExtensions = {
						...algoResult,
						findings: filterFindingsToActiveScope([
							...algoResult.findings,
						]),
						strengths: [
							...algoResult.strengths,
						],
					};

					const noImages = aiRewrite !== null &&
						aiRewrite.findings.every(f => (f.bookImages ?? []).length === 0);
					send({ type: 'step', step: 8 });

					send({
						type: 'done', result: {
							mode: 'compare-algo-ai',
							screenshot: screenshotDataUrl,
							heatmap,
							overallScore: algoResult.overallScore,
							algo: algoWithExtensions,
							algoAi: {
								summary: aiRewrite?.summary ?? algoResult.summary,
								findings: aiRewrite?.findings ? filterFindingsToActiveScope(aiRewrite.findings) : algoWithExtensions.findings,
								strengths: aiRewrite?.strengths ?? algoWithExtensions.strengths,
							},
							aiUnavailable: aiRewrite === null,
							noImages,
						}
					});
				} else if (mode === 'ai') {
					// AI mode - pass code context for better analysis
					send({ type: 'step', step: 3 });
					const codeContext = {
						css: cssAnalysis.cssData,
						html: htmlAnalysis.htmlData,
						js: jsAnalysis.jsData,
					};
					_perf('calling Gemini (ai mode)...');
					const result = await withStepTimeout(callGemini(apiKey, screenshotB64, codeContext), 'AI analysis');
					_perf('Gemini ai mode done');
					send({
						type: 'done', result: {
							screenshot: screenshotDataUrl,
							...result,
							findings: filterFindingsToActiveScope([
								...(result.findings || []),
							]),
							strengths: [
								...(result.strengths || []),
							],
						}
					});
				} else {
					// compare mode � run both algo and AI, return side-by-side with CSS/HTML/JS analysis
					send({ type: 'step', step: 3 });
					const { elements, vpW, vpH } = await withStepTimeout(page.evaluate(() => {
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
							while (cur) {
								const bg = window.getComputedStyle(cur).backgroundColor;
								const parsed = parseColor(bg);
								if (parsed[3] > 0.05) return parsed;
								if (cur === document.documentElement) break;
								cur = /** @type {Element} */ (cur.parentElement);
							}
							return [255, 255, 255, 1];
						}

						const all = Array.from(document.querySelectorAll('*'));
						const vW = window.innerWidth;
						const vH = window.innerHeight;
						const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'a', 'li', 'label', 'button', 'td', 'th', 'caption']);
						const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
						const TEXT_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, span, a, li, label, button, td, th, caption';
						function getRepresentativeTextSource(el) {
							const ownText = ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
							const descendants = Array.from(el.querySelectorAll(TEXT_SELECTOR));
							for (const child of descendants) {
								if (child === el) continue;
								const childRect = child.getBoundingClientRect();
								if (childRect.width < 2 || childRect.height < 2) continue;
								if (childRect.bottom < 0 || childRect.top > vH || childRect.right < 0 || childRect.left > vW) continue;
								const childStyle = window.getComputedStyle(child);
								if (childStyle.display === 'none' || childStyle.visibility === 'hidden' || childStyle.visibility === 'collapse') continue;
								if ((parseFloat(childStyle.opacity) || 0) <= 0) continue;
								const childText = ((child instanceof HTMLElement ? child.innerText : child.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 300);
								if (!childText) continue;
								return { node: child, text: childText };
							}
							return ownText ? { node: el, text: ownText } : null;
						}
						/** @type {any[]} */
						const results = [];
						for (const el of all) {
							const r = el.getBoundingClientRect();
							if (r.width < 2 || r.height < 2) continue;
							if (r.bottom < 0 || r.top > vH || r.right < 0 || r.left > vW) continue;
							const cs = window.getComputedStyle(el);
							// Ignore elements users cannot see or interact with. This prevents
							// hidden nav mega-menu items from inflating touch-target counts.
							if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
							if ((parseFloat(cs.opacity) || 0) <= 0) continue;
							if (cs.pointerEvents === 'none') continue;
							const tag = el.tagName.toLowerCase();
							const isTextTag = TEXT_TAGS.has(tag);
							const isInteractiveTag = INTERACTIVE_TAGS.has(tag);
							const textSource = (isTextTag || isInteractiveTag) ? getRepresentativeTextSource(el) : null;
							const usesChildTextSource = !!textSource && textSource.node !== el;
							const textStyle = textSource ? window.getComputedStyle(textSource.node) : cs;
							results.push({
								tag,
								rect: { x: Math.round(Math.max(r.left, 0)), y: Math.round(Math.max(r.top, 0)), w: Math.round(Math.min(r.right, vW) - Math.max(r.left, 0)), h: Math.round(Math.min(r.bottom, vH) - Math.max(r.top, 0)) },
								color: parseColor(textStyle.color),
								bg: getEffectiveBg(el),
								fontSize: parseFloat(textStyle.fontSize) || 14,
								fontWeight: parseInt(textStyle.fontWeight) || 400,
								lineHeight: parseFloat(textStyle.lineHeight) || 0,
								fontFamily: (textStyle.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim().toLowerCase(),
								textAlign: textStyle.textAlign || 'left',
								textDecoration: (textStyle.textDecorationLine && textStyle.textDecorationLine !== 'none')
									? textStyle.textDecorationLine
									: ((textStyle.textDecoration || '').includes('underline') ? 'underline' : 'none'),
								letterSpacing: parseFloat(textStyle.letterSpacing) || 0,
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
								textTransform: textStyle.textTransform || 'none',
								hasBackgroundImage: !!cs.backgroundImage && cs.backgroundImage !== 'none' && cs.backgroundImage.includes('url('),
								opacity: parseFloat(cs.opacity) || 1,
								isText: isTextTag && !!textSource?.text && !usesChildTextSource,
								isInteractive: isInteractiveTag,
								textContent: (isTextTag || isInteractiveTag)
									? (textSource?.text || '')
									: '',
								alt: tag === 'img' ? (el.getAttribute('alt') || '').trim() : '',
								fill: (() => { const f = cs.fill; return (f && f !== 'none' && f !== '') ? parseColor(f) : null; })(),
							});
						}
						return { elements: results, vpW: vW, vpH: vH };
					}), 'viewport extraction');

					const algoResult = analyseAlgorithmically(elements, vpW, vpH);
					_perf('algorithmic analysis done (compare mode)');
					send({ type: 'step', step: 4 });
					const codeContext = {
						css: cssAnalysis.cssData,
						html: htmlAnalysis.htmlData,
						js: jsAnalysis.jsData,
					};
					_perf('calling Gemini (compare AI analysis)...');
					const aiResult = await withOptionalStepTimeout(
						callGemini(apiKey, screenshotB64, codeContext),
						'AI analysis',
						async (timeoutErr) => {
							console.warn('[Percepta] Compare AI analysis unavailable, returning algorithmic result only:', timeoutErr.message);
							return null;
						}
					);
					_perf('Gemini compare AI analysis done');
					send({ type: 'step', step: 6 });

					// Screenshot-only mode: keep findings scoped to the analysed viewport.
					const algoWithExtensions = {
						...algoResult,
						findings: filterFindingsToActiveScope([
							...algoResult.findings,
						]),
						strengths: [
							...algoResult.strengths,
						],
					};

					const aiWithExtensions = aiResult ? {
						...aiResult,
						findings: filterFindingsToActiveScope([
							...(aiResult.findings || []),
						]),
						strengths: [
							...(aiResult.strengths || []),
						],
					} : {
						summary: 'AI analysis is currently unavailable. Please try again.',
						findings: [],
						strengths: [],
					};

					send({
						type: 'done', result: {
							mode: 'compare',
							screenshot: screenshotDataUrl,
							algo: algoWithExtensions,
							aiUnavailable: aiResult === null,
							ai: aiWithExtensions,
						}
					});
				}
			} finally {
				await context.close();
			}
		} catch (err) {
			try { send({ type: 'error', message: err?.message ?? 'Analysis failed' }); } catch { }
		} finally {
			try { sse.close(); } catch { }
		}
	})();
	return new Response(stream, {
		headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
	});
}
