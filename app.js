// 前端邏輯（中文註解）
// - 上傳音檔 → 先向 /api/preview-clean 取得「降噪後音檔」供 <audio> 播放
// - 同時呼叫 /api/transcribe → 取得 { text, words: [{start,end,word}] }
// - 逐字稿可編輯、字級可調、播放時逐字同步（標點不高亮）、可下載 txt/json
// - 效能優化：播放時用二分搜尋定位 active token

const API_BASE = (location.hostname === 'localhost')
  ? 'http://localhost:8000'
  : 'https://case-generation.onrender.com'; // ← 你的 Render 網域

const elFile = document.getElementById('file');
const elBtnUpload = document.getElementById('btnUpload');
const elProgress = document.getElementById('progress');
const elPlayer = document.getElementById('player');
const elTranscript = document.getElementById('transcript');
const elStats = document.getElementById('stats');
const elFontRange = document.getElementById('fontRange');
const elBtnDownloadTxt = document.getElementById('btnDownloadTxt');
const elBtnDownloadJson = document.getElementById('btnDownloadJson');

let currentWords = [];     // 後端回來的 word 級時間戳（不含自動標點）
let renderedTokens = [];   // 渲染後的 token（含自動標點）
let localObjectUrl = '';   // 本地 audio 物件網址
let idxMapNonPunc = [];    // 非標點 span 的索引清單（供二分搜尋）
let lastActiveIdx = -1;    // 上一個高亮的 span 索引

function setBusy(b, msg = '') {
  elBtnUpload.disabled = b;
  elProgress.textContent = msg || '';
  elProgress.classList.toggle('hidden', !b && !msg);
}

/**
 * 依相鄰 token 的時間差自動插入標點（中文）：
 * - gap > P_SENTENCE → '。'（或依末字推斷 '？'）
 * - gap > P_COMMA   → '，'
 * 標點掛在前一 token 的 end 時間點，並標記 isPunc
 */
function punctuateByGaps(words, P_SENTENCE = 0.8, P_COMMA = 0.45) {
  if (!Array.isArray(words) || !words.length) return [];
  const isQuestionish = ch => /[嗎呢嘛？]/.test(ch);
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const char = (w.word ?? w.text ?? '').toString();
    out.push({ ...w, word: char, isPunc: false });
    const next = words[i + 1];
    const gap = next ? (next.start - w.end) : 0;

    if (gap > P_SENTENCE) {
      const endPunc = isQuestionish(char) ? '？' : '。';
      out.push({ text: endPunc, word: endPunc, start: w.end, end: w.end, isPunc: true });
    } else if (gap > P_COMMA) {
      out.push({ text: '，', word: '，', start: w.end, end: w.end, isPunc: true });
    }
  }
  return out;
}

/** 將 tokens 渲染到編輯區（每個 token 一個 span，不插入任何空白字元） */
function renderTranscriptTokens(tokens, fallbackText) {
  elTranscript.innerHTML = '';
  renderedTokens = [];
  idxMapNonPunc = [];
  lastActiveIdx = -1;

  if (tokens && tokens.length) {
    const frag = document.createDocumentFragment();
    tokens.forEach((t, i) => {
      const span = document.createElement('span');
      span.className = 'word' + (t.isPunc ? ' punc' : '');
      span.textContent = t.word ?? t.text ?? '';
      if (Number.isFinite(t.start)) span.dataset.start = t.start;
      if (Number.isFinite(t.end)) span.dataset.end = t.end;
      span.dataset.idx = i;

      if (!t.isPunc) {
        // 點擊跳播
        span.addEventListener('click', () => {
          if (!isNaN(t.start)) elPlayer.currentTime = t.start + 0.001;
        });
        // 建立非標點索引表
        idxMapNonPunc.push(i);
      }
      frag.appendChild(span);
      // ⚠️ 不要在 span 之間插 textNode(' ')，以免中文字間距過大
    });
    elTranscript.appendChild(frag);

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

/** 使用二分搜尋在非標點 token 中找出當前時間落點 */
function findActiveIndexByTime(t) {
  if (!idxMapNonPunc.length) return -1;
  let lo = 0, hi = idxMapNonPunc.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tokenIdx = idxMapNonPunc[mid];
    const span = elTranscript.querySelector(`.word[data-idx="${tokenIdx}"]`);
    if (!span) break;
    const s = parseFloat(span.dataset.start);
    const e = parseFloat(span.dataset.end);
    if (isNaN(s) || isNaN(e)) {
      lo = mid + 1;
      continue;
    }
    if (t < s) hi = mid - 1;
    else if (t > e) lo = mid + 1;
    else return tokenIdx;
  }
  return -1;
}

/** 播放時逐字高亮（忽略標點，效能優化） */
function bindTimeupdate() {
  let ticking = false;
  elPlayer.addEventListener('timeupdate', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const t = elPlayer.currentTime;
      const active = findActiveIndexByTime(t);
      if (active !== lastActiveIdx) {
        // 先移除舊的
        if (lastActiveIdx >= 0) {
          const prev = elTranscript.querySelector(`.word[data-idx="${lastActiveIdx}"]`);
          if (prev) prev.classList.remove('active');
        }
        // 再加新的
        if (active >= 0) {
          const cur = elTranscript.querySelector(`.word[data-idx="${active}"]`);
          if (cur && !cur.classList.contains('punc')) {
            cur.classList.add('active');
            cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
        lastActiveIdx = active;
      }
      ticking = false;
    });
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

// 字級調整：用 CSS 變數控制（父層 font-size:0，不受影響）
elFontRange.addEventListener('input', () => {
  elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
});

// 下載 .txt：用畫面上的 tokens 串回字串（不插空白，標點自然連接）
elBtnDownloadTxt.addEventListener('click', () => {
  const spans = Array.from(elTranscript.querySelectorAll('.word'));
  const text = spans.map(s => s.textContent).join('').replace(/\s+/g, '').trim();
  if (!text) return alert('目前沒有逐字稿內容');
  downloadText('transcript.txt', text);
});

// 下載 .json：輸出畫面 tokens（含 isPunc 與原時間戳）
elBtnDownloadJson.addEventListener('click', () => {
  const edited = Array.from(elTranscript.querySelectorAll('.word')).map(span => ({
    start: parseFloat(span.dataset.start),
    end: parseFloat(span.dataset.end),
    word: span.textContent,
    isPunc: span.classList.contains('punc')
  }));
  if (!edited.length && !elTranscript.innerText.trim()) {
    return alert('目前沒有逐字稿內容');
  }
  downloadJSON('transcript_with_timestamps.json', {
    words: edited,
    note: '含自動標點（由時間差推斷；問句啟發式），標點時間對齊前一字的 end。'
  });
});

elBtnUpload.addEventListener('click', async () => {
  const f = elFile.files?.[0];
  if (!f) { alert('請先選擇音訊檔'); return; }

  // 1) 播放「乾淨檔」
  try {
    const fdClean = new FormData();
    fdClean.append('audio', f);
    const respClean = await fetch(`${API_BASE}/api/preview-clean`, { method: 'POST', body: fdClean });
    if (!respClean.ok) throw new Error('取得乾淨音檔失敗');
    const buf = await respClean.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/wav' });
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = URL.createObjectURL(blob);
    elPlayer.src = localObjectUrl;
  } catch (e) {
    console.error(e);
    alert('播放乾淨檔失敗，改播原始檔');
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = URL.createObjectURL(f);
    elPlayer.src = localObjectUrl;
  }

  // 2) 照舊呼叫轉錄（必要時可帶 speaker_labels）
  setBusy(true, '上傳與轉錄中…（視檔案大小可能 10 秒～數十秒）');
  try {
    const fd = new FormData();
    fd.append('audio', f);
    // 若要開講者標記，解除下一行註解：
    // fd.append('speaker_labels', '1');

    const resp = await fetch(`${API_BASE}/api/transcribe`, { method: 'POST', body: fd });
    if (!resp.ok) throw new Error('轉錄失敗，請稍後再試');
    const { text, words } = await resp.json();

    currentWords = Array.isArray(words) ? words.map(w => ({
      start: Number(w.start),
      end: Number(w.end),
      word: (w.word ?? w.text ?? '').toString()
    })) : [];

    const tokensWithPunc = punctuateByGaps(currentWords);
    renderTranscriptTokens(tokensWithPunc.length ? tokensWithPunc : [], (text || '').toString());
  } catch (e) {
    console.error(e);
    alert(e.message || '轉錄發生錯誤');
  } finally {
    setBusy(false, '');
  }
});

// 初始化
(function init() {
  elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
  bindTimeupdate();
})();
