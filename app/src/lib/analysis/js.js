/**
 * JavaScript Analysis Module
 * Analyzes JavaScript code, frameworks, performance, and errors
 */

/**
 * Extracts and analyzes JavaScript from a page using Puppeteer
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Object>} JavaScript analysis results
 */
export async function extractAndAnalyzeJS(page) {
	// Set up console message capture
	const consoleMessages = [];
	const consoleErrors = [];
	const consoleWarnings = [];

	page.on('console', msg => {
		const text = msg.text();
		const type = msg.type();
		if (type === 'error') consoleErrors.push(text);
		else if (type === 'warning') consoleWarnings.push(text);
		else consoleMessages.push({ type, text });
	});

	// Set up page error capture
	const pageErrors = [];
	page.on('pageerror', error => {
		pageErrors.push({
			message: error.message,
			stack: error.stack,
		});
	});

	// Wait a bit for JS to execute and errors to surface
	await new Promise(r => setTimeout(r, 1000));

	const jsData = await page.evaluate(() => {
		const results = {
			frameworks: {
				react: typeof window.React !== 'undefined' || !!document.querySelector('[data-reactroot], [data-reactid]'),
				vue: typeof window.Vue !== 'undefined' || !!document.querySelector('[data-v-]'),
				angular: typeof window.angular !== 'undefined' || !!document.querySelector('[ng-app], [ng-controller]'),
				svelte: !!document.querySelector('[class^="svelte-"]'),
				jquery: typeof window.jQuery !== 'undefined' || typeof window.$ !== 'undefined',
				nextjs: typeof window.__NEXT_DATA__ !== 'undefined',
				nuxt: typeof window.__NUXT__ !== 'undefined',
			},
			scripts: [],
			eventListeners: 0,
			globalVariables: 0,
			cookiesCount: 0,
			localStorage: 0,
			sessionStorage: 0,
			serviceWorker: 'serviceWorker' in navigator,
			webWorkers: typeof Worker !== 'undefined',
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

		// Extract script tags (keep all — they're document-level, affect entire page)
		document.querySelectorAll('script').forEach(script => {
			results.scripts.push({
				src: script.src || null,
				inline: !script.src,
				async: script.async,
				defer: script.defer,
				type: script.type || 'text/javascript',
				size: script.textContent ? script.textContent.length : 0,
			});
		});

		// Count event listeners (rough approximation) — ONLY from visible elements
		const elementsWithHandlers = document.querySelectorAll('[onclick], [onload], [onchange], [onsubmit]');
		results.eventListeners = Array.from(elementsWithHandlers).filter(el => isInViewport(el)).length;

		// Count global variables (non-standard properties on window)
		const standardProps = new Set([
			'window', 'self', 'document', 'name', 'location', 'history', 'customElements',
			'locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar', 'toolbar',
			'status', 'closed', 'frames', 'length', 'top', 'opener', 'parent', 'frameElement',
			'navigator', 'origin', 'external', 'screen', 'innerWidth', 'innerHeight',
			'scrollX', 'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport',
			'screenX', 'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio',
			'console', 'performance', 'crypto', 'localStorage', 'sessionStorage',
			'indexedDB', 'caches', 'WebAssembly', 'Intl', 'Atomics', 'SharedArrayBuffer',
		]);

		for (const prop in window) {
			if (!standardProps.has(prop) && typeof window[prop] !== 'function') {
				results.globalVariables++;
			}
		}

		// Storage usage
		try {
			results.localStorage = window.localStorage ? window.localStorage.length : 0;
			results.sessionStorage = window.sessionStorage ? window.sessionStorage.length : 0;
			results.cookiesCount = document.cookie.split(';').filter(c => c.trim()).length;
		} catch (e) {
			// Storage might be blocked
		}

		return results;
	});

	// Add captured console messages and errors
	jsData.consoleErrors = consoleErrors;
	jsData.consoleWarnings = consoleWarnings;
	jsData.pageErrors = pageErrors;

	// Analyze the extracted JavaScript data
	return analyzeJS(jsData);
}

/**
 * Analyzes extracted JavaScript data for patterns, performance, and issues
 * @param {Object} jsData - Extracted JavaScript data
 * @returns {Object} Analysis results with findings
 */
function analyzeJS(jsData) {
	const findings = [];
	const strengths = [];

	// Detect frameworks
	const detectedFrameworks = Object.entries(jsData.frameworks)
		.filter(([_, detected]) => detected)
		.map(([name]) => name);

	if (detectedFrameworks.length > 0) {
		strengths.push(`Modern framework${detectedFrameworks.length !== 1 ? 's' : ''} detected: ${detectedFrameworks.join(', ')}.`);
	}

	// Check for multiple competing frameworks
	const majorFrameworks = detectedFrameworks.filter(f => ['react', 'vue', 'angular', 'svelte'].includes(f));
	if (majorFrameworks.length > 1) {
		findings.push({
			category: 'Code Quality',
			severity: 'warning',
			issue: `Multiple major frameworks detected (${majorFrameworks.join(', ')}). Running multiple frameworks on the same page increases bundle size and complexity.`,
			recommendation: 'Consolidate to a single framework unless you have a specific reason for using multiple (like a gradual migration).',
		});
	}

	// Check script count
	const externalScripts = jsData.scripts.filter(s => s.src).length;
	const inlineScripts = jsData.scripts.filter(s => s.inline).length;
	const totalScripts = jsData.scripts.length;

	if (totalScripts > 40) {
		findings.push({
			category: 'Performance',
			severity: 'warning',
			issue: `${totalScripts} script tags found (${externalScripts} external, ${inlineScripts} inline). Too many scripts can significantly slow page load.`,
			recommendation: 'Bundle and minify scripts. Consider code splitting to load only what is needed per page.',
		});
	}

	// Check for scripts without async/defer
	const blockingScripts = jsData.scripts.filter(s => s.src && !s.async && !s.defer).length;
	if (blockingScripts > 3) {
		findings.push({
			category: 'Performance',
			severity: 'warning',
			issue: `${blockingScripts} external scripts are loaded without async or defer attributes. These block HTML parsing and delay page rendering.`,
			recommendation: 'Add async or defer attributes to external scripts. Use defer for scripts that depend on DOM, async for independent scripts.',
		});
	}

	const EXTENSION_PATTERNS = [
		/chrome-extension:/i,
		/moz-extension:/i,
		/extensions\//i,
		/^uncaught \(in promise\)/i,
	];
	const THIRD_PARTY_PATTERNS = [
		/googletagmanager/i,
		/google-analytics/i,
		/analytics/i,
		/doubleclick/i,
		/facebook/i,
		/twitter/i,
	];
	const isLikelyFirstPartyError = (msg) => {
		if (!msg || typeof msg !== 'string') return false;
		return !EXTENSION_PATTERNS.some(p => p.test(msg)) && !THIRD_PARTY_PATTERNS.some(p => p.test(msg));
	};
	const firstPartyConsoleErrors = (jsData.consoleErrors || []).filter(isLikelyFirstPartyError);

	// Check console errors
	if (firstPartyConsoleErrors.length > 0) {
		findings.push({
			category: 'Code Quality',
			severity: 'critical',
			issue: `${firstPartyConsoleErrors.length} first-party JavaScript error${firstPartyConsoleErrors.length !== 1 ? 's' : ''} logged to console. Errors can break functionality and degrade user experience.`,
			recommendation: `Fix these errors: ${firstPartyConsoleErrors.slice(0, 3).join('; ')}${firstPartyConsoleErrors.length > 3 ? '...' : ''}`,
		});
	}

	// Check console warnings
	if (jsData.consoleWarnings.length > 5) {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: `${jsData.consoleWarnings.length} JavaScript warnings in console. While not critical, warnings indicate potential issues.`,
			recommendation: 'Review and address console warnings to maintain code quality.',
		});
	}

	// Check page errors
	if (jsData.pageErrors.length > 0) {
		findings.push({
			category: 'Code Quality',
			severity: 'critical',
			issue: `${jsData.pageErrors.length} uncaught JavaScript error${jsData.pageErrors.length !== 1 ? 's' : ''}: ${jsData.pageErrors[0].message}`,
			recommendation: 'Add try-catch blocks and error boundaries to handle errors gracefully.',
		});
	}

	// Check global variable pollution
	if (jsData.globalVariables > 20) {
		findings.push({
			category: 'Code Quality',
			severity: 'info',
			issue: `${jsData.globalVariables} custom global variables detected. Too many globals can cause naming conflicts and make debugging harder.`,
			recommendation: 'Use modules, closures, or IIFE patterns to avoid polluting the global namespace.',
		});
	}

	// Check storage usage
	if (jsData.localStorage > 0 || jsData.sessionStorage > 0) {
		strengths.push(`Client-side storage is being used (localStorage: ${jsData.localStorage} items, sessionStorage: ${jsData.sessionStorage} items).`);
	}

	// Check for service worker (PWA feature)
	if (jsData.serviceWorker) {
		strengths.push('Service Worker support detected — the site may be a Progressive Web App.');
	}

	// Check cookies
	if (jsData.cookiesCount > 10) {
		findings.push({
			category: 'Performance',
			severity: 'info',
			issue: `${jsData.cookiesCount} cookies detected. Cookies are sent with every request, increasing bandwidth usage.`,
			recommendation: 'Review cookie usage and remove unnecessary ones. Consider using localStorage for client-only data.',
		});
	}

	// Check inline script size
	const largeInlineScripts = jsData.scripts.filter(s => s.inline && s.size > 5000);
	if (largeInlineScripts.length > 0) {
		findings.push({
			category: 'Performance',
			severity: 'info',
			issue: `${largeInlineScripts.length} large inline script${largeInlineScripts.length !== 1 ? 's' : ''} detected (>5KB). Large inline scripts prevent browser caching.`,
			recommendation: 'Move large inline scripts to external files so they can be cached across page loads.',
		});
	}

	// Check for chart/data visualization libraries
	const chartLibraries = {
		'Chart.js': /chart\.js|chartjs/i,
		'D3.js': /\bd3\.js\b|d3\.min\.js|d3@/i,
		'Highcharts': /highcharts/i,
		'Plotly': /plotly/i,
		'ApexCharts': /apexcharts/i,
		'ECharts': /echarts/i,
		'Recharts': /recharts/i,
	};

	const detectedChartLibs = [];
	jsData.scripts.forEach(script => {
		if (script.src) {
			Object.entries(chartLibraries).forEach(([name, pattern]) => {
				if (pattern.test(script.src) && !detectedChartLibs.includes(name)) {
					detectedChartLibs.push(name);
				}
			});
		}
	});

	if (detectedChartLibs.length > 0) {
		strengths.push(`Data visualization libraries detected: ${detectedChartLibs.join(', ')} — used for charts and graphs.`);
	}

	// Check for icon libraries
	const iconLibraries = {
		'Font Awesome': /font-?awesome|fa-|fontawesome/i,
		'Material Icons': /material-icons|materialicons/i,
		'Feather Icons': /feather-?icons/i,
		'Ionicons': /ionicons/i,
		'Bootstrap Icons': /bootstrap-?icons/i,
		'Heroicons': /heroicons/i,
	};

	const detectedIconLibs = [];
	jsData.scripts.forEach(script => {
		if (script.src) {
			Object.entries(iconLibraries).forEach(([name, pattern]) => {
				if (pattern.test(script.src) && !detectedIconLibs.includes(name)) {
					detectedIconLibs.push(name);
				}
			});
		}
	});

	if (detectedIconLibs.length > 0) {
		strengths.push(`Icon libraries detected: ${detectedIconLibs.join(', ')} — provides consistent icon set.`);
	}

	return {
		jsData,
		findings,
		strengths,
		summary: `Analyzed ${jsData.scripts.length} scripts with ${detectedFrameworks.length > 0 ? detectedFrameworks.join(', ') : 'no frameworks'} detected.`,
	};
}
