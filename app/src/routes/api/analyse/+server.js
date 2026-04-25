import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SYSTEM_PROMPT, ALGO_AI_PROMPT } from '$lib/ai/prompt.js';
import { BOOK_KNOWLEDGE } from '$lib/ai/bookKnowledge.js';
import { BOOK_IMAGE_MAP, BOOK_IMAGES } from '$lib/ai/bookImages.js';
import puppeteer from 'puppeteer';
import { analyseAlgorithmically } from '$lib/analysis/algorithmic.js';

const VP_W = 1440;
const VP_H = 900;

async function callGemini(apiKey, screenshotB64) {
	const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
	const body = JSON.stringify({
		system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
		contents: [{
			parts: [
				{ inline_data: { mime_type: 'image/png', data: screenshotB64 } },
				{ text: 'Analyse this UI screenshot for optical balance. Return JSON.' }
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

async function callGeminiWithFindings(apiKey, findings, overallScore) {
	const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

	const categoriesPresent = [...new Set(findings.map(f => f.category))];
	const bookKnowledgeContext = Object.fromEntries(
		categoriesPresent
			.filter(cat => BOOK_KNOWLEDGE[cat])
			.map(cat => [cat, BOOK_KNOWLEDGE[cat].excerpt])
	);

	const systemInstruction = `${ALGO_AI_PROMPT}

---
IMAGE SELECTION — each finding object contains an "availableImages" array pre-filtered to that finding's category. Each entry has:
  src      — exact filename to use in bookImages
  desc     — selection condition AND description of what the image shows. READ THIS CAREFULLY.
  pair     — (optional) natural companion image for a ❌/✅ before/after set

For each finding, read the finding description, then read its availableImages list. Pick the image(s) whose desc condition is satisfied by this finding. Pick 0–2 images. Return [] when no image's condition is met.

RULES:
- Only use filenames that appear in the finding's own availableImages list.
- The desc field contains the CONDITION for showing the image. You MUST check the condition before selecting the image.
  - If desc says "show this ONLY if X" or "show this only if X" — you may ONLY select it when condition X is true for this finding. If X is not true, do NOT select it, even if the image seems related.
  - If desc says "shown only with imageXX" or "shown only if imageXX is shown" — only include it as a pair partner, never select it independently.
  - If desc has no explicit condition, select it when it closely matches the finding.
- PAIRING: when you select an image that has a "pair" field, you MUST also include the pair partner. They are a ❌/✅ set and must always appear together.
- If no image's condition is satisfied by the finding, return [].

For each selected image, return an object with:
  src     — the exact filename
  caption — a 1-2 sentence direct statement about what this image demonstrates in context of this finding. Start with the action or observation directly (e.g. "A small high-contrast button can counterbalance a much larger photo in a split layout."). Do NOT start with "This image shows", "This shows", or any meta-phrase. Do NOT copy the desc verbatim.`;

	const findingsWithImages = findings.map(f => ({
		...f,
		availableImages: BOOK_IMAGES
			.filter(img => img.tags.includes(f.category))
			.map(({ src, desc, pair }) => {
				/** @type {{ src: string, desc: string, pair?: string }} */
				const entry = { src, desc };
				if (pair) entry.pair = pair;
				return entry;
			})
	}));

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
					return { ...f, bookImages: deduped };
				});
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

	let browser;
	try {
		browser = await puppeteer.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
		});
		const page = await browser.newPage();
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
			return json({ screenshot: screenshotDataUrl, ...analysis });
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
				aiRewrite = await callGeminiWithFindings(apiKey, algoAnalysis.findings, algoAnalysis.overallScore);
			} catch (aiErr) {
				console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
			}

			return json({
				screenshot: screenshotDataUrl,
				overallScore: algoAnalysis.overallScore,
				summary: aiRewrite?.summary ?? algoAnalysis.summary,
				findings: aiRewrite?.findings ?? algoAnalysis.findings,
				strengths: aiRewrite?.strengths ?? algoAnalysis.strengths,
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
				aiRewrite = await callGeminiWithFindings(apiKey, algoResult.findings, algoResult.overallScore);
			} catch (aiErr) {
				console.warn('[Percepta] Gemini unavailable, falling back to algorithmic results:', aiErr.message);
			}

			return json({
				mode: 'compare-algo-ai',
				screenshot: screenshotDataUrl,
				overallScore: algoResult.overallScore,
				algo: algoResult,
				algoAi: {
					summary: aiRewrite?.summary ?? algoResult.summary,
					findings: aiRewrite?.findings ?? algoResult.findings,
					strengths: aiRewrite?.strengths ?? algoResult.strengths,
				},
			});
		} else if (mode === 'ai') {
			// AI mode
			const result = await callGemini(apiKey, screenshotB64);
			return json({ screenshot: screenshotDataUrl, ...result });
		} else {
			// compare mode — run both algo and AI, return side-by-side
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
			const aiResult = await callGemini(apiKey, screenshotB64);

			return json({ mode: 'compare', screenshot: screenshotDataUrl, algo: algoResult, ai: aiResult });
		}
	} finally {
		await browser?.close();
	}
}
