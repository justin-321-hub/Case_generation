/**
 * 後端（Render）：Node/Express 代理 → 呼叫 AssemblyAI 雲端 API
 * 目的：
 *  - 隱藏金鑰（放在後端環境變數）
 *  - 前端僅需呼叫 /api/transcribe，上傳音檔即可
 * 流程：
 *  1) 前端以 multipart/form-data 上傳 audio 檔到 /api/transcribe
 *  2) 後端把檔案 buffer 直接串流到 AssemblyAI /v2/upload
 *  3) 建立轉錄工作 /v2/transcribe
 *  4) 輪詢狀態直到完成，回傳 { text, words:[{start,end,word}] }
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { setTimeout: sleep } = require('timers/promises');

// node-fetch v3 為 ESM，這裡用動態 import 避免改成 type:module
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
const upload = multer({ limits: { fileSize: 100 * 1024 * 1024 } }); // 上限 100MB，可依需求調整

// ====== 讀環境變數 ======
const PORT = process.env.PORT || 8000;
const AAI_API_KEY = process.env.AAI_API_KEY || ''; // ← 在 Render 設定
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',');

// ====== CORS：建議正式上線時把 * 改為你的 GH Pages 網域 ======
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  }
}));

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ====== 將檔案 buffer 直接上傳至 AssemblyAI /v2/upload ======
async function aaiUpload(buffer) {
  const resp = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      authorization: AAI_API_KEY,
      // 使用 chunked 可避免需先知檔案大小；node-fetch 會處理
      'transfer-encoding': 'chunked'
    },
    body: buffer
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Upload failed: ${resp.status} ${t}`);
  }
  const data = await resp.json();
  // data.upload_url 形如 https://cdn.assemblyai.com/upload/xxxx
  return data.upload_url;
}

// ====== 建立轉錄任務 ======
async function aaiCreateTranscription(uploadUrl) {
  // 這裡可依需求開啟更多功能（如 speaker_labels、entity detection 等）
  const payload = {
    audio_url: uploadUrl,
    language_detection: true,
    punctuate: true,
    format_text: true
  };
  const resp = await fetch('https://api.assemblyai.com/v2/transcribe', {
    method: 'POST',
    headers: {
      authorization: AAI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Create transcription failed: ${resp.status} ${t}`);
  }
  return resp.json(); // { id: "..." }
}

// ====== 輪詢直到完成 ======
async function aaiPoll(id) {
  while (true) {
    const resp = await fetch(`https://api.assemblyai.com/v2/transcribe/${id}`, {
      headers: { authorization: AAI_API_KEY }
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Poll failed: ${resp.status} ${t}`);
    }
    const data = await resp.json();
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(data.error || 'Transcription error');
    // 2 秒輪詢一次，避免太頻繁
    await sleep(2000);
  }
}

// ====== 主要端點：接收音檔並回傳逐字稿 ======
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!AAI_API_KEY) return res.status(500).json({ error: '後端未設定 AAI_API_KEY' });
    if (!req.file) return res.status(400).json({ error: '請以 audio 欄位上傳音檔' });

    const uploadUrl = await aaiUpload(req.file.buffer);
    const task = await aaiCreateTranscription(uploadUrl);
    const done = await aaiPoll(task.id);

    // 統一輸出格式：words: [{start,end,word}]；start/end 由毫秒轉為秒（float）
    const words = (done.words || []).map(w => ({
      start: (w.start ?? 0) / 1000,
      end:   (w.end ?? 0) / 1000,
      word:  w.text
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
