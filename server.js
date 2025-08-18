/**
 * 後端（Render）：Node/Express 代理 → 呼叫 AssemblyAI 雲端 API
 * 流程：
 *  1) 前端上傳 multipart/form-data：欄位名 audio（可選欄位 speaker_labels=1）
 *  2) 後端先用 ffmpeg-static 做「不改時長」的降噪
 *  3) 把處理後的檔案串流到 AAI /v2/upload 取得 upload_url
 *  4) 建立轉錄工作到 AAI /v2/transcript（可選 speaker_labels）
 *  5) 輪詢直到完成，回傳 { text, words:[{start,end,word}], utterances? }
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { setTimeout: sleep } = require('timers/promises');

// node-fetch v3 為 ESM，這裡用動態 import
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ====== ffmpeg（不改時長的降噪） ======
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

/**
 * 用 ffmpeg 做基本降噪與標準化，不改變時長：
 * - 單聲道 16k（多數 ASR 最穩）
 * - 高通 60Hz（去低頻轟隆）
 * - 頻域降噪（afftdn）適度降低底噪
 * - 正常化音量（避免太小聲）
 */
async function denoiseToWav(buffer) {
  return new Promise((resolve, reject) => {
    const args = [
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
    ];
    const ff = spawn(ffmpegPath, args);
    const chunks = [];
    ff.stdout.on('data', d => chunks.push(d));
    ff.stderr.on('data', () => {}); // 需要除錯可列印
    ff.on('error', reject);
    ff.on('close', code => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error('ffmpeg failed with code ' + code));
    });
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB 可調整

// ====== 讀環境變數 ======
const PORT = process.env.PORT || 8000;
const AAI_API_KEY = process.env.AAI_API_KEY || ''; // ← 到 Render 設定
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ====== CORS：上線時把 * 改為你的 Pages 網域 ======
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // 允許 curl / 健康檢查
      if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    optionsSuccessStatus: 200,
  })
);
app.options('*', cors()); // 處理 preflight

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ====== 上傳到 AssemblyAI /v2/upload，取得 upload_url ======
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
    // 常見：401/403 = API Key 錯；413 = 檔案過大；5xx = 供應商暫時錯誤
    throw new Error(`Upload failed: ${resp.status} ${t}`);
  }
  const data = await resp.json(); // { upload_url: "..." }
  return data.upload_url;
}

// ====== 建立轉錄任務（/v2/transcript） ======
async function aaiCreateTranscription(uploadUrl, opts = {}) {
  const payload = {
    audio_url: uploadUrl,
    language_detection: true,
    punctuate: true,
    format_text: true,
    // 其他可選：speech_model, disfluencies, entity_detection...
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
  return resp.json(); // { id: "..." }
}

// ====== 輪詢狀態直到完成（/v2/transcript/{id}） ======
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
    await sleep(2000); // 2 秒輪詢一次
  }
}

// ====== 新增端點：回傳降噪後的檔案，供前端播放 ======
app.post('/api/preview-clean', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '請以上傳 audio 檔案' });

    let processed = null;
    try {
      processed = await denoiseToWav(req.file.buffer);
    } catch (e) {
      console.warn('[denoise] failed, fallback to original buffer:', e?.message || e);
      processed = req.file.buffer;
    }

    res.setHeader('Content-Type', 'audio/wav');
    res.send(processed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '產生乾淨音檔失敗' });
  }
});

// ====== 主要端點：接音檔並回傳逐字稿 ======
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!AAI_API_KEY) return res.status(500).json({ error: '後端未設定 AAI_API_KEY' });
    if (!req.file) return res.status(400).json({ error: '請以 audio 欄位上傳音檔' });

    const wantSpeaker = req.body && (req.body.speaker_labels === '1' || req.body.speaker_labels === 'true');

    // 1) 先做「不改時長」的降噪；失敗則退回原始檔
    let processed = null;
    try {
      processed = await denoiseToWav(req.file.buffer);
    } catch (e) {
      console.warn('[denoise] failed, fallback to original buffer:', e?.message || e);
      processed = req.file.buffer;
    }

    // 2) 上傳（使用處理後的 Buffer）
    const uploadUrl = await aaiUpload(processed);

    // 3) 建立任務（可選講者分離）
    const task = await aaiCreateTranscription(uploadUrl, { speaker_labels: wantSpeaker });

    // 4) 等待完成
    const done = await aaiPoll(task.id);

    // 5) words 為毫秒，轉成秒（float）
    const words = (done.words || []).map(w => ({
      start: (w.start ?? 0) / 1000,
      end: (w.end ?? 0) / 1000,
      word: w.text,
    }));

    res.json({
      text: done.text || '',
      words,
      utterances: Array.isArray(done.utterances) ? done.utterances : undefined
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '轉錄發生錯誤' });
  }
});

// ====== 啟動 ======
app.listen(PORT, () => {
  console.log(`API proxy listening on http://0.0.0.0:${PORT}`);
});
