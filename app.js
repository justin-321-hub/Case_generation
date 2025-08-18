// 前端邏輯（中文註解）
// - 只呼叫後端 API，不直接接觸外部 STT 供應商（金鑰放後端比較安全）
// - 上傳音檔 → 後端 /api/transcribe → 取得 { text, words: [{start,end,word}] }
// - 逐字稿可編輯、字級可調、播放時逐字同步、可下載 txt/json
// - 本版：移除字距過大、加入簡易標點復原（以停頓時間推斷），並讓標點不參與高亮

const API_BASE = (location.hostname === 'localhost')
  ? 'http://localhost:8000'
  : 'https://case-generation.onrender.com'; // ← TODO: 改為你的 Render 網域

const elFile = document.getElementById('file');
const elBtnUpload = document.getElementById('btnUpload');
const elProgress = document.getElementById('progress');
const elPlayer = document.getElementById('player');
const elTranscript = document.getElementById('transcript');
const elStats = document.getElementById('stats');
const elFontRange = document.getElementById('fontRange');
const elBtnDownloadTxt = document.getElementById('btnDownloadTxt');
const elBtnDownloadJson = document.getElementById('btnDownloadJson');

let currentWords = [];   // 保存從後端拿到的 word 級時間戳（不含自動標點）
let renderedTokens = []; // 渲染後的 token（含自動標點）
let localObjectUrl = ''; // 用於 audio 播放本地檔

function setBusy(b, msg = '') {
  elBtnUpload.disabled = b;
  elProgress.textContent = msg;
  elProgress.classList.toggle('hidden', !b && !msg);
}

/** 
 * 根據相鄰 token 的時間差自動插入標點：
 * - gap > P_SENTENCE → '。'
 * - gap > P_COMMA   → '，'
 * 產生的標點會掛在前一 token 的 end 時間點，並標記 isPunc
 */
function punctuateByGaps(words, P_SENTENCE = 0.8, P_COMMA = 0.45) {
  if (!Array.isArray(words) || !words.length) return [];
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out.push({ ...w, isPunc: false });
    const next = words[i + 1];
    const gap = next ? (next.start - w.end) : 0;
    if (gap > P_SENTENCE) {
      out.push({ text: '。', word: '。', start: w.end, end: w.end, isPunc: true });
    } else if (gap > P_COMMA) {
      out.push({ text: '，', word: '，', start: w.end, end: w.end, isPunc: true });
    }
  }
  return out;
}

/** 將 tokens 渲染到編輯區（每個 token 一個 span，不再插入任何空白字元） */
function renderTranscriptTokens(tokens, fallbackText) {
  elTranscript.innerHTML = '';
  renderedTokens = [];

  if (tokens && tokens.length) {
    const frag = document.createDocumentFragment();
    tokens.forEach((t, i) => {
      const span = document.createElement('span');
      span.className = 'word' + (t.isPunc ? ' punc' : '');
      span.textContent = t.word ?? t.text ?? '';
      if (Number.isFinite(t.start)) span.dataset.start = t.start;
      if (Number.isFinite(t.end)) span.dataset.end = t.end;
      span.dataset.idx = i;

      // 點擊跳播（標點跳播無效）
      if (!t.isPunc) {
        span.addEventListener('click', () => {
          if (!isNaN(t.start)) elPlayer.currentTime = t.start + 0.001;
        });
      }
      frag.appendChild(span);
      // ⚠️ 重要：不要 append 空白文字節點，避免中文字之間出現多餘間距
    });
    elTranscript.appendChild(frag);

    // 統計：不含標點的 token 數
    const cnt = tokens.filter(t => !t.isPunc).length;
    elStats.textContent = `字數：${cnt}（含自動標點）`;
    renderedTokens = tokens;
  } else if (fallbackText) {
    elTranscript.textContent = fallbackText;
    elStats.textContent = `字數：約 ${fallbackText.length}`;
    renderedTokens = [];
  } else {
    elStats.textContent = '';
  }
}

/** 播放時逐字高亮（忽略標點） */
function bindTimeupdate() {
  elPlayer.addEventListener('timeupdate', () => {
    const t = elPlayer.currentTime;
    const spans = elTranscript.querySelectorAll('.word');
    let active = -1;

    for (let i = 0; i < spans.length; i++) {
      if (spans[i].classList.contains('punc')) continue; // 跳過標點
      const s = parseFloat(spans[i].dataset.start);
      const e = parseFloat(spans[i].dataset.end);
      if (!isNaN(s) && !isNaN(e) && t >= s && t <= e) { active = i; break; }
    }
    spans.forEach((sp, i) => sp.classList.toggle('active', i === active));
    if (active >= 0) spans[active].scrollIntoView({ behavior: 'smooth', block: 'center' });
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

// 綁定事件：用 CSS 變數控制字級（父層 font-size:0，不受影響）
elFontRange.addEventListener('input', () => {
  elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
});

elBtnDownloadTxt.addEventListener('click', () => {
  // 從渲染的 token 重建文本（不插空白，標點自然相連）
  const spans = Array.from(elTranscript.querySelectorAll('.word'));
  const text = spans.map(s => s.textContent).join('').replace(/\s+/g, '').trim();
  if (!text) return alert('目前沒有逐字稿內容');
  downloadText('transcript.txt', text);
});

elBtnDownloadJson.addEventListener('click', () => {
  // 導出目前畫面上的 tokens（含標點），保留原來的時間戳
  const edited = Array.from(elTranscript.querySelectorAll('.word')).map(span => ({
    start: parseFloat(span.dataset.start),
    end: parseFloat(span.dataset.end),
    word: span.textContent,
    isPunc: span.classList.contains('punc')
  }));
  if (!edited.length && !elTranscript.innerText.trim()) {
    return alert('目前沒有逐字稿內容');
  }
  downloadJSON('transcript_with_timestamps.json', { words: edited, note: '含自動標點（由時間差推斷），標點時間對齊前一字的 end。' });
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

    // 1) 先用規則依停頓加上基本標點
    const tokensWithPunc = punctuateByGaps(currentWords);

    // 2) 渲染（若沒有 word，退而使用全文純文字）
    renderTranscriptTokens(tokensWithPunc.length ? tokensWithPunc : [], text || '');
  } catch (e) {
    console.error(e);
    alert(e.message || '轉錄發生錯誤');
  } finally {
    setBusy(false, '');
  }
});

// 初始化：把滑桿初值寫入 CSS 變數
(function init() {
  elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
  bindTimeupdate();
})();
