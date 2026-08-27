require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';
const RUNWAY_KEY = process.env.RUNWAYML_API_SECRET;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'novato2026';

// Runway caps how many generations an account may run at once. Submitting every
// photo at the same time just parks the extras in a THROTTLED queue, where they
// used to burn their whole timeout without ever rendering. Keep a small number
// in flight instead, and wait for a slot before submitting the next.
const RUNWAY_CONCURRENCY = Number(process.env.RUNWAY_CONCURRENCY || 2);
// Time a task may spend queued (PENDING/THROTTLED) before we give up on it...
const RUNWAY_QUEUE_TIMEOUT_MS = Number(process.env.RUNWAY_QUEUE_TIMEOUT_MS || 15 * 60 * 1000);
// ...and time it may spend actually rendering (RUNNING) once it gets a slot.
// These are separate on purpose: queue waits say nothing about whether the clip
// itself is stuck, so a single combined clock made slow queues look like failures.
const RUNWAY_RENDER_TIMEOUT_MS = Number(process.env.RUNWAY_RENDER_TIMEOUT_MS || 10 * 60 * 1000);

if (!RUNWAY_KEY) {
  console.error('Missing RUNWAYML_API_SECRET in environment. Set it before starting the server.');
}

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION — this is likely why a request came back empty:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION — this is likely why a request came back empty:', err);
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 15 * 1024 * 1024, files: 15 } // 15MB/photo, up to 15 rooms
});

// --- Simple shared-password gate (not real auth, just keeps stray links from burning credits) ---
function requirePassword(req, res, next) {
  const provided = req.headers['x-site-password'] || (req.body && req.body.password);
  if (provided === SITE_PASSWORD) return next();
  return res.status(401).json({ error: 'Incorrect password' });
}

// --- Room-type prompt library: keeps output consistent without the user writing prompts ---
const ROOM_PROMPTS = {
  exterior: 'Slow, smooth forward camera glide toward the house, subtle parallax, no people, no camera shake, cinematic real estate establishing shot',
  living: 'Slow forward camera glide into the living room, gentle motion, no people, no furniture movement, warm cinematic real estate look',
  kitchen: 'Slow forward camera glide across the kitchen, gentle motion, no people, no object movement, bright cinematic real estate look',
  primary_bedroom: 'Slow forward camera glide into the primary bedroom, gentle motion, no people, calm cinematic real estate look',
  bedroom: 'Slow forward camera glide into the bedroom, gentle motion, no people, calm cinematic real estate look',
  bathroom: 'Slow forward camera glide across the bathroom, gentle motion, no people, bright cinematic real estate look',
  dining: 'Slow forward camera glide across the dining room, gentle motion, no people, warm cinematic real estate look',
  outdoor: 'Slow forward camera glide across the backyard, gentle motion, no people, natural light, cinematic real estate look',
  other: 'Slow, smooth forward camera glide through the room, gentle motion, no people, no camera shake, cinematic real estate look'
};

const ROOM_LABELS = {
  exterior: 'Exterior / Front',
  living: 'Living Room',
  kitchen: 'Kitchen',
  primary_bedroom: 'Primary Bedroom',
  bedroom: 'Bedroom',
  bathroom: 'Bathroom',
  dining: 'Dining Room',
  outdoor: 'Backyard / Outdoor',
  other: 'Other'
};

function promptFor(roomType) {
  return ROOM_PROMPTS[roomType] || ROOM_PROMPTS.other;
}

// "clip 3 (Kitchen)" — so an error names the photo the user has to look at.
function clipLabel(index, roomType) {
  return `clip ${index + 1} (${ROOM_LABELS[roomType] || 'Other'})`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Runs `worker` over `items`, at most `limit` at a time. Every item is attempted
// even if an earlier one throws; results come back in the input order so callers
// can tell which clip failed.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

// --- Runway calls ---
async function createImageToVideoTask(base64DataUri, promptText) {
  const res = await fetch(`${RUNWAY_API_BASE}/image_to_video`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNWAY_KEY}`,
      'X-Runway-Version': RUNWAY_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptImage: base64DataUri,
      promptText,
      ratio: '1280:720',
      duration: 5
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Runway task creation failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return data.id;
}

async function getTask(taskId) {
  const res = await fetch(`${RUNWAY_API_BASE}/tasks/${taskId}`, {
    headers: {
      'Authorization': `Bearer ${RUNWAY_KEY}`,
      'X-Runway-Version': RUNWAY_VERSION
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Runway task status check failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// Polls one task to completion. The render clock only starts once Runway reports
// RUNNING, so time spent queued behind other generations can't be mistaken for a
// stuck render. Every status change is logged so the Render logs show whether a
// slow clip was THROTTLED (waiting for a slot) or RUNNING (actually generating).
async function pollTask(taskId, { label = '', jobId = '', intervalMs = 4000 } = {}) {
  const queuedAt = Date.now();
  let runningAt = null;
  let lastStatus = null;
  const tag = `[${jobId}] Runway task ${taskId}${label ? ' — ' + label : ''}`;

  for (;;) {
    const data = await getTask(taskId);

    if (data.status !== lastStatus) {
      lastStatus = data.status;
      console.log(`${tag}: ${data.status}`);
      if (data.status === 'RUNNING' && runningAt === null) runningAt = Date.now();
    }

    if (data.status === 'SUCCEEDED') return data.output && data.output[0];
    if (data.status === 'FAILED' || data.status === 'CANCELLED') {
      throw new Error(`Runway ${label || 'task'} ${data.status === 'CANCELLED' ? 'was cancelled' : 'failed'} `
        + `(task ${taskId}): ${data.failure || data.failureCode || 'no reason given'}`);
    }

    const waitedSec = Math.round((Date.now() - queuedAt) / 1000);
    if (runningAt !== null) {
      if (Date.now() - runningAt > RUNWAY_RENDER_TIMEOUT_MS) {
        throw new Error(`Runway ${label || 'task'} was still rendering after `
          + `${Math.round(RUNWAY_RENDER_TIMEOUT_MS / 1000)}s (task ${taskId}, status ${lastStatus}). `
          + `If it finishes later you can still fetch it with Recover clips.`);
      }
    } else if (Date.now() - queuedAt > RUNWAY_QUEUE_TIMEOUT_MS) {
      throw new Error(`Runway ${label || 'task'} never started rendering — it sat in Runway's `
        + `queue for ${waitedSec}s at status ${lastStatus} (task ${taskId}). This usually means the `
        + `account's concurrent-generation limit is full. If it finishes later you can still fetch `
        + `it with Recover clips.`);
    }

    await sleep(intervalMs);
  }
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// --- Text-safe motion: pure ffmpeg pan/zoom (Ken Burns), no regeneration ---
// Preserves every pixel of the original photo exactly (including any overlaid
// text/graphics), unlike Runway which redraws the frame and can distort or
// drop text. Also free — no API cost per clip.
async function panZoomClip(imagePath, outputPath, { durationSec = 5, fps = 25, zoomTo = 1.3, direction = 'in' } = {}) {
  const frames = durationSec * fps;
  const zoomExpr = direction === 'in'
    ? `min(zoom+${((zoomTo - 1) / frames).toFixed(6)},${zoomTo})`
    : `if(eq(on,0),${zoomTo},max(zoom-${((zoomTo - 1) / frames).toFixed(6)},1))`;

  // Cap the upscale target at 2400px wide (was 8000) regardless of the source
  // photo's resolution — this is the main memory fix. A 12MP staged photo
  // scaled to 8000px wide before zoompan could push past Render's free-tier
  // 512MB RAM limit and crash the container mid-request, which is what was
  // producing the truncated/empty response on the frontend.
  await execFileAsync('ffmpeg', [
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-vf', `scale=w='min(2400,iw*3)':h=-1,zoompan=z='${zoomExpr}':d=${frames}:s=1280x720:fps=${fps}`,
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-threads', '1',
    '-pix_fmt', 'yuv420p',
    outputPath
  ], { maxBuffer: 1024 * 1024 * 20 });
}

// --- Stitching ---
async function stitchClips(clipPaths, outputPath) {
  const listPath = outputPath.replace('.mp4', '_list.txt');
  const listContent = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outputPath
  ]);

  fs.unlinkSync(listPath);
}

// --- Routes ---
app.post('/api/generate-tour', requirePassword, upload.array('photos', 15), async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(__dirname, 'temp', jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Clips that made it. Kept outside the try so the failure path can still hand
  // back work that was already paid for instead of deleting it.
  const completed = [];   // { index, roomType, motion, path, taskId }
  const failures = [];    // { index, roomType, motion, error, taskId }

  try {
    const roomTypes = JSON.parse(req.body.roomTypes || '[]'); // array aligned with req.files order
    // motionTypes[i] is 'pan' (free, text-safe, default) or 'ai' (Runway, paid, no on-photo text)
    const motionTypes = JSON.parse(req.body.motionTypes || '[]');
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    console.log(`[${jobId}] Starting job with ${files.length} photos`);

    const aiIndices = [];
    const panIndices = [];
    files.forEach((f, i) => {
      (((motionTypes[i] || 'pan') === 'ai') ? aiIndices : panIndices).push(i);
    });

    const clipPathFor = i => path.join(jobDir, `clip_${String(i).padStart(2, '0')}.mp4`);

    // 1. Pan/zoom clips first: they're free, local, and can't fail on someone
    // else's queue, so getting them done means a later Runway problem still
    // leaves something to hand back. One at a time — each ffmpeg process is
    // memory-heavy enough that running several at once can OOM a small instance.
    for (const index of panIndices) {
      const roomType = roomTypes[index] || 'other';
      try {
        const clipPath = clipPathFor(index);
        await panZoomClip(files[index].path, clipPath);
        completed.push({ index, roomType, motion: 'pan', path: clipPath });
        console.log(`[${jobId}] Generated pan/zoom ${clipLabel(index, roomType)}`);
      } catch (err) {
        failures.push({ index, roomType, motion: 'pan', error: err.message });
        console.error(`[${jobId}] Failed pan/zoom ${clipLabel(index, roomType)}: ${err.message}`);
      }
    }

    // 2. Runway clips, at most RUNWAY_CONCURRENCY in flight. Each slot submits
    // its own task and polls it to completion before taking the next photo, so
    // nothing is created only to sit throttled in Runway's queue.
    if (aiIndices.length) {
      console.log(`[${jobId}] ${aiIndices.length} AI clip(s), ${RUNWAY_CONCURRENCY} at a time`);
    }
    await runWithConcurrency(aiIndices, RUNWAY_CONCURRENCY, async (index) => {
      const roomType = roomTypes[index] || 'other';
      const label = clipLabel(index, roomType);
      let taskId = null;
      try {
        const imageBuffer = fs.readFileSync(files[index].path);
        const mimeType = files[index].mimetype || 'image/jpeg';
        const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
        taskId = await createImageToVideoTask(dataUri, promptFor(roomType));
        console.log(`[${jobId}] Submitted ${label} as Runway task ${taskId}`);

        const videoUrl = await pollTask(taskId, { label, jobId });
        const clipPath = clipPathFor(index);
        await downloadFile(videoUrl, clipPath);
        completed.push({ index, roomType, motion: 'ai', path: clipPath, taskId });
        console.log(`[${jobId}] Downloaded ${label}`);
      } catch (err) {
        failures.push({ index, roomType, motion: 'ai', error: err.message, taskId });
        console.error(`[${jobId}] Failed ${label}: ${err.message}`);
      }
    });

    if (completed.length === 0) {
      return res.status(500).json({
        error: failures.map(f => f.error).join(' | ') || 'No clips were generated',
        failures: failures.map(describeFailure)
      });
    }

    // 3. Stitch in original photo order.
    completed.sort((a, b) => a.index - b.index);
    const partial = failures.length > 0;
    const outputFileName = `tour_${jobId}${partial ? '_partial' : ''}.mp4`;
    const outputPath = path.join(__dirname, 'outputs', outputFileName);
    await stitchClips(completed.map(c => c.path), outputPath);

    // On a partial run, also keep each finished clip on its own. The tour is
    // missing rooms, but every clip in it was generated (and for AI clips, paid
    // for) and shouldn't be thrown away because a sibling timed out.
    const keptClips = partial ? preserveClips(jobId, completed) : [];

    console.log(`[${jobId}] Done: ${outputFileName}`
      + (partial ? ` (partial — ${completed.length} of ${completed.length + failures.length} clips)` : ''));

    res.json({
      success: true,
      partial,
      videoUrl: `/outputs/${outputFileName}`,
      clipCount: completed.length,
      requestedCount: completed.length + failures.length,
      failures: failures.map(describeFailure),
      clips: keptClips
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    // Even on an unexpected error, hand back whatever finished.
    const keptClips = preserveClips(jobId, completed);
    res.status(500).json({
      error: err.message,
      failures: failures.map(describeFailure),
      clips: keptClips
    });
  } finally {
    // Uploaded originals always go; temp clips have been copied out by now.
    if (req.files) req.files.forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path));
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

function describeFailure(f) {
  return {
    clip: f.index + 1,
    room: ROOM_LABELS[f.roomType] || 'Other',
    motion: f.motion,
    taskId: f.taskId || null,
    error: f.error
  };
}

// Copies finished clips out of the scratch job dir into outputs/ so they survive
// the cleanup below and can be downloaded individually.
function preserveClips(jobId, completed) {
  const kept = [];
  for (const c of [...completed].sort((a, b) => a.index - b.index)) {
    try {
      if (!fs.existsSync(c.path)) continue;
      const name = `clip_${jobId}_${String(c.index).padStart(2, '0')}.mp4`;
      fs.copyFileSync(c.path, path.join(__dirname, 'outputs', name));
      kept.push({
        clip: c.index + 1,
        room: ROOM_LABELS[c.roomType] || 'Other',
        motion: c.motion,
        taskId: c.taskId || null,
        url: `/outputs/${name}`
      });
    } catch (err) {
      console.error(`[${jobId}] Could not preserve clip ${c.index}: ${err.message}`);
    }
  }
  return kept;
}

// Pull already-generated clips back out of Runway by task ID. A task that
// finished after this server stopped waiting is still sitting on Runway's side,
// already paid for — this fetches it rather than regenerating it. Runway expires
// output URLs after a while, so this only works for reasonably recent tasks.
app.post('/api/recover-clips', requirePassword, async (req, res) => {
  const taskIds = (Array.isArray(req.body.taskIds) ? req.body.taskIds : String(req.body.taskIds || '')
    .split(/[\s,]+/))
    .map(t => String(t).trim())
    .filter(Boolean)
    .slice(0, 15);

  if (taskIds.length === 0) return res.status(400).json({ error: 'No task IDs given' });

  const results = [];
  for (const taskId of taskIds) {
    try {
      const data = await getTask(taskId);
      if (data.status !== 'SUCCEEDED') {
        results.push({
          taskId,
          status: data.status,
          error: data.status === 'FAILED' || data.status === 'CANCELLED'
            ? `Task ${data.status.toLowerCase()} on Runway's side — nothing to recover.`
            : `Still ${data.status} on Runway — try again in a minute.`
        });
        continue;
      }
      const url = data.output && data.output[0];
      if (!url) {
        results.push({ taskId, status: data.status, error: 'Task succeeded but returned no video URL (the output may have expired).' });
        continue;
      }
      const name = `recovered_${taskId}.mp4`;
      await downloadFile(url, path.join(__dirname, 'outputs', name));
      console.log(`[recover] Recovered task ${taskId}`);
      results.push({ taskId, status: data.status, url: `/outputs/${name}` });
    } catch (err) {
      console.error(`[recover] ${taskId}: ${err.message}`);
      results.push({ taskId, error: err.message });
    }
  }

  // If several came back, offer them stitched in the order given as well.
  const recovered = results.filter(r => r.url);
  let stitchedUrl = null;
  if (recovered.length > 1) {
    try {
      const name = `recovered_${uuidv4()}.mp4`;
      await stitchClips(
        recovered.map(r => path.join(__dirname, 'outputs', path.basename(r.url))),
        path.join(__dirname, 'outputs', name)
      );
      stitchedUrl = `/outputs/${name}`;
    } catch (err) {
      console.error(`[recover] Stitch failed: ${err.message}`);
    }
  }

  res.json({ results, stitchedUrl, recoveredCount: recovered.length });
});

app.post('/api/check-password', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listing video tour app running on port ${PORT}`));
