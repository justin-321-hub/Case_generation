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
    const span = elTranscript.querySelector(`.word[data-idx="${tokenIdx}"]`
