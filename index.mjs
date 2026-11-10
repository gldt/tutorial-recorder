/**
 * Record captioned how-to videos of a web app with Playwright.
 *
 * A tutorial signs in off camera (optionally), then records a fresh browser
 * context so the video opens on the app itself. Headless video has no mouse
 * pointer, so an injected overlay draws one, plus a caption bar and a
 * highlight ring around whatever is about to be clicked. Each recording is
 * saved as .webm and, when ffmpeg is installed, copied to an H.264 .mp4.
 * Given a `voice`, the .mp4 is also narrated: each caption is read aloud by a
 * text-to-speech engine, and the caption holds until the voice finishes.
 *
 *   const recorder = createRecorder({ baseUrl, outputDir, login });
 *   const { page, finish } = await recorder.startRecording('my-tutorial');
 *   await say(page, 'Hello!');
 *   await click(page, page.getByRole('link', { name: 'Settings' }));
 *   await finish();
 *
 * HEADED=1 in the environment shows the browser while it records. VOICE=0
 * records silently; VOICE=macos or VOICE=elevenlabs switches the engine.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Narration state for each recording page: its voice, when recording began, and the clips said so far. */
const narrations = new WeakMap();

/**
 * Runs in every page before its scripts: installs the pointer, caption bar and
 * highlight ring, and exposes window.__tutorial for the helpers below.
 * `hideSelectors` are hidden outright, e.g. a debug toolbar.
 */
function installOverlay(hideSelectors) {
    const ensure = () => {
        if (window.__tutorial || !document.body) {
            return;
        }

        const style = document.createElement('style');
        style.textContent = `
            #tut-cursor { position: fixed; z-index: 2147483647; pointer-events: none; width: 22px; height: 22px;
                margin: -3px 0 0 -3px; transition: transform .1s; }
            #tut-cursor.down { transform: scale(.8); }
            #tut-ring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #f59e0b;
                border-radius: 10px; box-shadow: 0 0 0 6px rgba(245, 158, 11, .25); opacity: 0; transition: all .25s; }
            #tut-caption { position: fixed; z-index: 2147483645; pointer-events: none; left: 50%; bottom: 28px;
                transform: translateX(-50%); max-width: 880px; padding: 14px 22px; border-radius: 12px;
                background: rgba(15, 23, 42, .92); color: #fff; font: 500 19px/1.45 system-ui, sans-serif;
                text-align: center; box-shadow: 0 10px 30px rgba(0, 0, 0, .3); opacity: 0; transition: opacity .3s; }
            ${hideSelectors.length ? `${hideSelectors.join(', ')} { display: none !important; }` : ''}
        `;
        document.head.appendChild(style);

        const cursor = document.createElement('div');
        cursor.id = 'tut-cursor';
        cursor.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.5-8L21 10z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
        const ring = document.createElement('div');
        ring.id = 'tut-ring';
        const caption = document.createElement('div');
        caption.id = 'tut-caption';
        document.body.append(ring, caption, cursor);

        const place = (x, y) => {
            cursor.style.left = `${x}px`;
            cursor.style.top = `${y}px`;
        };

        // Carry the pointer across full page loads so it doesn't jump to a corner.
        try {
            const saved = JSON.parse(sessionStorage.getItem('tut-cursor') ?? 'null');
            saved ? place(saved.x, saved.y) : place(innerWidth / 2, innerHeight / 2);
        } catch {
            place(innerWidth / 2, innerHeight / 2);
        }

        document.addEventListener('mousemove', (event) => {
            place(event.clientX, event.clientY);
            try {
                sessionStorage.setItem('tut-cursor', JSON.stringify({ x: event.clientX, y: event.clientY }));
            } catch {}
        }, true);
        document.addEventListener('mousedown', () => cursor.classList.add('down'), true);
        document.addEventListener('mouseup', () => cursor.classList.remove('down'), true);

        window.__tutorial = {
            caption(text) {
                // Hiding keeps the old text so it fades out rather than collapsing to an empty pill.
                if (text) {
                    caption.textContent = text;
                }
                caption.style.opacity = text ? '1' : '0';
            },
            ring(box) {
                if (!box) {
                    ring.style.opacity = '0';

                    return;
                }
                const pad = 6;
                Object.assign(ring.style, {
                    left: `${box.x - pad}px`, top: `${box.y - pad}px`,
                    width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`, opacity: '1',
                });
            },
        };
    };

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', ensure) : ensure();
}

/**
 * Set up recording for one app.
 *
 * @param {object} options
 * @param {string} options.outputDir  where videos are written
 * @param {(page: import('playwright').Page) => Promise<void>} [options.login]
 *        signs in off camera; the session it leaves is reused for the recording
 * @param {{ width: number, height: number }} [options.viewport]  default 1280x800
 * @param {string[]} [options.hideSelectors]  elements to hide in every video
 * @param {boolean} [options.ignoreHTTPSErrors]  default true, for local dev certificates
 * @param {'macos'|'elevenlabs'|{ engine: 'macos', name?: string }|{ engine: 'elevenlabs', voiceId?: string, model?: string }} [options.voice]
 *        narrates every caption; leave out for silent videos
 * @param {string} [options.cacheDir]  where narration clips are kept between runs,
 *        default `<outputDir>/.voice-cache`
 */
export function createRecorder({
    outputDir,
    login,
    viewport = { width: 1280, height: 800 },
    hideSelectors = [],
    ignoreHTTPSErrors = true,
    voice,
    cacheDir = join(outputDir, '.voice-cache'),
}) {
    const narrator = createNarrator(voice, cacheDir);

    return {
        /**
         * Open a page that records to `<outputDir>/<name>.webm`, signed in
         * through `login` unless { signedIn: false }. Call finish() when done;
         * it returns the path of the .mp4, or of the .webm without ffmpeg.
         *
         * @returns {Promise<{ page: import('playwright').Page, finish: () => Promise<string> }>}
         */
        async startRecording(name, { signedIn = true } = {}) {
            const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
            let storageState;

            if (signedIn && login) {
                const loginContext = await browser.newContext({ viewport, ignoreHTTPSErrors });
                await login(await loginContext.newPage());
                storageState = await loginContext.storageState();
                await loginContext.close();
            }

            const rawDir = join(outputDir, `.raw-${name}`);
            mkdirSync(rawDir, { recursive: true });

            const context = await browser.newContext({
                viewport,
                storageState,
                ignoreHTTPSErrors,
                recordVideo: { dir: rawDir, size: viewport },
            });
            await context.addInitScript(installOverlay, hideSelectors);
            const page = await context.newPage();
            narrations.set(page, { narrator, startedAt: performance.now(), clips: [] });

            return {
                page,
                async finish() {
                    const video = page.video();
                    await context.close();
                    const target = join(outputDir, `${name}.webm`);
                    await video.saveAs(target);
                    await browser.close();
                    rmSync(rawDir, { recursive: true, force: true });

                    return toMp4(target, narrations.get(page).clips);
                },
            };
        },
    };
}

/**
 * Copy a .webm to an H.264 .mp4 beside it, since QuickTime and most sharing
 * tools won't play .webm. Keeps the .webm either way and returns it when
 * ffmpeg isn't installed.
 *
 * `clips` are narration to mix in, each starting `atMs` into the video. If
 * mixing fails, the .mp4 is made without sound instead.
 *
 * @param {string} webm
 * @param {{ file: string, atMs: number }[]} [clips]
 */
export function toMp4(webm, clips = []) {
    const mp4 = webm.replace(/\.webm$/, '.mp4');
    const video = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart'];

    if (clips.length) {
        const delayed = clips.map((clip, i) => `[${i + 1}:a]adelay=delays=${Math.round(clip.atMs)}:all=1[a${i}]`);
        const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[narration]`;

        if (ffmpeg([
            '-i', webm, ...clips.flatMap((clip) => ['-i', clip.file]),
            '-filter_complex', [...delayed, mix].join(';'),
            '-map', '0:v', '-map', '[narration]', ...video, '-c:a', 'aac', '-b:a', '160k',
            mp4,
        ])) {
            return mp4;
        }

        console.warn(`Couldn't mix in the narration, so ${mp4} has no sound.`);
    }

    if (!ffmpeg(['-i', webm, ...video, mp4])) {
        console.warn(`Couldn't convert to .mp4 (is ffmpeg installed? brew install ffmpeg). Kept ${webm}`);

        return webm;
    }

    return mp4;
}

/** Run ffmpeg quietly, overwriting its output; true when it succeeded. */
function ffmpeg(args) {
    const result = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

    return !result.error && result.status === 0;
}

/** Wait long enough to read a caption: ~4 words a second, at least 1.8s. */
function readingTime(text) {
    return Math.max(1800, text.split(/\s+/).length * 260);
}

/**
 * Show a caption and hold on it while the viewer reads. When the recording is
 * narrated, the caption is also read aloud, and holds until the voice is done.
 *
 * The third argument is either the hold in milliseconds, or options:
 * `holdMs`, and `spoken` for text the voice should say instead of the caption,
 * e.g. to spell out a case number.
 *
 * @param {import('playwright').Page} page
 * @param {string} text
 * @param {number|{ holdMs?: number, spoken?: string }} [options]
 */
export async function say(page, text, options = {}) {
    const { holdMs = readingTime(text), spoken = text } = typeof options === 'number' ? { holdMs: options } : options;

    await page.waitForFunction(() => window.__tutorial);
    await page.evaluate((t) => window.__tutorial.caption(t), text);
    const shownAt = performance.now();
    let holdUntil = shownAt + holdMs;

    const narration = narrations.get(page);
    if (narration?.narrator) {
        try {
            const clip = await narration.narrator.clip(spoken);
            narration.clips.push({ file: clip.file, atMs: shownAt - narration.startedAt });
            holdUntil = Math.max(holdUntil, shownAt + clip.durationMs + 500);
        } catch (error) {
            console.warn(`Couldn't narrate "${spoken}": ${error.message}\nThis video will have no sound.`);
            narration.narrator = null;
            narration.clips = [];
        }
    }

    await page.waitForTimeout(Math.max(0, holdUntil - performance.now()));
}

/** Hide the caption bar and highlight ring. */
export async function clearOverlay(page) {
    await page.evaluate(() => {
        window.__tutorial?.caption(null);
        window.__tutorial?.ring(null);
    });
}

/**
 * Glide the pointer to an element and ring it. The previous caption has been
 * read by now and describes something else, so it clears while the pointer moves.
 */
export async function pointAt(page, locator, pauseMs = 700) {
    await page.evaluate(() => window.__tutorial?.caption(null));
    await locator.scrollIntoViewIfNeeded();

    // Scrolling may be smooth, so measure until the element stops moving.
    let box = await locator.boundingBox();
    for (let tries = 0; tries < 20; tries++) {
        await page.waitForTimeout(50);
        const next = await locator.boundingBox();
        if (next.x === box.x && next.y === box.y) {
            break;
        }
        box = next;
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
    await page.evaluate((b) => window.__tutorial.ring(b), box);
    await page.waitForTimeout(pauseMs);
}

/** Point at an element, then click it and clear the ring. */
export async function click(page, locator) {
    await pointAt(page, locator);
    await locator.click();
    await page.evaluate(() => window.__tutorial?.ring(null));
}

/** Click into a field and type at a human pace. */
export async function type(page, locator, text) {
    await click(page, locator);
    await locator.pressSequentially(text, { delay: 45 });
    await page.waitForTimeout(400);
}

/**
 * The first link matching `pattern` in the newest email Mailpit caught for an
 * address. Waits up to 10s for it to arrive. MAILPIT_URL overrides the
 * default http://127.0.0.1:8025.
 */
export async function mailpitLink(address, pattern) {
    const api = mailpitApi();

    for (let tries = 0; tries < 20; tries++) {
        const search = await (await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}&limit=1`)).json();
        const id = search.messages?.[0]?.ID;

        if (id) {
            const message = await (await fetch(`${api}/api/v1/message/${id}`)).json();
            const link = message.Text.match(pattern)?.[0];

            if (link) {
                return link;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`No email to ${address} with a matching link reached Mailpit at ${api}.`);
}

/** Delete every email Mailpit holds for an address, so a later search can't find a stale one. */
export async function clearMailpit(address) {
    await fetch(`${mailpitApi()}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`, { method: 'DELETE' });
}

function mailpitApi() {
    return process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
}

/**
 * Text-to-speech engines. Each writes one spoken line to an audio file;
 * `settings` lists what makes its clips differ, for the cache key.
 */
const engines = {
    /** The `say` command built into macOS. Free and offline, for drafts. */
    macos: {
        extension: 'aiff',
        problem({ name }) {
            if (process.platform !== 'darwin') {
                return 'the macos voice only works on macOS';
            }

            // `say` quietly falls back to the default voice for a name it doesn't know.
            const installed = spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? '';

            return !name || installed.split('\n').some((line) => line.startsWith(`${name} `)) ? null : `no macOS voice is named "${name}" (list them with say -v '?')`;
        },
        settings: ({ name = '' }) => [name],
        async synthesize(text, { name }, file) {
            const result = spawnSync('say', ['-o', file, ...(name ? ['-v', name] : [])], { input: text, encoding: 'utf8' });

            if (result.error || result.status !== 0) {
                throw new Error(result.error?.message ?? (result.stderr.trim() || `say exited with ${result.status}`));
            }
        },
    },

    /** ElevenLabs' hosted voices, for finished videos. Needs ELEVENLABS_API_KEY. */
    elevenlabs: {
        extension: 'mp3',
        problem: () => (process.env.ELEVENLABS_API_KEY ? null : 'ELEVENLABS_API_KEY isn\'t set'),
        settings: ({ voiceId = 'JBFqnCBsd6RMkjVDRZzb', model = 'eleven_multilingual_v2' }) => [voiceId, model],
        async synthesize(text, settings, file) {
            const [voiceId, model] = this.settings(settings);

            // A timeout, rate limit or server error is usually brief, so each gets one retry.
            for (let attempt = 1; ; attempt++) {
                const canRetry = attempt < 2;
                let response;

                try {
                    response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
                        method: 'POST',
                        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text, model_id: model }),
                        signal: AbortSignal.timeout(30000),
                    });
                } catch (error) {
                    if (canRetry) {
                        await new Promise((resolve) => setTimeout(resolve, 2000));
                        continue;
                    }

                    throw new Error(error.name === 'TimeoutError' ? 'ElevenLabs didn\'t answer within 30s' : error.message);
                }

                if (response.ok) {
                    writeFileSync(file, Buffer.from(await response.arrayBuffer()));

                    return;
                }

                if (canRetry && (response.status === 429 || response.status >= 500)) {
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }

                throw new Error(`ElevenLabs answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
            }
        },
    },
};

/**
 * The narrator for a recorder's `voice`, or null for silent videos. VOICE=0
 * in the environment turns narration off, and VOICE=<engine> switches engine.
 * Anything that would stop narration from working (no ffmpeg, no API key) is
 * reported once here, and the videos are made without sound.
 */
function createNarrator(voice, cacheDir) {
    const override = process.env.VOICE;

    if (override === '0' || (!voice && !override)) {
        return null;
    }

    const settings = { ...(typeof voice === 'string' ? { engine: voice } : voice), ...(override ? { engine: override } : {}) };
    const engine = engines[settings.engine];

    if (!engine) {
        throw new Error(`Unknown voice engine "${settings.engine}"; use one of: ${Object.keys(engines).join(', ')}.`);
    }

    const problem = engine.problem(settings)
        ?? (['ffmpeg', 'ffprobe'].every((tool) => !spawnSync(tool, ['-version']).error) ? null : 'narration needs ffmpeg (brew install ffmpeg)');

    if (problem) {
        console.warn(`Recording without narration: ${problem}.`);

        return null;
    }

    const durations = new Map();

    return {
        /**
         * The clip for a line of narration, made once and then reused from
         * the cache on later runs.
         *
         * @returns {Promise<{ file: string, durationMs: number }>}
         */
        async clip(text) {
            const key = createHash('sha256').update(JSON.stringify([settings.engine, ...engine.settings(settings), text])).digest('hex');
            const file = join(cacheDir, `${key.slice(0, 32)}.${engine.extension}`);

            if (!existsSync(file)) {
                mkdirSync(cacheDir, { recursive: true });
                // Written under another name first, so a failed run can't leave a broken clip in the cache.
                const partial = join(cacheDir, `${key.slice(0, 32)}.partial.${engine.extension}`);
                await engine.synthesize(text, settings, partial);
                renameSync(partial, file);
            }

            if (!durations.has(file)) {
                durations.set(file, audioDuration(file));
            }

            return { file, durationMs: durations.get(file) };
        },
    };
}

/** How long an audio file plays, in milliseconds. */
function audioDuration(file) {
    const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const seconds = Number.parseFloat(result.stdout);

    if (result.error || !Number.isFinite(seconds)) {
        throw new Error(`couldn't read the length of ${file}`);
    }

    return Math.round(seconds * 1000);
}
