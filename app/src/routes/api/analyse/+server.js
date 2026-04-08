import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { SYSTEM_PROMPT } from '$lib/ai/prompt.js';
import puppeteer from 'puppeteer';
import { analyseAlgorithmically } from '$lib/analysis/algorithmic.js';

const VP_W = 1440;
const VP_H = 900;

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
	if (!mode || (mode !== 'algo' && mode !== 'ai')) {
		throw error(400, 'mode must be "algo" or "ai"');
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
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
						color: parseColor(cs.color),
						bg: getEffectiveBg(el),
						fontSize: parseFloat(cs.fontSize) || 14,
						fontWeight: parseInt(cs.fontWeight) || 400,
						isText: TEXT_TAGS.has(tag),
						isInteractive: INTERACTIVE_TAGS.has(tag),
					});
				}
				return { elements: results, vpW: vW, vpH: vH };
			});

			const analysis = analyseAlgorithmically(elements, vpW, vpH);
			return json({ screenshot: screenshotDataUrl, ...analysis });
		} else {
			// AI mode
			const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
			const response = await fetch(geminiUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
					contents: [{
						parts: [
							{ inline_data: { mime_type: 'image/png', data: screenshotB64 } },
							{ text: 'Analyse this UI screenshot for optical balance. Return JSON.' }
						]
					}],
					generationConfig: { maxOutputTokens: 8192, responseMimeType: 'application/json' }
				})
			});

			if (!response.ok) {
				const err = await response.json().catch(() => ({}));
				throw error(response.status, err.error?.message ?? 'Gemini API request failed');
			}

			const data = await response.json();
			const text = data.candidates?.[0]?.content?.parts?.map((/** @type {{ text?: string }} */ p) => p.text ?? '').join('') ?? '';
			console.log('[Percepta] raw Gemini text:', text.slice(0, 300));

			const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
			const result = JSON.parse(cleaned);
			return json({ screenshot: screenshotDataUrl, ...result });
		}
	} finally {
		await browser?.close();
	}
}
