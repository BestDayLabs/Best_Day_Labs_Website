/* Keys — interactive falling-tiles player synced to the song's audio.
   Real MIDI notes (sustain-trimmed in the build), play/pause, scrub, speed,
   note names. Audio-synced when an audio URL is present; visual-only otherwise. */
(function () {
  const ROLL_BG = "#0F0F0F", KB_BG = "#0C0C0C", WHITE = "#E8E8E8", BLACK = "#161616";
  const LEFT = "#22D3EE", RIGHT = "#818CF8", WINDOW = 3.4;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const noteName = (m) => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const fmt = (s) => { s = Math.max(0, s | 0); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function rr(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  function init(root) {
    const canvas = root.querySelector("canvas.pianoroll");
    let data; try { data = JSON.parse(root.querySelector('script[type="application/json"]').textContent); } catch { return; }
    const raw = (data && data.notes) || [];
    if (!raw.length) { root.style.display = "none"; return; }
    const notes = raw.map((n) => ({ m: n[0], on: n[1], off: Math.max(n[2], n[1] + 0.08) }));
    const dur = (data.duration || notes.reduce((a, n) => Math.max(a, n.off), 0)) + 0.2;
    // Always render a full ~61-key piano (C2–C7). Extend by whole octaves only
    // if the song reaches beyond it, so notes are never dropped.
    const songLo = Math.min(...notes.map((n) => n.m)), songHi = Math.max(...notes.map((n) => n.m));
    let lo = 36, hi = 96;
    if (songLo < lo) lo = Math.max(21, Math.floor(songLo / 12) * 12);
    if (songHi > hi) hi = Math.min(108, Math.ceil((songHi + 1) / 12) * 12);

    const ctx = canvas.getContext("2d");
    let W = 0, H = 0, kbH = 0, keys = {}, ww = 0;
    function layout() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      kbH = Math.max(40, Math.min(62, H * 0.19));
      const whites = []; for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
      ww = W / whites.length; keys = {}; let i = 0;
      for (let m = lo; m <= hi; m++) if (!isBlack(m)) { keys[m] = { x: i * ww, w: ww }; i++; }
      for (let m = lo; m <= hi; m++) if (isBlack(m)) { const x = keys[m - 1] ? keys[m - 1].x + keys[m - 1].w * 0.62 : 0; keys[m] = { x, w: ww * 0.66, b: true }; }
    }

    function draw(t) {
      const rollH = H - kbH, showNames = ww > 15;
      ctx.fillStyle = ROLL_BG; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255,255,255,0.022)";
      for (let m = lo; m <= hi; m++) { const k = keys[m]; if (k && !k.b) ctx.fillRect(k.x, 0, k.w - 1, rollH); }
      const pressed = {};
      for (const n of notes) {
        if (n.off < t || n.on > t + WINDOW) { if (n.on <= t && n.off > t) pressed[n.m] = n.m < 60; continue; }
        const k = keys[n.m]; if (!k) continue;
        const yb = rollH * (1 - (n.on - t) / WINDOW), yt = rollH * (1 - (n.off - t) / WINDOW);
        const top = Math.min(yb, yt), h = Math.max(3, Math.abs(yb - yt));
        ctx.fillStyle = n.m < 60 ? LEFT : RIGHT; rr(ctx, k.x + 1, top, Math.max(2, k.w - 2), h, 3); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.22)"; rr(ctx, k.x + 1, top, Math.max(2, k.w - 2), Math.min(3, h), 2); ctx.fill();
        if (showNames && h > 13) {
          const fs = Math.min(11, Math.max(8, ww * 0.4));
          ctx.font = "700 " + fs + "px -apple-system,BlinkMacSystemFont,sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
          const tx = k.x + k.w / 2, ty = Math.min(top + h - 4, rollH - 3);
          ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.strokeText(noteName(n.m), tx, ty);
          ctx.fillStyle = "#fff"; ctx.fillText(noteName(n.m), tx, ty);
        }
        if (n.on <= t && n.off > t) pressed[n.m] = n.m < 60;
      }
      ctx.fillStyle = KB_BG; ctx.fillRect(0, rollH, W, kbH);
      for (let m = lo; m <= hi; m++) { const k = keys[m]; if (!k || k.b) continue; ctx.fillStyle = m in pressed ? (pressed[m] ? LEFT : RIGHT) : WHITE; ctx.fillRect(k.x + 0.5, rollH + 2, k.w - 1, kbH - 2); }
      for (let m = lo; m <= hi; m++) { const k = keys[m]; if (!k || !k.b) continue; ctx.fillStyle = m in pressed ? (pressed[m] ? LEFT : RIGHT) : BLACK; ctx.fillRect(k.x, rollH + 2, k.w, kbH * 0.62); }
      // Mark every C key with its octave label (C2, C3, … middle C = C4).
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.font = "600 " + Math.min(10, Math.max(7, ww * 0.42)) + "px -apple-system,BlinkMacSystemFont,sans-serif";
      ctx.fillStyle = "rgba(17,24,39,0.62)";
      for (let m = lo; m <= hi; m++) {
        if (((m % 12) + 12) % 12 !== 0) continue;   // C
        const k = keys[m]; if (!k) continue;
        ctx.fillText("C" + (Math.floor(m / 12) - 1), k.x + k.w / 2, rollH + kbH - 5);
      }
      ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fillRect(0, rollH, W, 1);
    }

    // Transport — audio-synced when available, else an internal clock.
    let audio = null;
    if (data.audio) {
      audio = new Audio(); audio.preload = "none"; audio.src = data.audio;
      audio.preservesPitch = audio.mozPreservesPitch = audio.webkitPreservesPitch = true;
      audio.addEventListener("error", () => { audio = null; });   // fall back to visual
      audio.addEventListener("play", () => { pp && (pp.textContent = "❚❚"); });
      audio.addEventListener("pause", () => { pp && (pp.textContent = "▶"); });
    }
    const pp = root.querySelector(".pp"), seek = root.querySelector(".seek"), timeEl = root.querySelector(".time");
    let clockT = 0, rate = 1, playing = false, visible = false, last = 0, raf = 0, scrub = false;

    const now = () => audio ? Math.min(audio.currentTime, dur) : clockT;
    function render() {
      const t = now();
      draw(t);
      if (seek && !scrub) seek.value = String(Math.round((t / dur) * 1000));
      if (timeEl) timeEl.textContent = fmt(t) + " / " + fmt(dur);
    }
    function frame(ts) {
      if (!visible) { raf = 0; return; }
      const dt = last ? (ts - last) / 1000 : 0; last = ts;
      if (audio) { if (audio.currentTime >= dur && !audio.paused) audio.pause(); }
      else if (playing && !scrub) { clockT += dt * rate; if (clockT >= dur) clockT = 0; }
      render(); raf = requestAnimationFrame(frame);
    }
    const kick = () => { if (!raf && visible) { last = 0; raf = requestAnimationFrame(frame); } };

    function play() {
      if (audio) { if (audio.currentTime >= dur - 0.05) audio.currentTime = 0; audio.playbackRate = rate; audio.play().catch(() => {}); }
      else { playing = true; pp && (pp.textContent = "❚❚"); }
      kick();
    }
    function pause() { if (audio) audio.pause(); else { playing = false; pp && (pp.textContent = "▶"); } }
    const isPlaying = () => audio ? !audio.paused : playing;

    if (pp) pp.addEventListener("click", () => (isPlaying() ? pause() : play()));
    if (seek) {
      seek.addEventListener("input", () => { scrub = true; const t = (seek.value / 1000) * dur; if (audio) audio.currentTime = t; else clockT = t; render(); });
      seek.addEventListener("change", () => { scrub = false; });
    }
    root.querySelectorAll(".speeds button").forEach((b) => b.addEventListener("click", () => {
      rate = parseFloat(b.dataset.s); if (audio) audio.playbackRate = rate;
      root.querySelectorAll(".speeds button").forEach((x) => x.classList.toggle("on", x === b));
    }));

    layout(); render();
    new ResizeObserver(() => { layout(); render(); }).observe(canvas);
    new IntersectionObserver((es) => es.forEach((e) => {
      visible = e.isIntersecting;
      if (visible) { if (!audio && !playing && clockT === 0) play(); else kick(); }  // autoplay visual only
      else if (audio && !audio.paused) audio.pause();
    }), { threshold: 0.25 }).observe(canvas);
    document.addEventListener("visibilitychange", () => { if (document.hidden) { visible = false; if (audio) audio.pause(); } else { visible = true; kick(); } });
  }

  function boot() { document.querySelectorAll(".player").forEach(init); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
