/** @type {Record<string, { color: string; short: string; passMsg: string }>} */
export const CATEGORY_META = {
    'Perceptual Contrast': { color: '#d97706', short: 'PC', passMsg: 'Text contrast is comfortable across the page.' },
    'Optical Centering': { color: '#7c3aed', short: 'OC', passMsg: 'Visual balance looks well-centred.' },
    'Visual Hierarchy': { color: '#059669', short: 'VH', passMsg: 'Information hierarchy is clearly defined.' },
    'Typography': { color: '#0284c7', short: 'TY', passMsg: 'Line lengths are within a comfortable reading range.' },
    'Colour Palette': { color: '#c026d3', short: 'CP', passMsg: 'Colour variety feels appropriate and intentional.' },
    'Tonal Range': { color: '#2563eb', short: 'TR', passMsg: 'Good tonal variation across light and dark areas.' },
    'Colour Temperature': { color: '#db2777', short: 'CT', passMsg: 'Light and dark areas use contrasting colour temperatures, giving the palette depth.' },
    'Spacing Rhythm': { color: '#0891b2', short: 'SR', passMsg: 'Spacing feels consistent and rhythmic.' },
    // legacy keys kept for backward compat
    'Visual Center of Mass': { color: '#2563eb', short: 'VCM', passMsg: '' },
    'Optical Overshoot': { color: '#db2777', short: 'OO', passMsg: '' },
};

export const CATEGORY_ORDER = [
    'Perceptual Contrast',
    'Optical Centering',
    'Visual Hierarchy',
    'Typography',
    'Colour Palette',
    'Tonal Range',
    'Colour Temperature',
    'Spacing Rhythm',
];

export const SEV = {
    critical: { label: 'Critical', color: '#ef4444' },
    warning: { label: 'Warning', color: '#f59e0b' },
    info: { label: 'Info', color: '#6b7280' }
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
    'Compiling report...'
];
