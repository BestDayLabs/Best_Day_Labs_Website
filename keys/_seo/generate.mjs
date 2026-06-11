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
const ICON = "/keys/KeysIcon.png";

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
<link rel="icon" href="${ICON}">
<link rel="stylesheet" href="/keys/seo.css">
${jsonld.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join("\n")}
</head>
<body>
<div class="wrap">
<a class="top" href="/keys/" style="text-decoration:none;color:inherit">
<span class="logo" aria-hidden="true">🎹</span><b>Keys</b>
</a>`;

const foot = `
<div class="foot">
<a href="/keys/songs/">All songs</a><a href="/keys/">About Keys</a><a href="/keys/privacy.html">Privacy</a><a href="/keys/terms.html">Terms</a>
<p>&copy; 2026 Best Day Labs</p>
</div>
</div>
</body>
</html>`;

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

  const intro =
    `<strong>${esc(title)}</strong>${byArtist ? ` by ${esc(byArtist)}` : ""} is one of the pieces you can learn hands-on in ` +
    `<a href="/keys/">Keys</a>. ${esc(diffBlurb)} ` +
    `Keys turns it into an interactive piano roll — the notes fall toward a keyboard so you can see exactly ` +
    `what to play${keyTxt ? ` in the key of ${keyTxt}` : ""}, slow it right down, and loop the bars that trip you up.`;

  const steps = [
    `Open ${esc(title)} in Keys and watch the falling-note preview to get a feel for the shape of the piece.`,
    `Drop the speed to 50–75% so you can place each note without rushing${dur ? "" : ""}.`,
    `Loop the hardest 2–4 bars and repeat them until they're muscle memory.`,
    `Turn on Learn Mode — Keys waits for the right note before advancing, so you can't drift.`,
    `Bring the tempo back up gradually until you can play ${esc(title)} start to finish.`,
  ];

  const faqs = [
    [`How hard is ${title} to play on piano?`,
      diff ? `${esc(title)} is rated ${esc(diff.toLowerCase())} in Keys. ${esc(diffBlurb)}`
           : `In Keys you can slow ${esc(title)} down and loop any section, so you can learn it at whatever level you're at.`],
    keyTxt ? [`What key is ${title} in?`, `${esc(title)} is in the key of ${keyTxt}. Keys highlights the notes as they fall so you can follow along.`] : null,
    [`Can I slow ${title} down to learn it?`,
      `Yes — Keys lets you play ${esc(title)} from quarter-speed up to 2× with no pitch change, and loop the tricky bars.`],
  ].filter(Boolean);

  const jsonld = [
    { "@context": "https://schema.org", "@type": "MusicComposition", name: title,
      ...(byArtist ? { composer: { "@type": "Person", name: byArtist } } : {}), ...(genre ? { genre } : {}), url },
    { "@context": "https://schema.org", "@type": "HowTo",
      name: `How to play ${title} on piano`,
      step: steps.map((t, i) => ({ "@type": "HowToStep", position: i + 1, text: t.replace(/<[^>]+>/g, "") })) },
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
<h1>How to Play <span class="grad">${esc(title)}</span>${byArtist ? `<br>by ${esc(byArtist)} on Piano` : ` on Piano`}</h1>
<p class="lead">${intro}</p>
${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("")}</div>` : ""}
${appCTA(song.id, `Play ${title} in Keys`)}

<section>
<h2>How to learn ${esc(title)} on piano</h2>
<div class="steps">
${steps.map((t, i) => `<div class="step"><div class="n">STEP ${i + 1}</div><p>${t}</p></div>`).join("")}
</div>
</section>

<section>
<h2>FAQ</h2>
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
<h1><span class="grad">${esc(artist)}</span><br>piano songs &amp; tutorials</h1>
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
  return head({ title, desc, canonical: url, jsonld }) + `
<nav class="crumb">Songs</nav>
<h1>Learn any song <span class="grad">on piano</span></h1>
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
