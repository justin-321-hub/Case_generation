/**
 * 後端（Render）：Node/Express 代理 → 呼叫 AssemblyAI 雲端 API
 * 目的：
 *  - 隱藏金鑰（放在後端環境變數）
 *  - 前端僅需呼叫 /api/transcribe 上傳音檔
 * 流程：
 *  1) 前端上傳 multipart/form-data：欄位名 audio
 *  2) 後端把檔案 buffer 串流到 AAI /v2/upload 取得 upload_url
 *  3) 建立轉錄工作到 AAI /v2/transcript
 *  4) 輪詢 /v2/transcript/{id} 直到完成，回傳 { text, words:[{start,end,word}] }
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { setTimeout: sleep } = require('timers/promises');

// node-fetch v3 為 ESM，這裡用動態 import
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB 可調整

// ====== 讀環境變數 ======
const PORT = process.env.PORT || 8000;
const AAI_API_KEY = process.env.AAI_API_KEY || ''; // ← 到 Render 設定
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ====== CORS：建議上線時把 * 改為你的 Pages 網域 ======
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

// ====== 建立轉錄任務（正確 endpoint：/v2/transcript） ======
async function aaiCreateTranscription(uploadUrl) {
  const payload = {
    audio_url: uploadUrl,
    language_detection: true,
    punctuate: true,
    format_text: true,
    // 需要話者分離可加：speaker_labels: true
    // 需要特定模型可加：speech_model: "universal"（可省略使用預設）
  };
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

// ====== 輪詢狀態直到完成（正確 endpoint：/v2/transcript/{id}） ======
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

// ====== 主要端點：接音檔並回傳逐字稿 ======
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!AAI_API_KEY) return res.status(500).json({ error: '後端未設定 AAI_API_KEY' });
    if (!req.file) return res.status(400).json({ error: '請以 audio 欄位上傳音檔' });

    const uploadUrl = await aaiUpload(req.file.buffer);
    const task = await aaiCreateTranscription(uploadUrl);
    const done = await aaiPoll(task.id);

    // words 為毫秒，轉成秒（float）
    const words = (done.words || []).map(w => ({
      start: (w.start ?? 0) / 1000,
      end: (w.end ?? 0) / 1000,
      word: w.text,
    }));

    res.json({ text: done.text || '', words });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || '轉錄發生錯誤' });
  }
});

// ====== 啟動 ======
app.listen(PORT, () => {
  console.log(`API proxy listening on http://0.0.0.0:${PORT}`);
});
