/**
 * 後端（Render）：Node/Express 代理 → Demucs 人聲分離 → 呼叫 AssemblyAI 雲端 API
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: sleep } = require('timers/promises');

// node-fetch v3 為 ESM，這裡用動態 import
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
// ffmpeg：用於轉檔/重採樣/降噪
const ffmpegPath = require('ffmpeg-static');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

// ====== 讀環境變數 ======
const PORT = process.env.PORT || 8000;
const AAI_API_KEY = process.env.AAI_API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const DEMUCS_MODEL = process.env.DEMUCS_MODEL || 'htdemucs';
const DEMUCS_TIMEOUT_MS = +(process.env.DEMUCS_TIMEOUT_MS || 240000); // 4 分鐘

// ====== CORS ======
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  optionsSuccessStatus: 200,
}));
app.options('*', cors());

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ====== 工具：ffmpeg 封裝 ======
function ffmpegRun(args, inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', e => { err += e.toString(); });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`ffmpeg exit ${code}: ${err}`));
    });
    if (inputBuffer) {
      ff.stdin.write(inputBuffer);
      ff.stdin.end();
    }
  });
}

// 轉為 wav（雙聲道 44.1k，給 Demucs 最穩定）
async function toStereo441Wav(buffer) {
  return ffmpegRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '2',
    '-ar', '44100',
    '-f', 'wav',
    'pipe:1'
  ], buffer);
}

// 轉為 wav（單聲道 16k，給 STT）
async function toMono16kWav(buffer) {
  return ffmpegRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    'pipe:1'
  ], buffer);
}

// 溫和降噪（不改時長）→ 給 fallback 用
async function denoiseToWav(buffer) {
  return ffmpegRun([
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-ac', '1',
    '-ar', '16000',
    '-af', [
      'highpass=f=60',
      'afftdn=nf=-25:tn=1',
      'loudnorm=I=-23:TP=-2'
    ].join(','),
    '-f', 'wav',
    'pipe:1'
  ], buffer);
}

// ====== Demucs 分離人聲 ======
async function separateVocalWithDemucs(inputBuffer) {
  // 1) 先轉成 44.1k/雙聲道 wav（Demucs 理想輸入）
  const stereo = await toStereo441Wav(inputBuffer);

  // 2) 寫入暫存檔
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demucs_'));
  const inPath = path.join(tmpDir, 'input.wav');
  fs.writeFileSync(inPath, stereo);

  // 3) 執行 demucs
  const outDir = path.join(tmpDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const args = ['-m', 'demucs', '--two-stems=vocals', '-n', DEMUCS_MODEL, '-o', outDir, inPath];
  const child = spawn(PYTHON_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve('TIMEOUT');
    }, DEMUCS_TIMEOUT_MS);

    child.on('close', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  if (exitCode !== 0) {
    // 清理
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    if (exitCode === 'TIMEOUT') throw new Error('Demucs timeout');
    throw new Error(`Demucs failed (code ${exitCode}): ${stderr}`);
  }

  // 4) 讀取 vocals.wav（Demucs 會建立 out/<model>/input/vocals.wav）
  const vocalPath = path.join(outDir, DEMUCS_MODEL, 'input', 'vocals.wav');
  const vocalBuf = fs.readFileSync(vocalPath);

  // 5) 轉成 16k/單聲道給 STT
  const sttWav = await toMono16kWav(vocalBuf);

  // 同時回傳「可播放的 44.1k vocal」與「16k STT vocal」
  const playableWav = vocalBuf;

  // 清理暫存
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

  return { playableWav, sttWav };
}

// ====== AssemblyAI API ======
async function aaiUpload(buffer) {
  const resp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      authorization: AAI_API_KEY,
      'transfer-encoding': 'chunked',
    },
    body: buffer,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Upload failed: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return data.upload_url;
}

async function aaiCreateTranscription(uploadUrl, opts = {}) {
  const payload = {
    audio_url: uploadUrl,
    language_detection: true,
    punctuate: true,
    format_text: true,
  };
  if (opts.speaker_labels) payload.speaker_labels = true;

  const resp = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: AAI_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Create transcription failed: ${resp.status} ${t}`);
  }
  return resp.json();
}

async function aaiPoll(id) {
  while (true) {
    const resp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: AAI_API_KEY },
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Poll failed: ${resp.status} ${t}`);
    }
    const data = await resp.json();
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(data.error || 'Transcription error');
    await sleep(2000);
  }
}

// ====== 新：回傳分離後的 vocal（給前端播放） ======
app.post('/api/preview-vocals',
