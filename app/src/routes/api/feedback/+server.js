import { json } from '@sveltejs/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const DATA_FILE = join(DATA_DIR, 'feedback.json');

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    const name = typeof body.name === 'string' ? body.name.slice(0, 120).trim() : '';
    const role = typeof body.role === 'string' ? body.role.slice(0, 120).trim() : '';

    if (!comment) return json({ error: 'Comment is required' }, { status: 400 });
    if (comment.length > 2000) return json({ error: 'Comment too long (max 2000 characters)' }, { status: 400 });

    const entry = {
        ts: new Date().toISOString(),
        name: name || null,
        role: role || null,
        comment,
    };

    let entries = [];
    try {
        const raw = await readFile(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) entries = parsed;
    } catch {
        // File doesn't exist yet — start fresh
    }

    entries.push(entry);

    try {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(DATA_FILE, JSON.stringify(entries, null, 2), 'utf8');
    } catch (err) {
        console.error('[feedback] write error', err);
        return json({ error: 'Could not save feedback' }, { status: 500 });
    }

    return json({ ok: true });
}
