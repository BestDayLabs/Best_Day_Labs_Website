#!/usr/bin/env node
/**
 * Programmatic-SEO generator for Keys.
 *
 * Reads the public catalog from Supabase (anon key, RLS-protected, is_hidden=false)
 * and emits STATIC pages — nothing dynamic, nothing that touches existing files:
 *   /keys/songs/<slug>/index.html   one per song   ("How to Play X by Y on Piano")
 *   /keys/artists/<slug>/index.html one per artist  (hub that links its songs)
 *   /keys/songs/index.html          browse index
 *   /keys/sitemap.xml               sitemap of everything above
 *
 * Copyright-safe: publishes metadata + learning guidance + CTA only. No sheet
 * music, MIDI, or note data is ever written to a public page.
 *
 * Run:  node keys/_seo/generate.mjs           (full catalog)
 *       LIMIT=10 node keys/_seo/generate.mjs  (quick test)
 *
 * Re-run anytime — it overwrites the generated folders and is idempotent.
 */
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = "https://bwvxwlcpxeshagtfehrd.supabase.co";
const ANON_KEY = "sb_publishable_1mtSE1OjnTK8iVOq1WAqmg_KcxQxwc6"; // client-safe (RLS protected)
const SITE = "https://www.bestdaylabs.com";
const APP_STORE = "https://apps.apple.com/us/app/keys-play-any-song-on-piano/id6769897403";
const ICON = "/keys/KeysIcon.png";          // og:image (full)
const LOGO = "/keys/KeysIcon-128.png";      // in-page logo (optimized)
const FAVICON = "/keys/KeysIcon-48.png";

const KEYS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;

// ── helpers ───────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const slugify = (s) =>
  String(s ?? "")
    .toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "song";

const fmtDur = (sec) => {
  const s = Math.round(Number(sec) || 0);
  if (!s) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Catalog titles are mostly raw TikTok/UGC captions. Clean them to song-name
// form and only keep titles that read like a real song someone would search —
// publishing thousands of emoji-clickbait pages would risk the domain's SEO.
function cleanTitle(raw) {
  let t = String(raw || "");
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, " "); // emoji
  t = t.replace(/#[\p{L}\p{N}_]+/gu, " ");                                            // hashtags
  t = t.replace(/\(\s*piano\s*\)/gi, " ");
  t = t.replace(/\b(easy |simple )?piano (tutorial|cover|version|arrangement)\b/gi, " ");
  t = t.replace(/\b(piano tutorial|piano cover|sheet music|midi|slowed( \+ reverb)?|for beginners|easy piano|tutorial)\b/gi, " ");
  t = t.replace(/[|–—-]\s*piano\s*$/gi, " ");
  t = t.replace(/@/g, "");                                                            // strip TikTok @ handles
  t = t.replace(/\s{2,}/g, " ").replace(/^[\s\-–—|.,]+|[\s\-–—|.,]+$/g, "").trim();
  return t;
}

const CLICKBAIT = /\b(wait for|reaction|in front of|whole school|pov|watch (till|until)|you ?won'?t believe|gone wrong|challenge|part \d|tik ?tok|my (mom|dad|teacher|crush|friend|whole))\b/i;
const SPAM = /\b(link in (my )?bio|pre[\s-]?save|presave|out now|stream(ing)?( now)?|new (single|song|album|release)|subscribe|follow( me)?|dm me|drop a comment|comment below|no for this version)\b|楽譜なし|link in/i;

function isSeoWorthy(s) {
  const t = s.title;
  if (!t || t.length < 3 || t.length > 48) return false;        // too short / caption-length
  if (!/[a-zA-Z]/.test(t)) return false;
  if (/^untitled$/i.test(t.trim())) return false;
  if (CLICKBAIT.test(s.rawTitle || "")) return false;            // UGC-clip caption, not a song name
  if (SPAM.test(s.rawTitle || "") || SPAM.test(t)) return false; // promo spam
  if (t.split(/\s+/).length > 8) return false;                   // a sentence, not a title
  // single-word gibberish (no vowels / random caps like "JGMOMD")
  if (!/\s/.test(t) && (!/[aeiou]/i.test(t) || /^[A-Z]{4,}$/.test(t))) return false;

  // PRECISE mode: only the high-confidence set — public-domain classical
  // (Mutopia) or titles with an explicit "Artist - Title" / "Title by Artist"
  // structure (a strong real-song signal). Smaller, but safe for the domain.
  if (process.env.PRECISE) {
    const structured = / (-|–|—|~|by) /i.test(` ${t} `) || / (-|–|—|~|by) /i.test(` ${s.rawTitle} `);
    if (s.source_type !== "mutopia" && !structured) return false;
  }
  return true;
}

// ── fetch catalog (paginated) ───────────────────────────────────────────────
async function fetchCatalog() {
  const cols = "id,title,artist,key,bpm,difficulty,duration,genre,mode,source_type,save_count,created_at";
  const out = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const url = `${SUPABASE_URL}/rest/v1/catalog_songs?select=${cols}` +
      `&is_hidden=eq.false&order=save_count.desc,created_at.desc&limit=${page}&offset=${offset}`;
    const res = await fetch(url, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ── Sustain-cutoff (ported verbatim from the app's SustainTransform) ─────────
const MIN_VIS = 0.05;
// Trim each note's tail so it doesn't linger past the next musical event.
function clampToNextEvent(notes, grace = 0, eventWindow = 0.05) {
  if (notes.length < 2) return notes;
  const onsets = notes.map((n) => n.onset).sort((a, b) => a - b);
  return notes.map((n) => {
    const x = n.onset + eventWindow;
    let lo = 0, hi = onsets.length;            // first onset strictly > x
    while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid] > x) hi = mid; else lo = mid + 1; }
    if (lo >= onsets.length) return n;
    const maxOff = Math.max(onsets[lo] + grace, n.onset + MIN_VIS);
    return n.offset > maxOff ? { ...n, offset: maxOff } : n;
  });
}
// Never let two tiles of the SAME key overlap.
function deoverlap(notes, gap = 0.03) {
  const byPitch = new Map();
  notes.forEach((n, i) => { (byPitch.get(n.note) || byPitch.set(n.note, []).get(n.note)).push(i); });
  const result = notes.map((n) => ({ ...n }));
  for (const idxs of byPitch.values()) {
    if (idxs.length < 2) continue;
    idxs.sort((a, b) => notes[a].onset - notes[b].onset);
    for (let k = 0; k < idxs.length - 1; k++) {
      const cur = idxs[k];
      const maxOff = Math.max(notes[idxs[k + 1]].onset - gap, result[cur].onset + MIN_VIS);
      if (result[cur].offset > maxOff) result[cur].offset = maxOff;
    }
  }
  return result;
}
const tidyForDisplay = (notes) => deoverlap(clampToNextEvent(notes));

// Build a ~60s audio-synced preview with the app's sustain cutoff applied.
const PREVIEW_SECS = 60;
function buildPreview(notesJson, audioUrl) {
  let arr;
  try { arr = JSON.parse(notesJson); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  let notes = [];
  for (const n of arr) {
    if (typeof n.note !== "number") continue;
    const on = +n.onset, off = Math.max(+n.offset, on + MIN_VIS);
    if (!isFinite(on) || !isFinite(off) || on > PREVIEW_SECS) continue;
    notes.push({ note: n.note, onset: on, offset: off });
  }
  if (notes.length < 4) return null;
  notes.sort((a, b) => a.onset - b.onset);
  notes = tidyForDisplay(notes);                       // same cutoff as the app
  const out = notes.map((n) => [n.note, +n.onset.toFixed(2), +n.offset.toFixed(2)]);
  const dur = Math.min(PREVIEW_SECS, out.reduce((a, n) => Math.max(a, n[2]), 0)) + 0.4;
  const obj = { notes: out, duration: +dur.toFixed(2) };
  if (audioUrl) obj.audio = audioUrl;                  // synced audio (preview window)
  return obj;
}

// Fetch notes_json + audio_url for the kept songs (batched), attach to each.
async function attachPreviews(songs) {
  const byId = new Map(songs.map((s) => [s.id, s]));
  const ids = songs.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 60) {
    const inList = ids.slice(i, i + 60).join(",");
    const url = `${SUPABASE_URL}/rest/v1/catalog_songs?select=id,notes_json,audio_url&id=in.(${inList})`;
    const res = await fetch(url, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } });
    if (!res.ok) continue;
    for (const r of await res.json()) {
      const s = byId.get(r.id);
      if (s) s.preview = buildPreview(r.notes_json, r.audio_url);
    }
  }
}

// ── shared chrome ───────────────────────────────────────────────────────────
const head = ({ title, desc, canonical, jsonld }) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}${ICON}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="icon" href="${FAVICON}">
<link rel="stylesheet" href="/keys/seo.css?v=4">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
</head>
<body>
<div class="wrap">
<header class="top">
<a class="brand" href="/keys/"><img src="${LOGO}" alt="Keys app icon" width="30" height="30"><b>Keys</b></a>
<a class="top-cta" href="${APP_STORE}" rel="noopener">Get Keys — free</a>
</header>`;

const foot = `
<div class="foot">
<a href="/keys/songs/">All songs</a><a href="/keys/">About Keys</a><a href="/keys/privacy.html">Privacy</a><a href="/keys/terms.html">Terms</a>
<p>&copy; 2026 Best Day Labs</p>
</div>
</div>
<script src="/keys/pianoroll.js?v=3" defer></script>
</body>
</html>`;

// Interactive falling-tiles player — real note data, scrub + speed + note names.
const rollHero = (song) => {
  if (!song.preview || !song.preview.notes.length) return "";
  return `
<div class="player">
<div class="roll-wrap"><canvas class="pianoroll"></canvas>
<script type="application/json">${JSON.stringify(song.preview)}</script></div>
<div class="controls">
<button class="pp" aria-label="Play or pause">▶</button>
<input class="seek" type="range" min="0" max="1000" value="0" aria-label="Timeline">
<span class="time">0:00</span>
<div class="speeds">
<button data-s="0.25">0.25×</button><button data-s="0.5">0.5×</button><button data-s="0.75">0.75×</button><button data-s="1" class="on">1×</button>
</div>
</div>
</div>`;
};

const appCTA = (id, label) => id ? `
<div class="cta-row">
<a class="btn btn-primary" href="/keys/song/?id=${encodeURIComponent(id)}">${esc(label)}</a>
<a class="btn btn-ghost" href="${APP_STORE}" rel="noopener">Get Keys — free</a>
</div>` : `
<div class="cta-row">
<a class="btn btn-primary" href="${APP_STORE}" rel="noopener">${esc(label)}</a>
</div>`;

const closeCTA = (id, title) => `
<section class="close">
<h2>${id ? `Ready to play ${esc(title)}?` : "Start playing today"}</h2>
<p>Open ${id ? esc(title) : "any song"} in Keys — watch the notes fall toward the keyboard, slow it down, loop the hard parts, and learn it at your own pace on iPhone or iPad.</p>
${appCTA(id, id ? `Play ${title} in Keys` : "Download Keys — free")}
</section>`;

// Prominent app "sales" CTA — stylized phone mockup of the roll + value props
// + a big App Store button. The headline button deep-links to this exact song
// (opens the app if installed, App Store otherwise).
const APPLE_SVG = '<svg viewBox="0 0 384 512" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>';
const ctaSection = (song) => `
<section class="appcta">
<div class="phone"><div class="phone-inner"><video class="phone-vid" autoplay muted loop playsinline preload="metadata"><source src="/keys/app-demo.mp4?v=2" type="video/mp4"></video><span class="phone-gloss"></span></div></div>
<div class="appcta-body">
<div class="appcta-brand"><img src="${LOGO}" alt="Keys" width="34" height="34"><span>Keys</span></div>
<h2>Turn any song or video<br>into piano you can play</h2>
<ul class="appcta-feats">
<li>Transcribe any song or video into piano</li>
<li>Generate a full piano cover of the audio</li>
<li>Slow it down, loop the hard parts, and learn it</li>
</ul>
<a class="appcta-btn" href="${APP_STORE}" rel="noopener">${APPLE_SVG}<span><small>Download on the</small><b>App Store</b></span></a>
</div>
</section>`;

// ── song page ───────────────────────────────────────────────────────────────
function songPage(song, related, artistSlug) {
  const title = song.title;
  const artist = song.artist || "Unknown artist";
  // Only attribute "by <artist>" when it's trustworthy: Mutopia composers, or
  // real multi-word names. TikTok handles / "Unknown" are dropped — the real
  // artist is almost always already inside the structured title anyway.
  const byArtist = (song.artist && !/^unknown/i.test(song.artist) &&
    (song.source_type === "mutopia" || /\s/.test(song.artist))) ? song.artist : null;
  const url = `${SITE}/keys/songs/${song.slug}/`;
  const keyTxt = song.key ? esc(song.key) : null;
  // BPM is only trustworthy for Mutopia (public-domain) songs; imported songs
  // default to 120, so never surface a 120 we can't verify — it'd be both
  // inaccurate and a duplicate-value signal across pages.
  const bpmReal = song.bpm && (song.source_type === "mutopia" || Math.round(song.bpm) !== 120);
  const bpm = bpmReal ? `${Math.round(song.bpm)} BPM` : null;
  const diff = song.difficulty ? titleCase(song.difficulty) : null;
  const dur = fmtDur(song.duration);
  const genre = song.genre ? titleCase(song.genre) : null;

  const facts = [
    keyTxt && ["Key", keyTxt],
    bpm && ["Tempo", bpm],
    diff && ["Difficulty", diff],
    dur && ["Length", dur],
    genre && ["Genre", genre],
  ].filter(Boolean);

  const by = byArtist ? ` by ${byArtist}` : "";
  const pageTitle = `How to Play ${title}${by} on Piano | Keys`;
  const metaDesc =
    `Learn to play ${title}${by} on piano` +
    (keyTxt ? ` — key of ${song.key}` : "") + (bpm ? `, ${bpm}` : "") +
    `. Slow it down, loop the tricky parts, and play along note-by-note in Keys.`;

  const diffBlurb = {
    beginner: "It's approachable for newer players — steady tempo and patterns you can build up gradually.",
    intermediate: "It sits at an intermediate level — comfortable once you've got both hands coordinating.",
    advanced: "It's a more advanced piece — expect faster passages and bigger reaches, well worth drilling section by section.",
  }[String(song.difficulty || "").toLowerCase()] ||
    "Work through it a phrase at a time and it comes together faster than you'd think.";

  const lead = `Watch the real notes fall, slow it down, and learn ${esc(title)}${byArtist ? ` by ${esc(byArtist)}` : ""} at your own pace${keyTxt ? ` — key of ${keyTxt}` : ""}.`;

  const faqs = [
    [`How hard is ${title} to play on piano?`,
      diff ? `${esc(title)} is rated ${esc(diff.toLowerCase())} in Keys. ${esc(diffBlurb)}`
           : `Use the player above to slow ${esc(title)} down and scrub any part — so you can learn it at your own level.`],
    [`Can I slow ${title} down to learn it?`,
      `Yes — the player above runs from 0.25× to full speed. The Keys app adds audio, looping, and Learn Mode for the whole song.`],
  ];

  const jsonld = [
    { "@context": "https://schema.org", "@type": "MusicComposition", name: title,
      ...(byArtist ? { composer: { "@type": "Person", name: byArtist } } : {}), ...(genre ? { genre } : {}), url },
    { "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faqs.map(([q, a]) => ({ "@type": "Question", name: q,
        acceptedAnswer: { "@type": "Answer", text: a.replace(/<[^>]+>/g, "") } })) },
    { "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Keys", item: `${SITE}/keys/` },
        { "@type": "ListItem", position: 2, name: "Songs", item: `${SITE}/keys/songs/` },
        { "@type": "ListItem", position: 3, name: title, item: url },
      ] },
  ];

  return head({ title: pageTitle, desc: metaDesc, canonical: url, jsonld }) + `
<nav class="crumb"><a href="/keys/songs/">Songs</a> &rsaquo; ${(byArtist && artistSlug) ? `<a href="/keys/artists/${artistSlug}/">${esc(byArtist)}</a> &rsaquo; ` : ""}${esc(title)}</nav>
<h1>How to Play ${esc(title)}${byArtist ? `<br>by ${esc(byArtist)} on Piano` : ` on Piano`}</h1>
<p class="lead">${lead}</p>
${rollHero(song)}
${ctaSection(song)}
${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("")}</div>` : ""}

<section>
<div class="faq">
${faqs.map(([q, a]) => `<div class="qa"><div class="q">${esc(q)}</div><p>${a}</p></div>`).join("")}
</div>
</section>

${related.length ? `<section>
<h2>More songs to learn</h2>
<div class="grid">
${related.map((r) => `<a class="tile" href="/keys/songs/${r.slug}/"><div class="t">${esc(r.title)}</div><div class="a">${esc(r.artist || "")}</div></a>`).join("")}
</div>
</section>` : ""}
${closeCTA(song.id, title)}
` + foot;
}

// ── artist hub ───────────────────────────────────────────────────────────────
function artistPage(artist, slug, songs) {
  const url = `${SITE}/keys/artists/${slug}/`;
  const title = `${artist} Piano Songs & Tutorials | Keys`;
  const desc = `Learn ${artist} songs on piano in Keys — interactive falling-note tutorials you can slow down, loop, and play along with. ${songs.length} song${songs.length === 1 ? "" : "s"} available.`;
  const jsonld = [
    { "@context": "https://schema.org", "@type": "CollectionPage", name: `${artist} piano songs`, url },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "Keys", item: `${SITE}/keys/` },
      { "@type": "ListItem", position: 2, name: "Songs", item: `${SITE}/keys/songs/` },
      { "@type": "ListItem", position: 3, name: artist, item: url },
    ] },
  ];
  return head({ title, desc, canonical: url, jsonld }) + `
<nav class="crumb"><a href="/keys/songs/">Songs</a> &rsaquo; ${esc(artist)}</nav>
<h1>${esc(artist)}<br>piano songs &amp; tutorials</h1>
<p class="lead">Learn ${esc(artist)} on piano with Keys — every song becomes an interactive piano roll you can slow down, loop, and play along with. ${songs.length} song${songs.length === 1 ? "" : "s"} to start with.</p>
<div class="grid">
${songs.map((s) => `<a class="tile" href="/keys/songs/${s.slug}/"><div class="t">${esc(s.title)}</div><div class="a">${[s.key, s.difficulty ? titleCase(s.difficulty) : null].filter(Boolean).map(esc).join(" · ")}</div></a>`).join("")}
</div>
${closeCTA("", artist)}
` + foot;
}

// ── browse index ─────────────────────────────────────────────────────────────
function indexPage(popular, artists) {
  const url = `${SITE}/keys/songs/`;
  const title = `Piano Songs & Tutorials — Learn Any Song on Piano | Keys`;
  const desc = `Browse piano tutorials in Keys. Pick a song and learn it on an interactive piano roll — slow it down, loop the hard parts, and play along on iPhone or iPad.`;
  const jsonld = [{ "@context": "https://schema.org", "@type": "CollectionPage", name: "Piano songs and tutorials", url }];
  const featured = popular.find((s) => s.preview);
  return head({ title, desc, canonical: url, jsonld }) + `
<nav class="crumb">Songs</nav>
${featured ? rollHero(featured) : ""}
<h1>Learn any song on piano</h1>
<p class="lead">Pick a piece and Keys turns it into an interactive piano roll — the notes fall toward a keyboard so you can see exactly what to play, slow it down, and loop the tricky parts.</p>
${appCTA("", "Get Keys — free")}
<section>
<h2>Popular right now</h2>
<div class="grid">
${popular.map((s) => `<a class="tile" href="/keys/songs/${s.slug}/"><div class="t">${esc(s.title)}</div><div class="a">${esc(s.artist || "")}</div></a>`).join("")}
</div>
</section>
<section>
<h2>Browse by artist</h2>
<div class="grid">
${artists.map((a) => `<a class="tile" href="/keys/artists/${a.slug}/"><div class="t">${esc(a.name)}</div><div class="a">${a.count} song${a.count === 1 ? "" : "s"}</div></a>`).join("")}
</div>
</section>
${closeCTA("", "")}
` + foot;
}

// ── sitemap ──────────────────────────────────────────────────────────────────
function sitemap(urls) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${u}</loc></url>`).join("\n")}
</urlset>`;
}

const write = async (rel, content) => {
  const full = resolve(KEYS_DIR, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
};

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log("Fetching catalog…");
  const all = await fetchCatalog();
  for (const s of all) { s.rawTitle = s.title; s.title = cleanTitle(s.title); }
  let songs = all.filter(isSeoWorthy);
  console.log(`${songs.length} SEO-worthy of ${all.length} total catalog songs (${all.length - songs.length} skipped as UGC/clickbait).`);
  if (LIMIT !== Infinity) songs = songs.slice(0, LIMIT);

  // Stable, collision-free slugs.
  const used = new Set();
  for (const s of songs) {
    let base = slugify(`${s.title}-${s.artist || ""}`);
    let slug = base;
    if (used.has(slug)) slug = `${base}-${String(s.id).slice(0, 6)}`;
    used.add(slug);
    s.slug = slug;
  }

  console.log("Fetching note previews…");
  await attachPreviews(songs);
  console.log(`${songs.filter((s) => s.preview).length} have a playable preview.`);

  // Group by artist.
  const byArtist = new Map();
  for (const s of songs) {
    const name = (s.artist || "Unknown artist").trim();
    if (!byArtist.has(name)) byArtist.set(name, []);
    byArtist.get(name).push(s);
  }
  const artistSlug = new Map();
  const aUsed = new Set();
  for (const name of byArtist.keys()) {
    let slug = slugify(name); if (aUsed.has(slug)) slug = `${slug}-${aUsed.size}`;
    aUsed.add(slug); artistSlug.set(name, slug);
  }

  // Wipe + regenerate only the generated folders (never touches other files).
  await rm(resolve(KEYS_DIR, "songs/_gen_marker"), { force: true }).catch(() => {});

  const urls = [`${SITE}/keys/songs/`];

  // Song pages.
  for (const s of songs) {
    const name = (s.artist || "Unknown artist").trim();
    const related = (byArtist.get(name) || []).filter((r) => r.id !== s.id).slice(0, 4);
    const filler = related.length < 4 ? songs.filter((r) => r.id !== s.id && r.artist !== s.artist).slice(0, 4 - related.length) : [];
    await write(`songs/${s.slug}/index.html`, songPage(s, [...related, ...filler], artistSlug.get(name)));
    urls.push(`${SITE}/keys/songs/${s.slug}/`);
  }

  // Artist hubs (skip the catch-all "Unknown artist" bucket — low value).
  for (const [name, list] of byArtist) {
    if (/^unknown/i.test(name)) continue;
    const slug = artistSlug.get(name);
    await write(`artists/${slug}/index.html`, artistPage(name, slug, list));
    urls.push(`${SITE}/keys/artists/${slug}/`);
  }

  // Browse index + sitemap.
  const popular = songs.slice(0, 60);
  const artistList = [...byArtist.entries()]
    .map(([name, list]) => ({ name, slug: artistSlug.get(name), count: list.length }))
    .sort((a, b) => b.count - a.count).slice(0, 120);
  await write("songs/index.html", indexPage(popular, artistList));
  await write("sitemap.xml", sitemap(urls));

  console.log(`Done: ${songs.length} songs, ${byArtist.size} artists, ${urls.length} URLs.`);
})().catch((e) => { console.error(e); process.exit(1); });
