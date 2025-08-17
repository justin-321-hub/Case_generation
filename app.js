// 前端邏輯（中文註解）
// - 只呼叫後端 API，不直接接觸外部 STT 供應商（金鑰放後端比較安全）
// - 上傳音檔 → 後端 /api/transcribe → 取得 { text, words: [{start,end,word}] }
// - 逐字稿可編輯、字級可調、播放時逐字同步、可下載 txt/json

// ✅ 部署時改成你的 Render 後端網域
const API_BASE = (location.hostname === 'localhost')
  ? 'http://localhost:8000'
  : 'https://YOUR-RENDER-API.onrender.com'; // ← TODO: 改為你的 Render 網域

const elFile = document.getElementById('file');
const elBtnUpload = document.getElementById('btnUpload');
const elProgress = document.getElementById('progress');
const elPlayer = document.getElementById('player');
const elTranscript = document.getElementById('transcript');
const elStats = document.getElementById('stats');
const elFontRange = document.getElementById('fontRange');
const elBtnDownloadTxt = document.getElementById('btnDownloadTxt');
const elBtnDownloadJson = document.getElementById('btnDownloadJson');

let currentWords = [];   // 保存從後端拿到的 word 級時間戳
let localObjectUrl = ''; // 用於 audio 播放本地檔

function setBusy(b, msg = '') {
  elBtnUpload.disabled = b;
  elProgress.textContent = msg;
  elProgress.classList.toggle('hidden', !b && !msg);
}

// 渲染逐字稿（每個 word 一個 span）
function renderTranscript(words, fallbackText) {
  elTranscript.innerHTML = '';
  if (words && words.length) {
    const frag = document.createDocumentFragment();
    words.forEach((w, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = w.word;
      span.dataset.start = Number.isFinite(w.start) ? w.start : '';
      span.dataset.end = Number.isFinite(w.end) ? w.end : '';
      span.dataset.idx = i;
      span.addEventListener('click', () => {
        if (!isNaN(w.start)) elPlayer.currentTime = w.start + 0.001;
      });
      frag.appendChild(span);
      frag.appendChild(document.createTextNode(' '));
    });
    elTranscript.appendChild(frag);
    elStats.textContent = `字數：${words.length}`;
  } else if (fallbackText) {
    elTranscript.textContent = fallbackText;
    elStats.textContent = `字數：約 ${fallbackText.split(/\s+/).length}`;
  } else {
    elStats.textContent = '';
  }
}

// 播放時逐字高亮
function bindTimeupdate() {
  elPlayer.addEventListener('timeupdate', () => {
    const t = elPlayer.currentTime;
    const spans = elTranscript.querySelectorAll('.word');
    let active = -1;
    for (let i = 0; i < spans.length; i++) {
      const s = parseFloat(spans[i].dataset.start);
      const e = parseFloat(spans[i].dataset.end);
      if (!isNaN(s) && !isNaN(e) && t >= s && t <= e) { active = i; break; }
    }
    spans.forEach((sp, i) => sp.classList.toggle('active', i === active));
    if (active >= 0) {
      spans[active].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// 綁定事件
elFontRange.addEventListener('input', () => {
  elTranscript.style.fontSize = `${elFontRange.value}px`;
});

elBtnDownloadTxt.addEventListener('click', () => {
  const text = elTranscript.innerText.replace(/\s+/g, ' ').trim();
  if (!text) return alert('目前沒有逐字稿內容');
  downloadText('transcript.txt', text);
});

elBtnDownloadJson.addEventListener('click', () => {
  const edited = Array.from(elTranscript.querySelectorAll('.word')).map(span => ({
    start: parseFloat(span.dataset.start),
    end: parseFloat(span.dataset.end),
    word: span.textContent
  }));
  if (!edited.length && !elTranscript.innerText.trim()) {
    return alert('目前沒有逐字稿內容');
  }
  downloadJSON('transcript_with_timestamps.json', { words: edited, note: '若使用者有編輯文字，時間戳仍為原始對應。' });
});

elBtnUpload.addEventListener('click', async () => {
  const f = elFile.files?.[0];
  if (!f) { alert('請先選擇音訊檔'); return; }

  // 用本地物件網址播放（API-only 方案：播放原檔，不經後端處理）
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  localObjectUrl = URL.createObjectURL(f);
  elPlayer.src = localObjectUrl;

  // 呼叫後端轉錄
  setBusy(true, '上傳與轉錄中…（視檔案大小約 10 秒～數十秒）');
  try {
    const fd = new FormData();
    fd.append('audio', f);
    const resp = await fetch(`${API_BASE}/api/transcribe`, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error('轉錄失敗，請稍後再試');
    const { text, words } = await resp.json();
    currentWords = words || [];
    renderTranscript(currentWords, text || '');
  } catch (e) {
    console.error(e);
    alert(e.message || '轉錄發生錯誤');
  } finally {
    setBusy(false, '');
  }
});

// 初始化
bindTimeupdate();
