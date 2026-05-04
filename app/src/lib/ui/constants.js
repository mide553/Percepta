/** @type {Record<string, { color: string; darkColor: string; short: string; passMsg: string }>} */
export const CATEGORY_META = {
    'Readability': { color: '#d97706', darkColor: '#fbbf24', short: 'RD', passMsg: 'Text contrast and legibility are comfortable across the page.' },
    'Visual Weight': { color: '#7c3aed', darkColor: '#c4b5fd', short: 'VW', passMsg: 'Visual weight is well-balanced and centred across the layout.' },
    'Visual Hierarchy': { color: '#059669', darkColor: '#34d399', short: 'VH', passMsg: 'Information hierarchy is clearly defined.' },
    'Typography': { color: '#0284c7', darkColor: '#38bdf8', short: 'TY', passMsg: 'Line lengths are within a comfortable reading range.' },
    'Colour Palette': { color: '#c026d3', darkColor: '#e879f9', short: 'CP', passMsg: 'Colour variety, tonal range, and temperature feel appropriate and intentional.' },
    'Spacing & Layout': { color: '#0891b2', darkColor: '#22d3ee', short: 'SL', passMsg: 'Spacing feels consistent and content groups are clearly separated.' },
    'Interactive Targets': { color: '#059669', darkColor: '#34d399', short: 'IT', passMsg: 'Tap targets are well-sized and spaced apart to prevent accidental activations.' },
    'Icon & Image Size': { color: '#ea580c', darkColor: '#fb923c', short: 'IS', passMsg: 'Images and icons are large enough to convey meaning clearly.' },
    'Layout Order': { color: '#6366f1', darkColor: '#a5b4fc', short: 'LO', passMsg: 'Content column widths are consistent and well-aligned.' },
    // legacy keys kept for backward compat
    'Optical Overshoot': { color: '#db2777', darkColor: '#f9a8d4', short: 'OO', passMsg: '' },
};

export const CATEGORY_ORDER = [
    'Readability',
    'Visual Weight',
    'Visual Hierarchy',
    'Typography',
    'Colour Palette',
    'Spacing & Layout',
    'Interactive Targets',
    'Icon & Image Size',
    'Layout Order',
];

export const SEV = {
    critical: { label: 'Critical', color: '#ef4444', darkColor: '#fca5a5' },
    warning: { label: 'Warning', color: '#f59e0b', darkColor: '#fcd34d' },
    info: { label: 'Info', color: '#6b7280', darkColor: '#9ca3af' },
};

export const LOADING_STEPS = [
    'Opening the page in a browser...',
    'Taking a screenshot...',
    'Reading page structure and styles...',
    'Sending to AI for analysis...',
    'Compiling report...'
];

export const ALGO_LOADING_STEPS = [
    'Opening the page in a browser...',
    'Taking a screenshot...',
    'Reading page structure and styles...',
    'Checking text contrast...',
    'Measuring visual balance...',
    'Analysing colour palette...',
    'Checking spacing and layout...',
    'Generating heatmap overlay...',
    'Compiling report...'
];

export const COMPARE_LOADING_STEPS = [
    'Opening the page in a browser...',
    'Taking a screenshot...',
    'Reading page structure and styles...',
    'Running algorithmic analysis...',
    'Sending screenshot to AI...',
    'Waiting for AI analysis...',
    'Finding gaps and differences...',
    'Compiling comparison report...'
];

export const COMPARE_ALGO_AI_LOADING_STEPS = [
    'Opening the page in a browser...',
    'Taking a screenshot...',
    'Reading page structure and styles...',
    'Running algorithmic analysis...',
    'Generating heatmap overlay...',
    'Sending screenshot to AI...',
    'Waiting for AI analysis...',
    'Finding gaps and differences...',
    'Compiling comparison report...'
];

export const ALGO_AI_LOADING_STEPS = [
    'Opening the page in a browser...',
    'Taking a screenshot...',
    'Reading page structure and styles...',
    'Running algorithmic checks...',
    'Generating heatmap overlay...',
    'Writing plain-language findings...',
    'Polishing report language...',
    'Compiling report...'
];
