// 等 DOM 準備好再綁事件，避免初始化丟錯導致按鈕沒反應
window.addEventListener('DOMContentLoaded', () => {
  console.log('app.js ready');

  // 後端 API 網域
  const API_BASE = (location.hostname === 'localhost')
    ? 'http://localhost:8000'
    : 'https://case-generation.onrender.com'; // ← 改成你的 Render 網域即可

  // 便捷取 DOM
  const $ = id => document.getElementById(id);
  const elFile = $('file');
  const elBtnUpload = $('btnUpload');
  const elProgress = $('progress');
  const elPlayer = $('player');
  const elTranscript = $('transcript');
  const elStats = $('stats');
  const elFontRange = $('fontRange');
  const elBtnDownloadTxt = $('btnDownloadTxt');
  const elBtnDownloadJson = $('btnDownloadJson');

  // 全頁遮罩
  const elBlocker = $('blocker');
  const elBlockText = $('blockText');

  // 狀態
  let currentWords = [];     // 後端回來的 word 級時間戳（不含自動標點）
  let renderedTokens = [];   // 渲染後的 token（含自動標點）
  let localObjectUrl = '';   // 本地 audio 物件網址
  let idxMapNonPunc = [];    // 非標點 span 的索引清單（供二分搜尋）
  let lastActiveIdx = -1;    // 上一個高亮的 span 索引

  // Busy 狀態：禁用控制 + 顯示遮罩
  function setBusy(b, msg = '') {
    [elBtnUpload, elBtnDownloadTxt, elBtnDownloadJson, elFile, elFontRange].forEach(el => {
      if (el) el.disabled = !!b;
    });
    if (elPlayer && b) elPlayer.pause();
    if (elProgress) {
      elProgress.textContent = msg || '';
      elProgress.classList.toggle('hidden', !b && !msg);
    }
    if (elBlocker) {
      elBlocker.classList.toggle('hidden', !b);
      if (elBlockText) elBlockText.textContent = msg || '處理中…';
    }
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
    if (!elTranscript) return;
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
            if (!isNaN(t.start) && elPlayer) elPlayer.currentTime = t.start + 0.001;
          });
          // 建立非標點索引表
          idxMapNonPunc.push(i);
        }
        frag.appendChild(span);
      });
      elTranscript.appendChild(frag);

      const cnt = tokens.filter(t => !t.isPunc).length;
      if (elStats) elStats.textContent = `字數：${cnt}（含自動標點）`;
      renderedTokens = tokens;
    } else if (fallbackText) {
      elTranscript.textContent = fallbackText;
      if (elStats) elStats.textContent = `字數：約 ${fallbackText.length}`;
      renderedTokens = [];
    } else {
      if (elStats) elStats.textContent = '';
    }
  }

  /** 使用二分搜尋在非標點 token 中找出當前時間落點 */
  function findActiveIndexByTime(t) {
    if (!idxMapNonPunc.length || !elTranscript) return -1;
    let lo = 0, hi = idxMapNonPunc.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const tokenIdx = idxMapNonPunc[mid];
      const span = elTranscript.querySelector(`.word[data-idx="${tokenIdx}"]`);
      if (!span) break;
      const s = parseFloat(span.dataset.start);
      const e = parseFloat(span.dataset.end);
      if (isNaN(s) || isNaN(e)) { lo = mid + 1; continue; }
      if (t < s) hi = mid - 1;
      else if (t > e) lo = mid + 1;
      else return tokenIdx;
    }
    return -1;
  }

  /** 播放時逐字高亮（忽略標點，效能優化） */
  function bindTimeupdate() {
    if (!elPlayer) return;
    let ticking = false;
    elPlayer.addEventListener('timeupdate', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const t = elPlayer.currentTime;
        const active = findActiveIndexByTime(t);
        if (active !== lastActiveIdx && elTranscript) {
          if (lastActiveIdx >= 0) {
            const prev = elTranscript.querySelector(`.word[data-idx="${lastActiveIdx}"]`);
            if (prev) prev.classList.remove('active');
          }
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
  if (elFontRange && elTranscript) {
    elFontRange.addEventListener('input', () => {
      elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
    });
    elTranscript.style.setProperty('--fz', `${elFontRange.value}px`);
  }

  // 下載 .txt
  if (elBtnDownloadTxt) {
    elBtnDownloadTxt.addEventListener('click', () => {
      if (!elTranscript) return;
      const spans = Array.from(elTranscript.querySelectorAll('.word'));
      const text = spans.map(s => s.textContent).join('').replace(/\s+/g, '').trim();
      if (!text) return alert('目前沒有逐字稿內容');
      downloadText('transcript.txt', text);
    });
  }

  // 下載 .json
  if (elBtnDownloadJson) {
    elBtnDownloadJson.addEventListener('click', () => {
      if (!elTranscript) return;
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
  }

  // 上傳 & 播放「Demucs 分離 vocal」& 轉錄（期間顯示全頁遮罩）
  if (elBtnUpload) {
    elBtnUpload.addEventListener('click', async () => {
      const f = elFile?.files?.[0];
      if (!f) { alert('請先選擇音訊檔'); return; }

      setBusy(true, '上傳與轉錄中…（視檔案大小與分離耗時而定）');

      // 1) 播放「分離後 vocal」；失敗 → /api/preview-clean；再失敗 → 原檔
      try {
        const fdVocal = new FormData();
        fdVocal.append('audio', f);
        let respPlay = await fetch(`${API_BASE}/api/preview-vocals`, { method: 'POST', body: fdVocal });

        if (!respPlay.ok) {
          // 備援：舊的降噪預覽
          const fdClean = new FormData();
          fdClean.append('audio', f);
          respPlay = await fetch(`${API_BASE}/api/preview-clean`, { method: 'POST', body: fdClean });
        }
        if (!respPlay.ok) throw new Error('取得預覽音檔失敗');

        const buf = await respPlay.arrayBuffer();
        const blob = new Blob([buf], { type: 'audio/wav' });
        if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
        localObjectUrl = URL.createObjectURL(blob);
        if (elPlayer) elPlayer.src = localObjectUrl;
      } catch (e) {
        console.error(e);
        alert('播放預覽音檔失敗，改播原始檔');
        if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
        localObjectUrl = URL.createObjectURL(f);
        if (elPlayer) elPlayer.src = localObjectUrl;
      }

      // 2) 呼叫轉錄（Demucs → STT；必要時可帶 speaker_labels）
      try {
        const fd = new FormData();
        fd.append('audio', f);
        // 如需講者分離，解除下一行註解：
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
  }

  bindTimeupdate();
});
