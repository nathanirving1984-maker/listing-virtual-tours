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
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No photos uploaded' });
    }

    console.log(`[${jobId}] Starting job with ${files.length} photos`);

    // 1. Kick off all Runway tasks in parallel
    const taskPromises = files.map(async (file, i) => {
      const roomType = roomTypes[i] || 'other';
      const imageBuffer = fs.readFileSync(file.path);
      const mimeType = file.mimetype || 'image/jpeg';
      const dataUri = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      const taskId = await createImageToVideoTask(dataUri, promptFor(roomType));
      console.log(`[${jobId}] Started Runway task ${taskId} for room ${i} (${roomType})`);
      return { index: i, taskId, roomType };
    });

    const tasks = await Promise.all(taskPromises);

    // 2. Poll each task and download the resulting clip, in original order
    const clipPaths = new Array(tasks.length);
    await Promise.all(tasks.map(async ({ index, taskId }) => {
      const videoUrl = await pollTask(taskId);
      const clipPath = path.join(jobDir, `clip_${String(index).padStart(2, '0')}.mp4`);
      await downloadFile(videoUrl, clipPath);
      clipPaths[index] = clipPath;
      console.log(`[${jobId}] Downloaded clip ${index}`);
    }));

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
