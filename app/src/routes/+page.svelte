<script>
	import { CATEGORY_META, CATEGORY_ORDER, SEV, LOADING_STEPS, ALGO_LOADING_STEPS, ALGO_AI_LOADING_STEPS, COMPARE_LOADING_STEPS } from '$lib/ui/constants.js';

	let image = $state(/** @type {string | null} */ (null));
	let url = $state('');
	let loading = $state(false);
	let step = $state(0);
	let result = $state(/** @type {any} */ (null));
	let errorMsg = $state(/** @type {string | null} */ (null));
	let filter = $state('all');
	let elapsed = $state(0);
	let elapsedInterval = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined);
	let activeIdx = $state(-1);
	/** @type {HTMLCanvasElement | null} */
	let canvasEl = $state(null);
	/** @type {HTMLImageElement | null} */
	let imgEl = $state(null);
	/** @type {Array<{i:number, x:number, y:number, w:number, h:number}>} */
	let badgeRects = [];
	let mode = $state(/** @type {'ai' | 'algo' | 'algo-ai' | 'compare' | 'compare-algo-ai'} */ ('algo-ai'));
	let resultMode = $state(/** @type {'ai' | 'algo' | 'algo-ai' | 'compare' | 'compare-algo-ai'} */ ('algo-ai'));
	let theme = $state(/** @type {'light' | 'dark'} */ ('dark'));
	let expandedFixes = $state(/** @type {Record<string, boolean>} */ ({}));
	let compareResult = $state(/** @type {any} */ (null));
	let compareAlgoAiResult = $state(/** @type {any} */ (null));
	let aiUnavailable = $state(false);
	let noImages = $state(false);

	// CI/CD info balloon
	let cicdOpen = $state(false);

	// Feedback panel
	let feedbackOpen = $state(false);
	let feedbackName = $state('');
	let feedbackRole = $state('');
	let feedbackComment = $state('');
	let feedbackStatus = $state(/** @type {'idle'|'sending'|'sent'|'error'} */ ('idle'));
	let feedbackError = $state('');
	/** @type {''|'yes'|'no'|'maybe'} */
	let feedbackPractical = $state('');
	/** @type {''|'yes'|'no'|'maybe'} */
	let feedbackWouldUse = $state('');
	/** @type {''|'yes'|'no'|'maybe'} */
	let feedbackHelpful = $state('');
	/** @type {''|'yes'|'no'|'maybe'} */
	let feedbackCicd = $state('');
	let feedbackTestedUrl = $state('');
	let feedbackMissedIssues = $state('');

	const RING_C = 2 * Math.PI * 36;

	let grouped = $derived(
		CATEGORY_ORDER.map(catName => {
			const allInCat = (result?.findings ?? [])
				.map((/** @type {any} */ f, i) => ({ ...f, _idx: i }))
				.filter((/** @type {any} */ f) => f.category === catName);
			const filtered = allInCat.filter(
				(/** @type {any} */ f) => filter === 'all' || f.severity === filter
			);
			return { catName, allInCat, filtered };
		})
	);

	let counts = $derived({
		all: result?.findings?.length ?? 0,
		critical:
			result?.findings?.filter((/** @type {{ severity: string }} */ f) => f.severity === 'critical')
				.length ?? 0,
		warning:
			result?.findings?.filter((/** @type {{ severity: string }} */ f) => f.severity === 'warning')
				.length ?? 0,
		info:
			result?.findings?.filter((/** @type {{ severity: string }} */ f) => f.severity === 'info')
				.length ?? 0
	});

	/** @param {{ color: string; darkColor?: string }} obj */
	function c(obj) { return theme === 'dark' ? (obj.darkColor ?? obj.color) : obj.color; }

	let scoreGrade = $derived(
		!result
			? null
			: result.overallScore >= 80
				? { label: 'Good', color: '#059669', darkColor: '#34d399' }
				: result.overallScore >= 55
					? { label: 'Fair', color: '#d97706', darkColor: '#fbbf24' }
					: { label: 'Needs Work', color: '#ef4444', darkColor: '#fca5a5' }
	);

	async function analyse() {
		if (!url.trim()) return;
		loading = true;
		errorMsg = null;
		result = null;
		compareResult = null;
		image = null;
		step = 0;
		elapsed = 0;
		activeIdx = -1;
		resultMode = mode;
		elapsedInterval = setInterval(() => { elapsed += 1; }, 1000);
		try {
			const res = await fetch('/api/analyse', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url: url.trim(), mode })
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ message: 'Request failed' }));
				throw new Error(err.message ?? 'Request failed');
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let gotResult = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';
				for (const part of parts) {
					if (!part.startsWith('data: ')) continue;
					const event = JSON.parse(part.slice(6));
					if (event.type === 'step') {
						step = event.step;
					} else if (event.type === 'done') {
						gotResult = true;
						const data = event.result;
						image = data.screenshot;
						aiUnavailable = !!data.aiUnavailable;
					noImages = !!data.noImages;
						if (data.mode === 'compare') {
							compareResult = data;
						} else if (data.mode === 'compare-algo-ai') {
							compareAlgoAiResult = data;
						} else {
							result = data;
						}
					} else if (event.type === 'error') {
						throw new Error(event.message);
					}
				}
			}
			if (!gotResult) throw new Error('Analysis ended unexpectedly — please try again.');
		} catch (e) {
			errorMsg = /** @type {Error} */ (e).message;
		} finally {
			clearInterval(elapsedInterval);
			loading = false;
		}
	}

	function reset() {
		url = '';
		image = null;
		result = null;
		compareResult = null;
		compareAlgoAiResult = null;
		errorMsg = null;
		filter = 'all';
		activeIdx = -1;
		expandedFixes = {};
		aiUnavailable = false;
		noImages = false;
	}

	function drawCanvas() {
		if (!canvasEl || !imgEl || !result) return;
		const doRender = () => {
			if (!canvasEl || !imgEl) return;
			const W = imgEl.naturalWidth;
			const H = imgEl.naturalHeight;
			if (!W || !H) return;
			const ctx = canvasEl.getContext('2d');
			if (!ctx) return;
			canvasEl.width = W;
			canvasEl.height = H;
			ctx.drawImage(imgEl, 0, 0);
			badgeRects = [];
		};
		if (imgEl.complete && imgEl.naturalWidth) {
			doRender();
		} else {
			imgEl.addEventListener('load', doRender, { once: true });
		}
	}

	/** @param {MouseEvent} e */
	function handleCanvasClick(e) {
		if (!canvasEl || !result) return;
		const rect = canvasEl.getBoundingClientRect();
		const scaleX = canvasEl.width / rect.width;
		const scaleY = canvasEl.height / rect.height;
		const cx = (e.clientX - rect.left) * scaleX;
		const cy = (e.clientY - rect.top) * scaleY;
		let hit = -1;
		for (let i = badgeRects.length - 1; i >= 0; i--) {
			const b = badgeRects[i];
			if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
				hit = b.i;
				break;
			}
		}
		activeIdx = hit === activeIdx ? -1 : hit;
	}

	$effect(() => {
		drawCanvas();
	});

	async function submitFeedback() {
		if (!feedbackComment.trim()) return;
		feedbackStatus = 'sending';
		feedbackError = '';
		try {
			const res = await fetch('/api/feedback', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: feedbackName.trim(), role: feedbackRole.trim(), comment: feedbackComment.trim(), q_practical: feedbackPractical || null, q_workflow: feedbackWouldUse || null, q_helpful: feedbackHelpful || null, q_cicd: feedbackCicd || null, tested_url: feedbackTestedUrl.trim() || null, missed_issues: feedbackMissedIssues.trim() || null }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: 'Request failed' }));
				throw new Error(err.error ?? 'Request failed');
			}
			feedbackStatus = 'sent';
		} catch (e) {
			feedbackError = /** @type {Error} */ (e).message;
			feedbackStatus = 'error';
		}
	}
</script>

<svelte:head>
	<title>Percepta — Optical UI Auditor</title>
</svelte:head>

<div
	data-theme={theme}
	style="min-height:100vh;background:var(--bg);background-image:{theme === 'dark' ? 'url(/percepta-background.svg)' : 'url(/percepta-background-light.svg)'};background-size:cover;background-position:center top;background-attachment:fixed;color:var(--text);font-family:'Plus Jakarta Sans','Inter',sans-serif;"
>
	<!-- Nav -->
	<nav class="app-nav">
		<div style="display:flex;align-items:center;gap:10px;">
			<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="10" stroke="#2563eb" stroke-width="1.5" />
				<circle cx="12" cy="12" r="3" fill="#2563eb" />
				<line
					x1="12"
					y1="2"
					x2="12"
					y2="6"
					stroke="#2563eb"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
				<line
					x1="12"
					y1="18"
					x2="12"
					y2="22"
					stroke="#2563eb"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
				<line
					x1="2"
					y1="12"
					x2="6"
					y2="12"
					stroke="#2563eb"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
				<line
					x1="18"
					y1="12"
					x2="22"
					y2="12"
					stroke="#2563eb"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			</svg>
			<span style="font-weight:700;font-size:16px;letter-spacing:-0.02em;">Percepta</span>
		</div>
		<div style="display:flex;align-items:center;gap:12px;">
			<!-- Theme toggle switch -->
			<button
				onclick={() => { theme = theme === 'dark' ? 'light' : 'dark'; }}
				title="Toggle theme"
				aria-label="Toggle dark/light mode"
				aria-checked={theme === 'light'}
				role="switch"
				style="border:none;cursor:pointer;padding:0;background:none;display:flex;align-items:center;gap:6px;"
			>
				<!-- Moon icon -->
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="{theme === 'dark' ? 'var(--text-3)' : 'var(--text-5)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:stroke 0.2s;flex-shrink:0;"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
				<!-- Track -->
				<div style="position:relative;width:36px;height:20px;border-radius:10px;background:{theme === 'dark' ? 'var(--border)' : '#2563eb'};transition:background 0.25s;flex-shrink:0;">
					<!-- Thumb -->
					<div style="position:absolute;top:3px;left:{theme === 'dark' ? '3px' : '19px'};width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.35);transition:left 0.25s;"></div>
				</div>
				<!-- Sun icon -->
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="{theme === 'light' ? 'var(--text-3)' : 'var(--text-5)'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:stroke 0.2s;flex-shrink:0;"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
			</button>
			<span style="font-size:12px;color:var(--text-4);">Login</span>
			<span style="font-size:12px;color:var(--text-4);">Register</span>
		</div>
	</nav>

	<main style="max-width:{result || compareResult || compareAlgoAiResult ? '1400px' : '800px'};margin:0 auto;padding:48px 24px;transition:max-width 0.3s ease;">
		{#if !result && !compareResult && !compareAlgoAiResult}
			<!-- Hero -->
			<div style="text-align:center;margin-bottom:48px;">
				<p
					style="font-size:12px;font-weight:600;color:#2563eb;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;"
				>
					Perceptual UI Analysis
				</p>
				<h1
					style="font-size:36px;font-weight:700;letter-spacing:-0.03em;line-height:1.15;color:var(--text);margin-bottom:14px;"
				>
					See what your users feel,<br />not just what they see.
				</h1>
				<p style="font-size:15px;color:var(--text-3);line-height:1.6;max-width:480px;margin:0 auto;">
					Paste a URL and Percepta audits your live UI for perceptual contrast, visual balance, colour
					harmony, and spacing rhythm — issues standard DOM tools can't detect.
				</p>
			</div>

			<!-- URL input -->
			<div style="margin-bottom:16px;">
				<!-- How it works strip -->
				<div style="display:flex;align-items:center;justify-content:center;gap:0;margin-bottom:28px;">
					{#each [
						{ icon: '🔗', step: '1', label: 'Paste a URL' },
						{ icon: '⚙️', step: '2', label: 'Run the audit' },
						{ icon: '📋', step: '3', label: 'Review findings' },
					] as item, i}
						<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;max-width:160px;">
							<div style="width:38px;height:38px;border-radius:50%;background:var(--surface);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;">{item.icon}</div>
							<span style="font-size:11px;font-weight:600;color:var(--text-3);text-align:center;line-height:1.4;">{item.label}</span>
						</div>
						{#if i < 2}
							<div style="flex:0 0 32px;height:1px;background:var(--border);margin-bottom:20px;"></div>
						{/if}
					{/each}
				</div>
				<div style="display:flex;gap:8px;align-items:stretch;">
					<input
						type="url"
						bind:value={url}
						placeholder="https://yourapp.com"
						disabled={loading}
						onkeydown={(e) => { if (e.key === 'Enter' && url.trim() && !loading) analyse(); }}
						style="flex:1;padding:12px 14px;border:1.5px solid var(--border);border-radius:12px;font-size:14px;font-family:inherit;color:var(--text);background:var(--surface-3);outline:none;transition:border-color 0.15s;"
					/>
					{#if url}
						<button
							onclick={reset}
							style="padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text-4);font-size:13px;cursor:pointer;"
							aria-label="Clear URL"
						>✕</button>
					{/if}
				</div>
			</div>

			<!-- Mode selector -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:12px;">
				<!-- Algorithmic (algo-ai) tab — primary -->
				<button
					onclick={() => (mode = 'algo-ai')}
					style="padding:10px 12px;border:none;background:{mode === 'algo-ai' ? 'var(--surface)' : 'var(--surface-2)'};text-align:left;transition:background 0.15s;cursor:pointer;"
				>
					<p style="font-size:12px;font-weight:600;color:{mode === 'algo-ai' ? 'var(--text)' : 'var(--text-3)'};margin-bottom:2px;">Algorithmic</p>
					<p style="font-size:10px;color:{mode === 'algo-ai' ? 'var(--text-3)' : 'var(--text-4)'}">Rule-based</p>
				</button>
				<!-- AI Vision tab — coming soon -->
				<button
					onclick={() => (mode = 'ai')}
					style="padding:10px 12px;border:none;background:{mode === 'ai' ? 'var(--surface)' : 'var(--surface-2)'};text-align:left;transition:background 0.15s;cursor:pointer;position:relative;"
				>
					<div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
						<p style="font-size:12px;font-weight:600;color:{mode === 'ai' ? 'var(--text-3)' : 'var(--text-4)'};margin:0;">AI Vision</p>
						<span style="font-size:9px;font-weight:700;letter-spacing:0.06em;background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:1px 5px;border-radius:4px;text-transform:uppercase;">Soon</span>
					</div>
					<p style="font-size:10px;color:var(--text-5);">Screenshot AI</p>
				</button>
			</div>

			{#if errorMsg}
				<div
					style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#dc2626;"
				>
					{errorMsg}
				</div>
			{/if}

			{#if mode === 'ai'}
				<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
					<p style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:3px;">AI mode is under construction</p>
					<p style="font-size:12px;color:#b45309;line-height:1.5;">Switch to <strong>Algorithmic</strong> mode to run a full perceptual audit.</p>
				</div>
			{/if}
			<button
				onclick={analyse}
				disabled={!url.trim() || loading || mode === 'ai'}
				style="width:100%;padding:13px;border-radius:12px;border:none;background:{url.trim() && !loading && mode !== 'ai'
					? mode === 'compare' || mode === 'algo-ai' || mode === 'compare-algo-ai' ? '#2563eb' : '#059669'
					: 'var(--surface-3)'};color:{url.trim() && !loading && mode !== 'ai'
					? '#fff'
					: 'var(--text-4)'};font-size:14px;font-weight:600;letter-spacing:-0.01em;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;"
			>
				{#if loading}
					<span
						style="width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:spin 0.8s linear infinite;"
					></span>
					Loading...
				{:else if mode === 'ai'}
					AI Vision — Coming Soon
				{:else if mode === 'compare'}
					Run Comparison
				{:else if mode === 'algo-ai'}
					Run Perceptual Audit
				{:else if mode === 'compare-algo-ai'}
					Run Algo Diff
				{:else}
					Run Raw Audit
				{/if}
			</button>

			{#if loading}
				{@const loadSteps = mode === 'compare' || mode === 'compare-algo-ai' ? COMPARE_LOADING_STEPS : mode === 'algo-ai' ? ALGO_AI_LOADING_STEPS : mode === 'ai' ? LOADING_STEPS : ALGO_LOADING_STEPS}
				{@const pct = Math.round((step / Math.max(loadSteps.length - 1, 1)) * 88) + 6}
				<div style="margin-top:14px;">
					<div style="height:3px;border-radius:2px;background:var(--border);overflow:hidden;">
						<div style="height:100%;width:{pct}%;background:#2563eb;border-radius:2px;transition:width 1.5s ease;"></div>
					</div>
					<p style="text-align:center;font-size:12px;color:var(--text-4);margin-top:8px;">{loadSteps[step]}</p>
					{#if elapsed > 40 && (mode === 'algo-ai' || mode === 'ai' || mode === 'compare' || mode === 'compare-algo-ai')}
						<div style="margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 14px;display:flex;align-items:center;gap:8px;">
							<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;"><circle cx="7" cy="7" r="6" stroke="#b45309" stroke-width="1.3"/><path d="M7 4v3.5M7 9.5v.5" stroke="#b45309" stroke-width="1.4" stroke-linecap="round"/></svg>
							<p style="font-size:12px;color:#92400e;line-height:1.5;">The plain-language summary is taking longer than expected — your audit findings are unaffected.</p>
						</div>
					{/if}
				</div>
			{/if}

			<!-- What gets checked -->
			<div style="margin-top:48px;">
				<p style="font-size:11px;font-weight:700;color:var(--text-4);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:20px;text-align:center;">What gets checked</p>
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
					{#each [
						['Readability', 'Text contrast is measured using APCA — the perceptual model behind modern accessibility standards — checked against the actual background colour of each element.'],
						['Visual Weight', 'The page is divided into quadrants and the density of dark, large, or high-contrast elements is compared across them, catching layouts where one side dominates.'],
						['Visual Hierarchy', 'Font sizes across headings, subheadings, and body text are compared to check whether the page signals what matters most or treats everything the same.'],
						['Typography', 'Line lengths are measured in characters to check whether text columns fall within a comfortable reading range, and minimum font sizes are verified.'],
						['Colour Palette', 'Hues, tones, and colour temperatures across the page are checked for variety, saturation spread, and whether light and dark shades are genuinely distinct.'],
						['Spacing & Layout', 'Margin and padding values are scanned for inconsistency, and elements are checked for alignment to a shared grid or axis.'],
						['Interactive Targets', 'Buttons and links are measured against minimum touch target sizes and checked for adequate separation to prevent accidental activations.'],
						['Icon & Image Size', 'Icons and images are checked to ensure they are large enough to be clearly recognisable, not just technically present on the page.'],
					] as [title, desc]}
						<div style="display:flex;gap:12px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;">
							<div style="width:6px;height:6px;border-radius:50%;background:#2563eb;margin-top:6px;flex-shrink:0;"></div>
							<div>
								<p style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">{title}</p>
								<p style="font-size:12px;color:var(--text-3);line-height:1.6;">{desc}</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if compareResult}
			<!-- ── COMPARE VIEW ───────────────────────────────────────────────── -->
			{@const algoFindings = compareResult.algo?.findings ?? []}
			{@const aiFindings = compareResult.ai?.findings ?? []}
			{@const ALIASES = /** @type {Record<string,string>} */({'Visual Balance': 'Optical Centering'})}
			{@const normCat = (/** @type {string} */ c) => ALIASES[c] ?? c}
			{@const algoCategories = new Set(algoFindings.map((/** @type {any} */ f) => f.category))}
			{@const aiCategoriesNorm = new Set(aiFindings.map((/** @type {any} */ f) => normCat(f.category)))}
			{@const allCategories = [...new Set([...algoCategories, ...aiCategoriesNorm])]}
			{@const aiOnlyFindings = aiFindings.filter((/** @type {any} */ f) => !algoCategories.has(normCat(f.category)))}

			<!-- Header -->
			<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
				<div>
					<p style="font-size:12px;font-weight:600;color:#2563eb;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">Algorithmic vs AI</p>
					<h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;">Comparison Report</h2>
				</div>
				<button onclick={reset} style="background:var(--surface);border:1px solid var(--border);color:var(--text-2);font-size:13px;font-weight:500;padding:8px 16px;border-radius:10px;cursor:pointer;">New Audit</button>
			</div>

			<!-- Score comparison -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
				{#each [['Algorithmic', compareResult.algo, '#059669'], ['AI', compareResult.ai, '#2563eb']] as [label, res, color]}
					{@const score = res?.overallScore ?? 0}
					{@const ringC = 2 * Math.PI * 36}
					<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;gap:16px;align-items:flex-start;">
						<div style="text-align:center;flex-shrink:0;">
							<svg width="80" height="80" viewBox="0 0 88 88">
								<circle cx="44" cy="44" r="36" fill="none" style="stroke:var(--border)" stroke-width="8"/>
								<circle cx="44" cy="44" r="36" fill="none" stroke={color} stroke-width="8"
									stroke-dasharray={ringC}
									stroke-dashoffset={ringC * (1 - score / 100)}
									stroke-linecap="round" transform="rotate(-90 44 44)"
									style="transition:stroke-dashoffset 1s ease;"/>
								<text x="44" y="48" text-anchor="middle" font-size="18" font-weight="700" fill={color} font-family="Plus Jakarta Sans, Inter, sans-serif">{score}</text>
							</svg>
							<p style="font-size:11px;font-weight:600;color:{color};margin-top:2px;">{label}</p>
						</div>
						<div style="flex:1;">
							<p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:8px;">{res?.summary ?? ''}</p>
							<p style="font-size:11px;color:var(--text-4);">{(res?.findings ?? []).length} findings · {(res?.findings ?? []).filter((/** @type {any} */ f) => f.severity === 'critical').length} critical</p>
						</div>
					</div>
				{/each}
			</div>

			<!-- Gap analysis — algorithm blind spots -->
			{#if aiOnlyFindings.length > 0}
				<div style="background:var(--surface);border:1.5px solid #bfdbfe;border-radius:16px;overflow:hidden;margin-bottom:20px;">
					<div style="background:#eff6ff;padding:14px 20px;border-bottom:1px solid #bfdbfe;display:flex;align-items:center;gap:10px;">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#2563eb" stroke-width="1.5"/><path d="M8 5v4M8 11v.5" stroke="#2563eb" stroke-width="1.5" stroke-linecap="round"/></svg>
						<p style="font-size:13px;font-weight:700;color:#1d4ed8;margin:0;">Algorithm Gaps — {aiOnlyFindings.length} finding{aiOnlyFindings.length !== 1 ? 's' : ''} the AI caught that the algorithm missed</p>
					</div>
					<div style="padding:4px 0;">
						{#each aiOnlyFindings as f, i (f.id ?? i)}
								<div style="{i > 0 ? 'border-top:1px solid var(--border-subtle);' : ''}padding:14px 20px;">
								<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
									<span style="font-size:10px;font-weight:700;letter-spacing:0.06em;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:5px;">{f.category}</span>
							<span style="font-size:11px;font-weight:600;color:{f.severity === 'critical' ? '#ef4444' : f.severity === 'warning' ? '#f59e0b' : 'var(--text-3)'}">{f.severity}</span>
									<span style="font-size:11px;color:var(--text-4);">· {f.element}</span>
								</div>
								<p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:4px;">{f.issue}</p>
								<p style="font-size:12px;color:#2563eb;font-style:italic;">{f.recommendation}</p>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:14px 20px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="#059669" stroke-width="1.5"/><polyline points="4.5,8 7,10.5 11.5,5.5" stroke="#059669" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
					<p style="font-size:13px;font-weight:600;color:#059669;margin:0;">No category gaps — the algorithm covers all categories the AI flagged.</p>
				</div>
			{/if}

			<!-- Category coverage matrix -->
				<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;margin-bottom:20px;">
					<div style="padding:14px 20px;border-bottom:1px solid var(--border-subtle);">
						<p style="font-size:13px;font-weight:700;color:var(--text);margin:0;">Category Coverage</p>
						<p style="font-size:11px;color:var(--text-4);margin-top:2px;">Which issue categories each engine flagged</p>
				</div>
				<div style="overflow-x:auto;">
					<table style="width:100%;border-collapse:collapse;font-size:12px;">
						<thead>
							<tr style="background:var(--surface-2);">
								<th style="text-align:left;padding:10px 20px;font-weight:600;color:var(--text-2);border-bottom:1px solid var(--border-subtle);min-width:180px;">Category</th>
								<th style="text-align:center;padding:10px 16px;font-weight:600;color:#059669;border-bottom:1px solid var(--border-subtle);min-width:100px;">Algorithmic</th>
								<th style="text-align:center;padding:10px 16px;font-weight:600;color:#2563eb;border-bottom:1px solid var(--border-subtle);min-width:100px;">AI</th>
								<th style="text-align:center;padding:10px 16px;font-weight:600;color:var(--text-4);border-bottom:1px solid var(--border-subtle);min-width:80px;">Total</th>
							</tr>
						</thead>
						<tbody>
							{#each allCategories as cat, i}
								{@const hasAlgo = algoCategories.has(cat)}
							{@const hasAi = aiCategoriesNorm.has(cat)}
							{@const isGap = hasAi && !hasAlgo}
							{@const algoCount = algoFindings.filter((/** @type {any} */ f) => f.category === cat).length}
							{@const aiCount = aiFindings.filter((/** @type {any} */ f) => normCat(f.category) === cat).length}
								<tr style="{i > 0 ? 'border-top:1px solid var(--border-subtle);' : ''}background:{isGap ? '#1d4ed820' : 'transparent'};">
									<td style="padding:10px 20px;color:{isGap ? '#60a5fa' : 'var(--text-2)'};font-weight:{isGap ? '600' : '400'};">
										{cat}
										{#if isGap}<span style="font-size:10px;background:#bfdbfe;color:#1d4ed8;padding:1px 6px;border-radius:4px;margin-left:6px;font-weight:700;">GAP</span>{/if}
									</td>
									<td style="text-align:center;padding:10px 16px;">
										{#if hasAlgo}
											<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#dcfce7;color:#059669;font-size:11px;font-weight:700;">{algoCount}</span>
										{:else}
											<span style="color:var(--text-5);">—</span>
										{/if}
									</td>
									<td style="text-align:center;padding:10px 16px;">
										{#if hasAi}
											<span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#dbeafe;color:#2563eb;font-size:11px;font-weight:700;">{aiCount}</span>
										{:else}
											<span style="color:var(--text-5);">—</span>
										{/if}
									</td>
									<td style="text-align:center;padding:10px 16px;color:var(--text-3);">{algoCount + aiCount}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>

			<!-- Side-by-side full findings -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
				{#each [['Algorithmic Findings', algoFindings, '#059669'], ['AI Findings', aiFindings, '#2563eb']] as [label, findings, color]}
					<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
						<div style="padding:14px 20px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between;">
							<p style="font-size:13px;font-weight:700;color:{color};margin:0;">{label}</p>
							<span style="font-size:11px;color:var(--text-4);">{findings.length} findings</span>
						</div>
						<div style="max-height:600px;overflow-y:auto;">
							{#each findings as f, i (f.id ?? i)}
									<div style="{i > 0 ? 'border-top:1px solid var(--border-subtle);' : ''}padding:12px 20px;">
									<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;">
										<span style="font-size:10px;font-weight:700;letter-spacing:0.05em;background:{color}15;color:{color};padding:2px 7px;border-radius:4px;">{f.category}</span>
											<span style="font-size:11px;font-weight:600;color:{f.severity === 'critical' ? '#ef4444' : f.severity === 'warning' ? '#f59e0b' : 'var(--text-3)'}">{f.severity}</span>
									</div>
										<p style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:3px;">{f.element}</p>
										<p style="font-size:12px;color:var(--text-3);line-height:1.5;">{f.issue}</p>
								</div>
							{:else}
										<p style="padding:20px;text-align:center;font-size:13px;color:var(--text-4);">No findings.</p>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{:else if compareAlgoAiResult}
			<!-- ── ALGO DIFF VIEW ─────────────────────────────────────────────── -->
			{@const algoFindings = compareAlgoAiResult.algo?.findings ?? []}
			{@const aiFindings = compareAlgoAiResult.algoAi?.findings ?? []}
			{@const score = compareAlgoAiResult.overallScore ?? 0}
			{@const ringC2 = 2 * Math.PI * 36}
			{@const gradeColor = score >= 80 ? '#059669' : score >= 55 ? '#d97706' : '#ef4444'}
			{@const gradeLabel = score >= 80 ? 'Good' : score >= 55 ? 'Fair' : 'Needs Work'}

			{#if aiUnavailable}
				<div style="background:#854d0e1a;border:1px solid #a16207;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:12px;align-items:flex-start;">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:2px;"><circle cx="7" cy="7" r="6" stroke="#b45309" stroke-width="1.3"/><path d="M7 4v3.5M7 9.5v.5" stroke="#b45309" stroke-width="1.4" stroke-linecap="round"/></svg>
					<div>
						<p style="font-size:13px;font-weight:600;color:#ca8a04;margin:0 0 4px;">Plain-language summary temporarily unavailable</p>
						<p style="font-size:13px;color:var(--text-2);margin:0;line-height:1.5;">Gemini is currently overloaded, so the results are displayed as direct algorithmic output without simplified explanations or reference images. The analysis remains accurate, but the wording may be more technical and less user-friendly than usual.</p>
					</div>
				</div>
			{/if}

			{#if noImages}
				<div style="background:#1e3a5f1a;border:1px solid #2563eb55;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:12px;align-items:flex-start;">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:2px;"><circle cx="7" cy="7" r="6" stroke="#3b82f6" stroke-width="1.3"/><path d="M7 4v3.5M7 9.5v.5" stroke="#3b82f6" stroke-width="1.4" stroke-linecap="round"/></svg>
					<div>
						<p style="font-size:13px;font-weight:600;color:#60a5fa;margin:0 0 4px;">Reference images not available for this analysis</p>
						<p style="font-size:13px;color:var(--text-2);margin:0;line-height:1.5;">The AI ran successfully but did not find any book reference images that matched the findings closely enough. The written analysis and recommendations are still complete.</p>
					</div>
				</div>
			{/if}

			<!-- Header -->
			<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
				<div>
					<p style="font-size:12px;font-weight:600;color:#7c3aed;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">Algorithmic vs Algo ft. AI</p>
					<h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;">Prose Diff Report</h2>
				</div>
				<button onclick={reset} style="background:var(--surface);border:1px solid var(--border);color:var(--text-2);font-size:13px;font-weight:500;padding:8px 16px;border-radius:10px;cursor:pointer;">New Audit</button>
			</div>

			<!-- Score + summaries -->
			<div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:20px;display:flex;gap:24px;align-items:flex-start;">
				<div style="text-align:center;flex-shrink:0;">
					<svg width="88" height="88" viewBox="0 0 88 88">
						<circle cx="44" cy="44" r="36" fill="none" style="stroke:var(--border)" stroke-width="8"/>
						<circle cx="44" cy="44" r="36" fill="none" stroke={gradeColor} stroke-width="8"
							stroke-dasharray={ringC2}
							stroke-dashoffset={ringC2 * (1 - score / 100)}
							stroke-linecap="round" transform="rotate(-90 44 44)"
							style="transition:stroke-dashoffset 1s ease;"/>
						<text x="44" y="48" text-anchor="middle" font-size="18" font-weight="700" fill={gradeColor} font-family="Plus Jakarta Sans, Inter, sans-serif">{score}</text>
					</svg>
					<p style="font-size:12px;font-weight:600;color:{gradeColor};margin-top:4px;">{gradeLabel}</p>
					<p style="font-size:10px;color:var(--text-4);margin-top:2px;">{algoFindings.length} findings</p>
				</div>
				<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:16px;">
				<div style="background:#fff3;border:1px solid #bbf7d0;border-radius:12px;padding:14px 16px;">
					<p style="font-size:10px;font-weight:700;color:#059669;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Algorithmic summary</p>
					<p style="font-size:13px;color:var(--text-2);line-height:1.55;">{compareAlgoAiResult.algo?.summary ?? ''}</p>
				</div>
				<div style="background:#fff3;border:1px solid #e9d5ff;border-radius:12px;padding:14px 16px;">
					<p style="font-size:10px;font-weight:700;color:#7c3aed;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Algo ft. AI summary</p>
					<p style="font-size:13px;color:var(--text-2);line-height:1.55;">{compareAlgoAiResult.algoAi?.summary ?? ''}</p>
					</div>
				</div>
			</div>

			<!-- Column headers -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:0 0 6px 0;margin-bottom:4px;">
				<p style="font-size:11px;font-weight:700;color:#059669;letter-spacing:0.08em;text-transform:uppercase;text-align:center;">Algorithmic</p>
				<p style="font-size:11px;font-weight:700;color:#7c3aed;letter-spacing:0.08em;text-transform:uppercase;text-align:center;">Algo ft. AI</p>
			</div>

			<!-- Per-finding prose diff -->
			<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
				{#each algoFindings as algoF, i}
					{@const aiF = aiFindings[i]}
					{@const cat = CATEGORY_META[algoF.category] ?? { color: '#6b7280', darkColor: '#9ca3af', short: '?', passMsg: '' }}
				<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
					<!-- Finding header — shared metadata -->
					<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface-2);border-bottom:1px solid var(--border-subtle);flex-wrap:wrap;">
							<span style="font-size:10px;font-weight:700;letter-spacing:0.06em;background:{c(cat)}1a;color:{c(cat)};padding:2px 7px;border-radius:5px;">{cat.short} · {algoF.category}</span>
						<span style="font-size:11px;font-weight:600;color:{algoF.severity === 'critical' ? c(SEV.critical) : algoF.severity === 'warning' ? c(SEV.warning) : 'var(--text-3)'}">{algoF.severity}</span>
						<span style="font-size:11px;color:var(--text-5);">·</span>
						<span style="font-size:11px;color:var(--text-4);flex:1;">{algoF.element}</span>
						<span style="font-size:11px;color:var(--text-5);">{algoF.id}</span>
						</div>
						<!-- Two-column prose diff -->
						<div style="display:grid;grid-template-columns:1fr 1fr;">
							<!-- Algorithmic prose -->
						<div style="padding:14px 16px;border-right:1px solid var(--border-subtle);">
							<p style="font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:10px;">{algoF.issue}</p>
								<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;">
									<p style="font-size:10px;font-weight:700;color:#059669;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.06em;">Fix</p>
									<p style="font-size:12px;color:var(--text-2);line-height:1.5;">{algoF.recommendation}</p>
								</div>
							</div>
							<!-- AI-rewritten prose -->
							<div style="padding:14px 16px;">
								{#if aiF}
								<p style="font-size:12px;color:var(--text-2);line-height:1.6;margin-bottom:10px;">{aiF.issue}</p>
									<div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:8px;padding:10px 12px;">
										<p style="font-size:10px;font-weight:700;color:#7c3aed;margin-bottom:3px;text-transform:uppercase;letter-spacing:0.06em;">Fix</p>
										<p style="font-size:12px;color:var(--text-2);line-height:1.5;">{aiF.recommendation}</p>
									</div>
								{:else}
								<p style="font-size:12px;color:var(--text-5);font-style:italic;padding-top:4px;">No AI rewrite for this finding.</p>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>

			<!-- Strengths comparison -->
			{#if compareAlgoAiResult.algo?.strengths?.length || compareAlgoAiResult.algoAi?.strengths?.length}
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
					{#each [['Algorithmic Strengths', compareAlgoAiResult.algo?.strengths ?? [], '#059669', '#f0fdf4', '#bbf7d0'], ['AI-Written Strengths', compareAlgoAiResult.algoAi?.strengths ?? [], '#7c3aed', '#faf5ff', '#e9d5ff']] as [label, items, color, bg, border]}
						<div style="background:{bg};border:1px solid {border};border-radius:12px;padding:16px 20px;">
							<p style="font-size:11px;font-weight:700;color:{color};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">{label}</p>
							{#each items as s}
								<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:7px;">
									<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:1px;"><circle cx="7" cy="7" r="6" stroke={color} stroke-width="1.2"/><polyline points="4,7 6.5,9.5 10.5,4.5" stroke={color} stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
									<p style="font-size:12px;color:var(--text-2);line-height:1.5;">{s}</p>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			{/if}

		{:else}
			<!-- Results header -->
			<div
				style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;"
			>
				<div>
					<p
						style="font-size:12px;font-weight:600;color:#059669;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;"
					>
						{resultMode === 'ai' ? 'AI Audit Complete' : resultMode === 'algo' ? 'Raw Algorithmic Audit Complete' : 'Algorithmic Audit Complete'}
					</p>
					<h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;">
						Perceptual Balance Report
					</h2>
				</div>
				<button
					onclick={reset}
					style="background:var(--surface);border:1px solid var(--border);color:var(--text-2);font-size:13px;font-weight:500;padding:8px 16px;border-radius:10px;"
				>
					New Audit
				</button>
			</div>

			{#if aiUnavailable}
				<div style="background:#854d0e1a;border:1px solid #a16207;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:12px;align-items:flex-start;">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:2px;"><circle cx="7" cy="7" r="6" stroke="#b45309" stroke-width="1.3"/><path d="M7 4v3.5M7 9.5v.5" stroke="#b45309" stroke-width="1.4" stroke-linecap="round"/></svg>
					<div>
						<p style="font-size:13px;font-weight:600;color:#ca8a04;margin:0 0 4px;">Plain-language summary temporarily unavailable</p>
						<p style="font-size:13px;color:var(--text-2);margin:0;line-height:1.5;">Gemini is currently overloaded, so the results are displayed as direct algorithmic output without simplified explanations or reference images. The analysis remains accurate, but the wording may be more technical and less user-friendly than usual.</p>
					</div>
				</div>
			{/if}

			{#if noImages}
				<div style="background:#1e3a5f1a;border:1px solid #2563eb55;border-radius:12px;padding:14px 18px;margin-bottom:16px;display:flex;gap:12px;align-items:flex-start;">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0;margin-top:2px;"><circle cx="7" cy="7" r="6" stroke="#3b82f6" stroke-width="1.3"/><path d="M7 4v3.5M7 9.5v.5" stroke="#3b82f6" stroke-width="1.4" stroke-linecap="round"/></svg>
					<div>
						<p style="font-size:13px;font-weight:600;color:#60a5fa;margin:0 0 4px;">Reference images not available for this analysis</p>
						<p style="font-size:13px;color:var(--text-2);margin:0;line-height:1.5;">The AI ran successfully but did not find any book reference images that matched the findings closely enough. The written analysis and recommendations are still complete.</p>
					</div>
				</div>
			{/if}

			<!-- Score card -->
			<div
				style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;margin-bottom:20px;display:flex;gap:28px;align-items:flex-start;"
			>
				<div style="text-align:center;flex-shrink:0;">
					<svg width="88" height="88" viewBox="0 0 88 88">
						<circle cx="44" cy="44" r="36" fill="none" style="stroke:var(--border)" stroke-width="8" />
						<circle
							cx="44"
							cy="44"
							r="36"
							fill="none"
					stroke={scoreGrade ? c(scoreGrade) : undefined}
							stroke-width="8"
							stroke-dasharray={RING_C}
							stroke-dashoffset={RING_C * (1 - result.overallScore / 100)}
							stroke-linecap="round"
							transform="rotate(-90 44 44)"
							style="transition:stroke-dashoffset 1s ease;"
						/>
						<text
							x="44"
							y="48"
							text-anchor="middle"
							font-size="18"
							font-weight="700"
							fill={scoreGrade ? c(scoreGrade) : undefined}
							font-family="Plus Jakarta Sans, Inter, sans-serif"
						>
							{result.overallScore}
						</text>
					</svg>
					<p style="font-size:12px;font-weight:600;color:{scoreGrade ? c(scoreGrade) : 'var(--text-3)'};margin-top:4px;">
						{scoreGrade?.label}
					</p>
				</div>

				<div style="flex:1;">
					<p style="font-size:14px;color:var(--text-2);line-height:1.65;margin-bottom:16px;">
						{result.summary}
					</p>
					<div style="display:flex;gap:8px;flex-wrap:wrap;">
						{#each [['all', 'All', 'var(--text-2)'], ['critical', 'Critical', c(SEV.critical)], ['warning', 'Warning', c(SEV.warning)], ['info', 'Info', c(SEV.info)]] as [key, label, color]}
							<button
								onclick={() => (filter = key)}
								style="padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500;border:1px solid;border-color:{filter ===
								key
									? color
									: 'var(--border)'};background:{filter === key
									? color + '1a'
									: 'transparent'};color:{filter === key ? color : 'var(--text-3)'};"
							>
								{label} · {counts[/** @type {keyof typeof counts} */ (key)]}
							</button>
						{/each}
					</div>
				</div>
			</div>

			<!-- Hidden source image for canvas drawing -->
			<img bind:this={imgEl} src={image} alt="" style="display:none;" />

			<!-- Two-column layout: sticky screenshot LEFT, scrollable findings RIGHT -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;">

				<!-- LEFT: screenshot -->
				<div style="position:sticky;top:72px;">
					<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;">
						<canvas
							bind:this={canvasEl}
							onclick={handleCanvasClick}
							style="width:100%;display:block;background:var(--surface-3);"
						></canvas>
					</div>
				</div>

				<!-- RIGHT: scrollable findings list -->
				<div style="display:flex;flex-direction:column;gap:10px;">
					{#if filter !== 'all' && counts[/** @type {keyof typeof counts} */ (filter)] === 0}
					<p style="text-align:center;color:var(--text-4);font-size:13px;padding:32px 0;">
							No findings for this filter.
						</p>
					{/if}
					{#each grouped as { catName, allInCat, filtered }}
						{#if filter === 'all' || filtered.length > 0}
							{@const cat = CATEGORY_META[catName] ?? { color: '#6b7280', darkColor: '#9ca3af', short: '?', passMsg: '' }}
								<div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid {c(cat)};border-radius:12px;overflow:hidden;">
								<!-- Category header -->
									<div style="display:flex;align-items:center;gap:10px;padding:11px 16px;background:var(--surface-2);border-bottom:1px solid var(--border-subtle);">
									<div style="background:{c(cat)}1a;color:{c(cat)};font-size:10px;font-weight:700;letter-spacing:0.06em;padding:2px 7px;border-radius:5px;flex-shrink:0;">
										{cat.short}
									</div>
										<span style="font-size:13px;font-weight:600;color:var(--text);flex:1;">{catName}</span>
									{#if filtered.length > 0}
											<span style="font-size:11px;font-weight:500;color:var(--text-3);">{filtered.length} {filtered.length === 1 ? 'finding' : 'findings'}</span>
									{:else}
										<span style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#059669;">
											<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="6" stroke="#059669" stroke-width="1.2"/><polyline points="3.5,6.5 5.5,8.5 9.5,4.5" stroke="#059669" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
											Passed
										</span>
									{/if}
								</div>
								<!-- Body: findings or pass message -->
								{#if filtered.length > 0}
									{#if result?.categorySummaries?.[catName]}
												<div style="padding:12px 16px;border-bottom:1px solid var(--border-subtle);background:var(--surface-2);">
													<p style="font-size:12.5px;color:var(--text-2);line-height:1.6;margin:0;">{result.categorySummaries[catName]}</p>
										</div>
									{/if}
									{#each filtered as f, i}
										{@const sev = SEV[f.severity] ?? SEV.info}
										<div
											role="button"
											tabindex="0"
											onclick={() => (activeIdx = activeIdx === f._idx ? -1 : f._idx)}
											onkeydown={(e) => { if (e.key === 'Enter') activeIdx = activeIdx === f._idx ? -1 : f._idx; }}
													style="{i > 0 ? 'border-top:1px solid var(--border-subtle);' : ''}padding:14px 16px;background:{activeIdx === f._idx ? 'var(--active-finding-bg)' : 'transparent'};transition:background 0.15s;cursor:pointer;"
										>
											<div style="display:flex;align-items:flex-start;gap:12px;">
												<div
													title={Array.isArray(f.boundingBox) ? 'Click to highlight on screenshot' : 'No specific location — applies to the whole page'}
															style="flex-shrink:0;margin-top:2px;background:{Array.isArray(f.boundingBox) ? c(cat) : 'var(--text-5)'};color:#fff;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;"
												>
													{f._idx + 1}
												</div>
												<div style="flex:1;min-width:0;">
													<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap;">
														<span style="font-size:11px;font-weight:600;color:{c(sev)};">{sev.label}</span>
																<span style="font-size:11px;color:var(--text-5);">·</span>
																<span style="font-size:11px;color:var(--text-4);">{f.element}</span>
																<span style="font-size:11px;color:var(--text-5);margin-left:auto;">{f.id}</span>
													</div>
																<p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:10px;">{f.issue}</p>
													<button
														onclick={(e) => { e.stopPropagation(); expandedFixes[f._idx] = !expandedFixes[f._idx]; }}
														style="font-size:11px;font-weight:600;color:{c(cat)};border:1px solid {c(cat)}40;background:{c(cat)}0d;padding:4px 10px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;"
													>
														{#if expandedFixes[f._idx]}
															<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 7L5 4L8 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
															Hide fix
														{:else}
															<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3L5 6L8 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
															Show fix
														{/if}
													</button>
													{#if expandedFixes[f._idx]}
											<div style="margin-top:8px;background:{c(cat)}0d;border:1px solid {c(cat)}30;border-radius:8px;padding:10px 12px;">
												<p style="font-size:12px;color:{c(cat)};line-height:1.55;">{f.recommendation}</p>
												{#if f.bookImages && f.bookImages.length > 0}
													<div style="margin-top:10px;border-top:1px solid {c(cat)}25;padding-top:10px;display:flex;flex-direction:column;gap:12px;">
																	{#each f.bookImages as img}
																		<div>
																			<img
																				src="/book-images/{img.src}"
																				alt={img.caption}
																				loading="lazy"
																				style="width:92%;border-radius:6px;border:1px solid {c(cat)}25;display:block;background:#fff;"
																			/>
																			<p style="font-size:11px;color:var(--text-3);margin-top:5px;line-height:1.45;">{img.caption}</p>
																		</div>
																	{/each}
																</div>
															{/if}
														</div>
													{/if}
												</div>
											</div>
										</div>
									{/each}
								{:else}
									<div style="padding:11px 16px;">
													<p style="font-size:12px;color:var(--text-3);">{cat.passMsg ?? 'No issues found in this category.'}</p>
									</div>
								{/if}
							</div>
						{/if}
					{/each}

					<!-- Strengths + Expert note — coming soon -->
					<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
						{#each ['Strengths', 'Expert Note'] as label}
							<div style="background:var(--surface-2);border:1px dashed var(--border);border-radius:12px;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:80px;">
								<p style="font-size:11px;font-weight:700;color:var(--text-5);letter-spacing:0.08em;text-transform:uppercase;">{label}</p>
								<p style="font-size:12px;color:var(--text-5);">Coming soon</p>
							</div>
						{/each}
					</div>
				</div>

			</div>

		{/if}
	</main>

	<footer style="text-align:center;padding:20px 24px;border-top:1px solid var(--border-subtle);margin-top:auto;">
		<p style="font-size:11px;color:var(--text-4);">Percepta is a non-profit prototype developed as part of a Bachelor's thesis. Not intended for commercial use.</p>
	</footer>

	<!-- ── CI/CD info balloon ─────────────────────────────────────────────── -->
	<button
		onclick={() => { cicdOpen = !cicdOpen; }}
		title="CI/CD pipeline info"
		aria-label="Learn about CI/CD usage"
		style="position:fixed;bottom:80px;right:24px;z-index:1000;width:48px;height:48px;border-radius:50%;background:var(--surface);border:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,0.15);transition:transform 0.15s;"
		onmouseenter={(e) => { /** @type {HTMLButtonElement} */ (e.currentTarget).style.transform = 'scale(1.08)'; }}
		onmouseleave={(e) => { /** @type {HTMLButtonElement} */ (e.currentTarget).style.transform = 'scale(1)'; }}
	>
		<!-- Terminal/pipeline icon -->
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-3);">
			<polyline points="4 17 10 11 4 5"/>
			<line x1="12" y1="19" x2="20" y2="19"/>
		</svg>
	</button>

	{#if cicdOpen}
		<!-- Click-outside backdrop -->
		<div
			role="presentation"
			onclick={() => { cicdOpen = false; }}
			style="position:fixed;inset:0;z-index:1000;"
		></div>
		<!-- Balloon card -->
		<div style="position:fixed;bottom:80px;right:80px;z-index:1001;width:272px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;box-shadow:0 8px 32px rgba(0,0,0,0.22);">
			<!-- Arrow pointing right -->
			<div style="position:absolute;right:-7px;bottom:18px;width:13px;height:13px;background:var(--surface);border-top:1px solid var(--border);border-right:1px solid var(--border);transform:rotate(45deg);border-radius:2px;"></div>
			<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
				<div style="width:28px;height:28px;border-radius:8px;background:#1e3a5f33;border:1px solid #2563eb44;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
				</div>
				<p style="font-size:13px;font-weight:700;color:var(--text);margin:0;letter-spacing:-0.01em;">CI/CD Ready</p>
			</div>
			<p style="font-size:12px;color:var(--text-3);line-height:1.65;margin:0 0 12px;">Percepta is an open-source tool that can run headlessly inside your deployment pipeline. Trigger a design audit on every push and set a minimum score — if the score drops below your threshold, the build fails automatically.</p>
			<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
				<p style="font-size:10px;font-weight:700;color:var(--text-4);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 6px;">Example pipeline step</p>
				<code style="font-size:11px;color:#60a5fa;line-height:1.7;white-space:pre-wrap;display:block;">percepta audit \
  --url $DEPLOY_URL \
  --min-score 70</code>
			</div>
		</div>
	{/if}

	<!-- ── Feedback floating button ───────────────────────────────────────── -->
	<button
		onclick={() => { feedbackOpen = !feedbackOpen; }}
		title="Leave professional feedback"
		aria-label="Open feedback panel"
		style="position:fixed;bottom:24px;right:24px;z-index:1000;width:48px;height:48px;border-radius:50%;background:#2563eb;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(37,99,235,0.4);transition:transform 0.15s,box-shadow 0.15s;"
		onmouseenter={(e) => { /** @type {HTMLButtonElement} */ (e.currentTarget).style.transform = 'scale(1.08)'; }}
		onmouseleave={(e) => { /** @type {HTMLButtonElement} */ (e.currentTarget).style.transform = 'scale(1)'; }}
	>
		<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
		</svg>
	</button>

	{#if feedbackOpen}
		<!-- Backdrop -->
		<div
			role="presentation"
			onclick={() => { feedbackOpen = false; }}
			style="position:fixed;inset:0;background:rgba(0,0,0,0.25);z-index:1001;backdrop-filter:blur(2px);"
		></div>

		<!-- Drawer -->
		<div style="position:fixed;right:0;top:0;bottom:0;width:380px;max-width:100vw;background:var(--bg);border-left:1px solid var(--border);z-index:1002;display:flex;flex-direction:column;overflow:hidden;box-shadow:-8px 0 40px rgba(0,0,0,0.18);">

			<!-- Drawer header -->
			<div style="display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--border);flex-shrink:0;">
				<div>
					<p style="font-size:11px;font-weight:700;color:#2563eb;letter-spacing:0.09em;text-transform:uppercase;margin-bottom:2px;">Professional Review</p>
					<h3 style="font-size:17px;font-weight:700;color:var(--text);letter-spacing:-0.02em;margin:0;">Leave Feedback</h3>
				</div>
				<button
					onclick={() => { feedbackOpen = false; }}
					aria-label="Close feedback panel"
					style="width:32px;height:32px;border-radius:8px;background:var(--surface);border:1px solid var(--border);cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-3);"
				>
					<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 2l10 10M12 2L2 12"/></svg>
				</button>
			</div>

			<!-- Drawer body -->
			<div style="flex:1;overflow-y:auto;padding:22px;">
				{#if feedbackStatus === 'sent'}
					<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:260px;gap:16px;text-align:center;">
						<div style="width:56px;height:56px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;">
							<svg width="26" height="26" viewBox="0 0 26 26" fill="none"><circle cx="13" cy="13" r="12" stroke="#059669" stroke-width="1.5"/><polyline points="7,13 11,17 19,9" stroke="#059669" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</div>
						<div>
							<p style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;">Feedback submitted</p>
							<p style="font-size:13px;color:var(--text-3);line-height:1.55;">Your comment has been recorded privately. Thank you for taking the time to review this tool.</p>
						</div>
						<button
							onclick={() => { feedbackStatus = 'idle'; feedbackComment = ''; feedbackName = ''; feedbackRole = ''; feedbackPractical = ''; feedbackWouldUse = ''; feedbackHelpful = ''; feedbackCicd = ''; feedbackTestedUrl = ''; feedbackMissedIssues = ''; feedbackOpen = false; }}
							style="padding:10px 24px;border-radius:10px;background:#2563eb;color:#fff;border:none;font-size:13px;font-weight:600;cursor:pointer;"
						>Close</button>
					</div>
				{:else}
					<p style="font-size:13px;color:var(--text-3);line-height:1.6;margin-bottom:20px;">Comments are submitted privately and not shown publicly. This feedback helps improve Percepta.</p>

					<div style="display:flex;flex-direction:column;gap:14px;">
						<div>
							<label style="display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">Name <span style="color:var(--text-5);font-weight:400;">(optional)</span></label>
							<input
								type="text"
								bind:value={feedbackName}
								placeholder="Your name"
								maxlength="120"
								disabled={feedbackStatus === 'sending'}
								style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);background:var(--surface);outline:none;box-sizing:border-box;"
							/>
						</div>
						<div>
							<label style="display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">Role <span style="color:var(--text-5);font-weight:400;">(optional)</span></label>
							<input
								type="text"
								bind:value={feedbackRole}
								placeholder="e.g. UX Designer, Developer, Researcher"
								maxlength="120"
								disabled={feedbackStatus === 'sending'}
								style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);background:var(--surface);outline:none;box-sizing:border-box;"
							/>
						</div>
						<!-- Quick questionnaire -->
						<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px;">
							<p style="font-size:12px;font-weight:700;color:var(--text-2);margin:0;letter-spacing:-0.01em;">Quick Questions <span style="color:var(--text-5);font-weight:400;font-size:11px;">(optional)</span></p>

							{#snippet ratingRow(label, value, setter, labels)}
								<div>
									<p style="font-size:12px;color:var(--text-3);margin:0 0 7px;">{label}</p>
									<div style="display:flex;gap:6px;">
										{#each (labels ?? [['yes','Yes'], ['maybe','Partly'], ['no','No']]) as [val, lbl]}
											<button
												onclick={() => setter(value === val ? '' : val)}
												disabled={feedbackStatus === 'sending'}
												style="flex:1;padding:7px 4px;border-radius:8px;font-size:12px;font-weight:600;border:1.5px solid {value === val ? '#2563eb' : 'var(--border)'};background:{value === val ? '#2563eb' : 'var(--surface-2)'};color:{value === val ? '#fff' : 'var(--text-3)'};cursor:pointer;transition:all 0.12s;"
											>{lbl}</button>
										{/each}
									</div>
								</div>
							{/snippet}

							{@render ratingRow('Is this tool practical to use?', feedbackPractical, (v) => { feedbackPractical = v; })}
							{@render ratingRow('Did the analysis help identify real usability or design issues?', feedbackHelpful, (v) => { feedbackHelpful = v; })}
							{@render ratingRow('Could you see yourself using a tool like this in your workflow?', feedbackWouldUse, (v) => { feedbackWouldUse = v; }, [['yes','Yes'], ['maybe','Maybe'], ['no','No']])}
							{@render ratingRow('Would a tool like this be valuable in a CI/CD pipeline?', feedbackCicd, (v) => { feedbackCicd = v; }, [['yes','Yes'], ['maybe','Maybe'], ['no','No']])}
						</div>

						<div>
							<label style="display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">Comment <span style="color:#ef4444;font-size:10px;margin-left:3px;">required</span></label>
							<textarea
								bind:value={feedbackComment}
								placeholder="Share your thoughts — what works well, what's confusing, what could be improved…"
								maxlength="2000"
								rows="6"
								disabled={feedbackStatus === 'sending'}
								style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);background:var(--surface);outline:none;resize:vertical;min-height:120px;box-sizing:border-box;"
							></textarea>
							<p style="font-size:11px;color:var(--text-5);text-align:right;margin-top:3px;">{feedbackComment.length}/2000</p>
						</div>

						<!-- Optional: tested URLs + missed issues -->
						<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:14px;">
							<p style="font-size:12px;font-weight:700;color:var(--text-2);margin:0;letter-spacing:-0.01em;">Help us improve detection <span style="color:var(--text-5);font-weight:400;font-size:11px;">(optional)</span></p>
							<div>
								<label style="display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">Website(s) you tested</label>
								<input
									type="url"
									bind:value={feedbackTestedUrl}
									placeholder="https://example.com"
									maxlength="500"
									disabled={feedbackStatus === 'sending'}
									style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);background:var(--surface-2);outline:none;box-sizing:border-box;"
								/>
								<p style="font-size:11px;color:var(--text-5);margin-top:3px;">Paste the URL of the site you ran through Percepta</p>
							</div>
							<div>
								<label style="display:block;font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">Issues Percepta missed</label>
								<textarea
									bind:value={feedbackMissedIssues}
									placeholder="e.g. Low-contrast placeholder text wasn't flagged, icon-only buttons had no accessible label…"
									maxlength="1000"
									rows="4"
									disabled={feedbackStatus === 'sending'}
									style="width:100%;padding:9px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);background:var(--surface-2);outline:none;resize:vertical;min-height:90px;box-sizing:border-box;"
								></textarea>
								<p style="font-size:11px;color:var(--text-5);text-align:right;margin-top:3px;">{feedbackMissedIssues.length}/1000</p>
							</div>
						</div>

						{#if feedbackStatus === 'error'}
							<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-size:12px;color:#dc2626;">{feedbackError}</div>
						{/if}

						<button
							onclick={submitFeedback}
							disabled={!feedbackComment.trim() || feedbackStatus === 'sending'}
							style="width:100%;padding:11px;border-radius:10px;border:none;background:{feedbackComment.trim() && feedbackStatus !== 'sending' ? '#2563eb' : 'var(--surface-3)'};color:{feedbackComment.trim() && feedbackStatus !== 'sending' ? '#fff' : 'var(--text-4)'};font-size:13px;font-weight:600;cursor:{feedbackComment.trim() && feedbackStatus !== 'sending' ? 'pointer' : 'not-allowed'};transition:all 0.15s;display:flex;align-items:center;justify-content:center;gap:7px;"
						>
							{#if feedbackStatus === 'sending'}
								<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:spin 0.8s linear infinite;"></span>
								Submitting…
							{:else}
								Submit Feedback
							{/if}
						</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}

</div>
