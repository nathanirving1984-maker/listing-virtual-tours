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

function promptFor(roomType) {
  return ROOM_PROMPTS[roomType] || ROOM_PROMPTS.other;
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

async function pollTask(taskId, { intervalMs = 4000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
    const data = await res.json();
    if (data.status === 'SUCCEEDED') {
      return data.output && data.output[0];
    }
    if (data.status === 'FAILED') {
      throw new Error(`Runway task ${taskId} failed: ${data.failure || 'unknown reason'}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Runway task ${taskId} timed out after ${timeoutMs / 1000}s`);
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

  try {
    const roomTypes = JSON.parse(req.body.roomTypes || '[]'); // array aligned with req.files order
    // motionTypes[i] is 'pan' (free, text-safe, default) or 'ai' (Runway, paid, no on-photo text)
    const motionTypes = JSON.parse(req.body.motionTypes || '[]');
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    console.log(`[${jobId}] Starting job with ${files.length} photos`);

    const clipPaths = new Array(files.length);

    // 1. Photos flagged 'ai' go to Runway in parallel; 'pan' photos never touch the API
    const aiIndices = [];
    const panIndices = [];
    files.forEach((f, i) => {
      (((motionTypes[i] || 'pan') === 'ai') ? aiIndices : panIndices).push(i);
    });

    const aiTaskPromises = aiIndices.map(async (i) => {
      const roomType = roomTypes[i] || 'other';
      const imageBuffer = fs.readFileSync(files[i].path);
      const mimeType = files[i].mimetype || 'image/jpeg';
      const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      const taskId = await createImageToVideoTask(dataUri, promptFor(roomType));
      console.log(`[${jobId}] Started Runway task ${taskId} for room ${i} (${roomType})`);
      return { index: i, taskId };
    });
    const aiTasks = await Promise.all(aiTaskPromises);

    // Runway clips (network-bound, not memory-heavy locally) still run in parallel.
    // Pan/zoom clips run one at a time — each ffmpeg process is memory-heavy enough
    // that running several simultaneously on a small Render instance can OOM the
    // container mid-request, which is what caused the empty/truncated response.
    const runwayPromise = Promise.all(aiTasks.map(async ({ index, taskId }) => {
      const videoUrl = await pollTask(taskId);
      const clipPath = path.join(jobDir, `clip_${String(index).padStart(2, '0')}.mp4`);
      await downloadFile(videoUrl, clipPath);
      clipPaths[index] = clipPath;
      console.log(`[${jobId}] Downloaded Runway clip ${index}`);
    }));

    for (const index of panIndices) {
      const clipPath = path.join(jobDir, `clip_${String(index).padStart(2, '0')}.mp4`);
      await panZoomClip(files[index].path, clipPath);
      clipPaths[index] = clipPath;
      console.log(`[${jobId}] Generated pan/zoom clip ${index}`);
    }

    await runwayPromise;

    // 3. Stitch in original room order
    const outputFileName = `tour_${jobId}.mp4`;
    const outputPath = path.join(__dirname, 'outputs', outputFileName);
    await stitchClips(clipPaths, outputPath);

    console.log(`[${jobId}] Done: ${outputFileName}`);
    res.json({ success: true, videoUrl: `/outputs/${outputFileName}` });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up uploaded originals and temp clips
    if (req.files) req.files.forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path));
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

app.post('/api/check-password', (req, res) => {
  if (req.body.password === SITE_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listing video tour app running on port ${PORT}`));
