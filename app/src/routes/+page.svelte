<script>
	import { CATEGORY_META, CATEGORY_ORDER, SEV, LOADING_STEPS, ALGO_LOADING_STEPS } from '$lib/ui/constants.js';

	let image = $state(/** @type {string | null} */ (null));
	let url = $state('');
	let loading = $state(false);
	let step = $state(0);
	let result = $state(/** @type {any} */ (null));
	let errorMsg = $state(/** @type {string | null} */ (null));
	let filter = $state('all');
	let stepInterval = /** @type {ReturnType<typeof setInterval> | undefined} */ (undefined);
	let activeIdx = $state(-1);
	/** @type {HTMLCanvasElement | null} */
	let canvasEl = $state(null);
	/** @type {HTMLImageElement | null} */
	let imgEl = $state(null);
	let mode = $state(/** @type {'ai' | 'algo'} */ ('algo'));
	let resultMode = $state(/** @type {'ai' | 'algo'} */ ('algo'));

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

	let scoreGrade = $derived(
		!result
			? null
			: result.overallScore >= 80
				? { label: 'Good', color: '#059669' }
				: result.overallScore >= 55
					? { label: 'Fair', color: '#d97706' }
					: { label: 'Poor', color: '#ef4444' }
	);

	async function analyse() {
		if (!url.trim()) return;
		loading = true;
		errorMsg = null;
		result = null;
		image = null;
		step = 0;
		activeIdx = -1;
		resultMode = mode;
		const steps = mode === 'algo' ? ALGO_LOADING_STEPS : LOADING_STEPS;
		stepInterval = setInterval(() => {
			step = (step + 1) % steps.length;
		}, 1600);
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
			const data = await res.json();
			image = data.screenshot;
			result = data;
		} catch (e) {
			errorMsg = /** @type {Error} */ (e).message;
		} finally {
			clearInterval(stepInterval);
			loading = false;
		}
	}

	function reset() {
		url = '';
		image = null;
		result = null;
		errorMsg = null;
		filter = 'all';
		activeIdx = -1;
	}

	function drawCanvas() {
		if (!canvasEl || !imgEl || !result) return;
		const doRender = () => {
			if (!canvasEl || !imgEl) return;
			const W = imgEl.naturalWidth;
			const H = imgEl.naturalHeight;
			if (!W || !H) return; // image not decoded yet — onload will retry
			const ctx = canvasEl.getContext('2d');
			if (!ctx) return;
			canvasEl.width = W;
			canvasEl.height = H;
			ctx.drawImage(imgEl, 0, 0);
			(result.findings ?? []).forEach((/** @type {any} */ f, i) => {
				if (!Array.isArray(f.boundingBox) || f.boundingBox.length < 4) return;
				const [yn, xn, yn2, xn2] = f.boundingBox;
				const x = (xn / 1000) * W;
				const y = (yn / 1000) * H;
				const w = ((xn2 - xn) / 1000) * W;
				const h = ((yn2 - yn) / 1000) * H;
				const cat = CATEGORY_META[f.category] ?? { color: '#6b7280' };
				const isActive = activeIdx === i;
				ctx.save();
				ctx.lineWidth = Math.max(2, W / 400);
				ctx.strokeStyle = cat.color;
				ctx.fillStyle = cat.color + (isActive ? '44' : '1a');
				ctx.fillRect(x, y, w, h);
				ctx.strokeRect(x, y, w, h);
				const r = Math.max(11, W / 70);
				ctx.fillStyle = cat.color;
				ctx.beginPath();
				ctx.arc(x + r + 2, y + r + 2, r, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = '#fff';
				ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(String(i + 1), x + r + 2, y + r + 2);
				ctx.restore();
			});
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
		const W = canvasEl.width;
		const H = canvasEl.height;
		let hit = -1;
		for (let i = (result.findings?.length ?? 0) - 1; i >= 0; i--) {
			const f = result.findings[i];
			if (!Array.isArray(f.boundingBox) || f.boundingBox.length < 4) continue;
			const [yn, xn, yn2, xn2] = f.boundingBox;
			const x = (xn / 1000) * W;
			const y = (yn / 1000) * H;
			const w = ((xn2 - xn) / 1000) * W;
			const h = ((yn2 - yn) / 1000) * H;
			if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
				hit = i;
				break;
			}
		}
		activeIdx = hit === activeIdx ? -1 : hit;
	}

	$effect(() => {
		drawCanvas();
	});
</script>

<svelte:head>
	<title>Percepta — Optical UI Auditor</title>
</svelte:head>

<div
	style="min-height:100vh;background:#fafafa;color:#111;font-family:'Plus Jakarta Sans','Inter',sans-serif;"
>
	<!-- Nav -->
	<nav
		style="border-bottom:1px solid #e5e7eb;background:#fff;padding:0 32px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;"
	>
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
		<span style="font-size:12px;color:#9ca3af;">Login</span>
	</nav>

	<main style="max-width:800px;margin:0 auto;padding:48px 24px;">
		{#if !result}
			<!-- Hero -->
			<div style="text-align:center;margin-bottom:48px;">
				<p
					style="font-size:12px;font-weight:600;color:#2563eb;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:12px;"
				>
					Perceptual UI Analysis
				</p>
				<h1
					style="font-size:36px;font-weight:700;letter-spacing:-0.03em;line-height:1.15;color:#111;margin-bottom:14px;"
				>
					See what your users feel,<br />not just what they see.
				</h1>
				<p style="font-size:15px;color:#6b7280;line-height:1.6;max-width:480px;margin:0 auto;">
					Paste a URL and Percepta audits your live UI for perceptual contrast, visual balance, colour
					harmony, and spacing rhythm — issues standard DOM tools can't detect.
				</p>
			</div>

			<!-- URL input -->
			<div style="margin-bottom:16px;">
				<div style="display:flex;gap:8px;align-items:stretch;">
					<input
						type="url"
						bind:value={url}
						placeholder="https://yourapp.com"
						disabled={loading}
						onkeydown={(e) => { if (e.key === 'Enter' && url.trim() && !loading) analyse(); }}
						style="flex:1;padding:12px 14px;border:1.5px solid #e5e7eb;border-radius:12px;font-size:14px;font-family:inherit;color:#111;background:#fff;outline:none;transition:border-color 0.15s;"
					/>
					{#if url}
						<button
							onclick={reset}
							style="padding:10px 14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#9ca3af;font-size:13px;cursor:pointer;"
							aria-label="Clear URL"
						>✕</button>
					{/if}
				</div>
			</div>

			<!-- Mode selector -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#e5e7eb;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:12px;">
				<!-- Algorithmic tab -->
				<button
					onclick={() => (mode = 'algo')}
					style="padding:12px 16px;border:none;background:{mode === 'algo' ? '#fff' : '#f9fafb'};text-align:left;transition:background 0.15s;cursor:pointer;"
				>
					<p style="font-size:13px;font-weight:600;color:{mode === 'algo' ? '#111' : '#6b7280'};margin-bottom:2px;">Algorithmic</p>
					<p style="font-size:11px;color:{mode === 'algo' ? '#6b7280' : '#9ca3af'}">Rule-based</p>
				</button>
				<!-- AI tab — coming soon -->
				<button
					onclick={() => (mode = 'ai')}
					style="padding:12px 16px;border:none;background:{mode === 'ai' ? '#fff' : '#f9fafb'};text-align:left;transition:background 0.15s;cursor:pointer;position:relative;"
				>
					<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
						<p style="font-size:13px;font-weight:600;color:{mode === 'ai' ? '#6b7280' : '#9ca3af'};margin:0;">AI-Powered</p>
						<span style="font-size:9px;font-weight:700;letter-spacing:0.06em;background:#fef3c7;color:#92400e;border:1px solid #fde68a;padding:1px 6px;border-radius:4px;text-transform:uppercase;">Soon</span>
					</div>
					<p style="font-size:11px;color:#d1d5db;">Under construction</p>
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
				style="width:100%;padding:13px;border-radius:12px;border:none;background:{url.trim() && !loading && mode === 'algo'
					? '#059669'
					: '#f3f4f6'};color:{url.trim() && !loading && mode === 'algo'
					? '#fff'
					: '#9ca3af'};font-size:14px;font-weight:600;letter-spacing:-0.01em;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;"
			>
				{#if loading}
					<span
						style="width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:spin 0.8s linear infinite;"
					></span>
					{ALGO_LOADING_STEPS[step]}…
				{:else if mode === 'ai'}
					AI-Powered — Coming Soon
				{:else}
					Run Perceptual Audit
				{/if}
			</button>

			<!-- What gets checked -->
			<div style="margin-top:48px;">
				<p style="font-size:11px;font-weight:700;color:#9ca3af;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:20px;text-align:center;">What gets checked</p>
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
					{#each [
						['Contrast', 'Is your text actually readable — not just technically, but comfortably — for real people in normal lighting?'],
						['Visual Balance', 'Does the page feel centred, or does the eye get pulled to one side by a heavy element or dark block?'],
						['Colour', 'Are you using colour with intention? Too many colours compete for attention. Too few make everything feel flat.'],
						['Type Hierarchy', 'Can someone scan the page and instantly know what matters most — or does everything look the same size?'],
						['Spacing', 'Are there areas where content is packed too tightly? Dense layouts feel stressful even when individual pieces look fine.'],
						['Layout Structure', 'Do elements line up with each other? Misaligned content looks accidental, even when the design is careful.'],
						['Vertical Balance', 'Does the page draw the eye naturally downward — or does it feel top-heavy, bottom-heavy, or lopsided?'],
						['Colour Depth', 'Do your light and dark areas use slightly different tones? This small detail is what separates flat designs from ones with real visual richness.'],
					] as [title, desc]}
						<div style="display:flex;gap:12px;align-items:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;">
							<div style="width:6px;height:6px;border-radius:50%;background:#2563eb;margin-top:6px;flex-shrink:0;"></div>
							<div>
								<p style="font-size:13px;font-weight:600;color:#111;margin-bottom:4px;">{title}</p>
								<p style="font-size:12px;color:#6b7280;line-height:1.6;">{desc}</p>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else}
			<!-- Results header -->
			<div
				style="display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;"
			>
				<div>
					<p
						style="font-size:12px;font-weight:600;color:#059669;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;"
					>
						{resultMode === 'ai' ? 'AI Audit Complete' : 'Algorithmic Audit Complete'}
					</p>
					<h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;">
						Perceptual Balance Report
					</h2>
				</div>
				<button
					onclick={reset}
					style="background:#fff;border:1px solid #e5e7eb;color:#374151;font-size:13px;font-weight:500;padding:8px 16px;border-radius:10px;"
				>
					New Audit
				</button>
			</div>

			<!-- Score card -->
			<div
				style="background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px;margin-bottom:16px;display:flex;gap:28px;align-items:flex-start;"
			>
				<div style="text-align:center;flex-shrink:0;">
					<svg width="88" height="88" viewBox="0 0 88 88">
						<circle cx="44" cy="44" r="36" fill="none" stroke="#f3f4f6" stroke-width="8" />
						<circle
							cx="44"
							cy="44"
							r="36"
							fill="none"
							stroke={scoreGrade?.color}
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
							fill={scoreGrade?.color}
							font-family="Plus Jakarta Sans, Inter, sans-serif"
						>
							{result.overallScore}
						</text>
					</svg>
					<p style="font-size:12px;font-weight:600;color:{scoreGrade?.color};margin-top:4px;">
						{scoreGrade?.label}
					</p>
				</div>

				<div style="flex:1;">
					<p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:16px;">
						{result.summary}
					</p>
					<div style="display:flex;gap:8px;flex-wrap:wrap;">
						{#each [['all', 'All', '#374151'], ['critical', 'Critical', SEV.critical.color], ['warning', 'Warning', SEV.warning.color], ['info', 'Info', SEV.info.color]] as [key, label, color]}
							<button
								onclick={() => (filter = key)}
								style="padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500;border:1px solid;border-color:{filter ===
								key
									? color
									: '#e5e7eb'};background:{filter === key
									? color + '1a'
									: 'transparent'};color:{filter === key ? color : '#6b7280'};"
							>
								{label} · {counts[/** @type {keyof typeof counts} */ (key)]}
							</button>
						{/each}
					</div>
				</div>
			</div>

			<!-- Hidden source image for canvas drawing -->
			<img bind:this={imgEl} src={image} alt="" style="display:none;" />

			<!-- Annotated screenshot -->
			<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;margin-bottom:16px;">
				<div style="font-size:11px;font-weight:600;color:#9ca3af;letter-spacing:0.08em;text-transform:uppercase;padding:12px 18px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between;">
					<span>Visual Annotations</span>
					<span style="font-size:11px;color:#d1d5db;font-weight:400;text-transform:none;letter-spacing:0;">Click a region or finding to highlight</span>
				</div>
				<canvas
					bind:this={canvasEl}
					onclick={handleCanvasClick}
					style="width:100%;display:block;cursor:crosshair;background:#f9fafb;"
				></canvas>
			</div>

			<!-- Findings grouped by category -->
			<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
				{#if filter !== 'all' && counts[/** @type {keyof typeof counts} */ (filter)] === 0}
					<p style="text-align:center;color:#9ca3af;font-size:13px;padding:32px 0;">
						No findings for this filter.
					</p>
				{/if}
				{#each grouped as { catName, allInCat, filtered }}
					{#if filter === 'all' || filtered.length > 0}
						{@const cat = CATEGORY_META[catName] ?? { color: '#6b7280', short: '?', passMsg: '' }}
						<div style="background:#fff;border:1px solid #e5e7eb;border-left:3px solid {cat.color};border-radius:12px;overflow:hidden;">
							<!-- Category header -->
							<div style="display:flex;align-items:center;gap:10px;padding:11px 16px;background:#fafafa;border-bottom:1px solid #f3f4f6;">
								<div style="background:{cat.color}1a;color:{cat.color};font-size:10px;font-weight:700;letter-spacing:0.06em;padding:2px 7px;border-radius:5px;flex-shrink:0;">
									{cat.short}
								</div>
								<span style="font-size:13px;font-weight:600;color:#111;flex:1;">{catName}</span>
								{#if filtered.length > 0}
									<span style="font-size:11px;font-weight:500;color:#6b7280;">{filtered.length} {filtered.length === 1 ? 'finding' : 'findings'}</span>
								{:else}
									<span style="display:flex;align-items:center;gap:4px;font-size:11px;font-weight:600;color:#059669;">
										<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="6" stroke="#059669" stroke-width="1.2"/><polyline points="3.5,6.5 5.5,8.5 9.5,4.5" stroke="#059669" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
										Passed
									</span>
								{/if}
							</div>
							<!-- Body: findings or pass message -->
							{#if filtered.length > 0}
								{#each filtered as f, i}
									{@const sev = SEV[f.severity] ?? SEV.info}
									<div
										role="button"
										tabindex="0"
										onclick={() => (activeIdx = activeIdx === f._idx ? -1 : f._idx)}
										onkeydown={(e) => { if (e.key === 'Enter') activeIdx = activeIdx === f._idx ? -1 : f._idx; }}
										style="{i > 0 ? 'border-top:1px solid #f3f4f6;' : ''}padding:14px 16px;background:{activeIdx === f._idx ? '#f0f4ff' : 'transparent'};transition:background 0.15s;cursor:pointer;"
									>
										<div style="display:flex;align-items:flex-start;gap:12px;">
											<div
												title={Array.isArray(f.boundingBox) ? 'Click to highlight on screenshot' : 'No specific location — applies to the whole page'}
												style="flex-shrink:0;margin-top:2px;background:{Array.isArray(f.boundingBox) ? cat.color : '#d1d5db'};color:#fff;font-size:10px;font-weight:700;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;"
											>
												{f._idx + 1}
											</div>
											<div style="flex:1;min-width:0;">
												<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap;">
													<span style="font-size:11px;font-weight:600;color:{sev.color};">{sev.label}</span>
													<span style="font-size:11px;color:#d1d5db;">·</span>
													<span style="font-size:11px;color:#9ca3af;">{f.element}</span>
													<span style="font-size:11px;color:#d1d5db;margin-left:auto;">{f.id}</span>
												</div>
												<p style="font-size:13px;color:#374151;line-height:1.55;margin-bottom:8px;">{f.issue}</p>
												<div style="background:{cat.color}0d;border:1px solid {cat.color}30;border-radius:8px;padding:8px 12px;">
													<p style="font-size:12px;color:{cat.color};line-height:1.5;">
														<span style="font-weight:600;">Fix: </span>{f.recommendation}
													</p>
												</div>
											</div>
										</div>
									</div>
								{/each}
							{:else}
								<div style="padding:11px 16px;">
									<p style="font-size:12px;color:#6b7280;">{cat.passMsg ?? 'No issues found in this category.'}</p>
								</div>
							{/if}
						</div>
					{/if}
				{/each}
			</div>

			<!-- Strengths + Expert note — coming soon -->
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
				{#each ['Strengths', 'Expert Note'] as label}
					<div style="background:#fafafa;border:1px dashed #e5e7eb;border-radius:12px;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:80px;">
						<p style="font-size:11px;font-weight:700;color:#d1d5db;letter-spacing:0.08em;text-transform:uppercase;">{label}</p>
						<p style="font-size:12px;color:#d1d5db;">Coming soon</p>
					</div>
				{/each}
			</div>


		{/if}
	</main>
</div>
