// Generates self-hosted GitHub stat cards (SVG) into output/.
// Runs in GitHub Actions with GITHUB_TOKEN, so the profile never depends on
// rate-limited third-party card services.
//
//   GITHUB_TOKEN=... node scripts/generate-stats.mjs <username>
//   node scripts/generate-stats.mjs <username> --mock   (offline render test)

import { mkdir, writeFile } from "node:fs/promises";

const USER = process.argv[2] || "manavkhadka0";
const MOCK = process.argv.includes("--mock");
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = "output";
// Notebook JSON inflates byte counts and hides the real stack
const IGNORED_LANGS = new Set(["Jupyter Notebook"]);

const T = {
  bg: "#0D1117",
  border: "#30363D",
  title: "#A277FF",
  text: "#C9D1D9",
  muted: "#8B949E",
  accent: "#61FFCA",
  hot: "#FF6BCB",
  area: "#302B63",
  font: "'Fira Code','JetBrains Mono',Consolas,monospace",
};

// ───────────────────────────── data ─────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

async function fetchData() {
  const base = await gql(
    `query($login:String!){ user(login:$login){
       createdAt
       followers{ totalCount }
       pullRequests{ totalCount }
       issues{ totalCount }
       repositoriesContributedTo(contributionTypes:[COMMIT,PULL_REQUEST,ISSUE]){ totalCount }
     } }`,
    { login: USER },
  );
  const u = base.user;

  // Owned, non-fork public repos: stars + language bytes
  const repos = [];
  let after = null;
  do {
    const d = await gql(
      `query($login:String!,$after:String){ user(login:$login){
         repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC){
           pageInfo{ hasNextPage endCursor }
           nodes{ stargazerCount languages(first:10, orderBy:{field:SIZE,direction:DESC}){
             edges{ size node{ name color } } } }
         } } }`,
      { login: USER, after },
    );
    const r = d.user.repositories;
    repos.push(...r.nodes);
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);

  // Contribution calendar, one year per query, from account creation to now
  const days = [];
  let totalCommits = 0;
  const start = new Date(u.createdAt);
  const now = new Date();
  for (let y = start.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Date.UTC(y, 0, 1));
    const to = y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    const d = await gql(
      `query($login:String!,$from:DateTime!,$to:DateTime!){ user(login:$login){
         contributionsCollection(from:$from,to:$to){
           totalCommitContributions restrictedContributionsCount
           contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
         } } }`,
      { login: USER, from: from.toISOString(), to: to.toISOString() },
    );
    const c = d.user.contributionsCollection;
    totalCommits += c.totalCommitContributions + c.restrictedContributionsCount;
    for (const w of c.contributionCalendar.weeks) days.push(...w.contributionDays);
  }

  const langs = {};
  for (const r of repos)
    for (const e of r.languages.edges) {
      if (IGNORED_LANGS.has(e.node.name)) continue;
      langs[e.node.name] ??= { size: 0, color: e.node.color || T.muted };
      langs[e.node.name].size += e.size;
    }

  return {
    stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    repos: repos.length,
    commits: totalCommits,
    prs: u.pullRequests.totalCount,
    issues: u.issues.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount,
    followers: u.followers.totalCount,
    langs,
    days: dedupeDays(days).filter((d) => d.date >= u.createdAt.slice(0, 10)),
  };
}

function dedupeDays(days) {
  const m = new Map(days.map((d) => [d.date, d.contributionCount]));
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count }));
}

function mockData() {
  const days = [];
  const d = new Date(Date.UTC(2020, 1, 26));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (d <= new Date()) {
    days.push({ date: d.toISOString().slice(0, 10), count: rnd() < 0.35 ? 0 : Math.floor(rnd() * 12) });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return {
    stars: 12, repos: 40, commits: 2345, prs: 120, issues: 14, contributedTo: 18, followers: 19,
    langs: {
      TypeScript: { size: 900000, color: "#3178c6" }, JavaScript: { size: 500000, color: "#f1e05a" },
      Python: { size: 200000, color: "#3572A5" }, "C#": { size: 150000, color: "#178600" },
      HTML: { size: 90000, color: "#e34c26" }, CSS: { size: 60000, color: "#563d7c" },
    },
    days,
  };
}

// ─────────────────────────── helpers ────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const fmtDate = (s) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function card(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<style>
  text{font-family:${T.font}}
  .t{fill:${T.title};font-size:16px;font-weight:700}
  .l{fill:${T.text};font-size:13px}
  .v{fill:${T.accent};font-size:13px;font-weight:700}
  .m{fill:${T.muted};font-size:11px}
  .fade{opacity:0;animation:in .6s ease-out forwards}
  @keyframes in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:none}}
  @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${T.bg}" stroke="${T.border}"/>
<circle cx="20" cy="20" r="5" fill="#FF5F56"/><circle cx="36" cy="20" r="5" fill="#FFBD2E"/><circle cx="52" cy="20" r="5" fill="#27C93F"/>
<text x="70" y="25" class="t">${esc(title)}</text>
${body}
</svg>`;
}

// ──────────────────────────── cards ─────────────────────────────

function statsCard(d) {
  const rows = [
    ["⭐", "Stars earned", d.stars],
    ["🔥", "Total commits", d.commits],
    ["🔀", "Pull requests", d.prs],
    ["🐞", "Issues opened", d.issues],
    ["📦", "Public repos", d.repos],
    ["🤝", "Contributed to", d.contributedTo],
  ];
  const body = rows
    .map(([icon, label, v], i) => {
      const y = 62 + i * 25;
      return `<g class="fade" style="animation-delay:${150 * i}ms">
  <text x="24" y="${y}" class="l">${icon}  ${esc(label)}</text>
  <text x="326" y="${y}" class="v" text-anchor="end">${fmt(v)}</text>
</g>`;
    })
    .join("\n");
  return card(350, 215, "$ git stats --all", body);
}

function langsCard(d) {
  const entries = Object.entries(d.langs).sort((a, b) => b[1].size - a[1].size);
  const total = entries.reduce((s, [, v]) => s + v.size, 0) || 1;
  const top = entries.filter(([, v]) => v.size / total >= 0.005).slice(0, 8);
  const W = 302;
  let x = 24;
  const bar = top
    .map(([, v]) => {
      const w = Math.max(2, (v.size / total) * W);
      const r = `<rect x="${x.toFixed(1)}" y="46" width="${w.toFixed(1)}" height="8" fill="${v.color}"/>`;
      x += w;
      return r;
    })
    .join("");
  const list = top
    .map(([name, v], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const lx = 24 + col * 160, ly = 90 + row * 32;
      return `<g class="fade" style="animation-delay:${100 * i}ms">
  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${v.color}"/>
  <text x="${lx + 16}" y="${ly}" class="l">${esc(name)} <tspan class="m">${((v.size / total) * 100).toFixed(1)}%</tspan></text>
</g>`;
    })
    .join("\n");
  const body = `<clipPath id="bc"><rect x="24" y="46" width="${W}" height="8" rx="4"/></clipPath>
<g clip-path="url(#bc)"><g style="transform-origin:24px 50px;animation:grow 1s ease-out">${bar}</g></g>
${list}`;
  return card(350, 215, "$ cloc --by-lang", body);
}

function streaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  let longest = { len: 0 }, run = null;
  for (const d of days) {
    if (d.count > 0) {
      run = run ? { ...run, end: d.date, len: run.len + 1 } : { start: d.date, end: d.date, len: 1 };
      if (run.len > longest.len) longest = run;
    } else run = null;
  }
  // Current streak: allow today to be empty (day isn't over yet)
  let i = days.length - 1;
  if (i >= 0 && days[i].date === today && days[i].count === 0) i--;
  let cur = { len: 0 };
  for (; i >= 0 && days[i].count > 0; i--)
    cur = { start: days[i].date, end: cur.end || days[i].date, len: cur.len + 1 };
  const total = days.reduce((s, d) => s + d.count, 0);
  return { total, cur, longest, first: days[0]?.date };
}

function streakCard(d) {
  const s = streaks(d.days);
  const short = (x) => fmtDate(x).replace(/, \d{4}$/, "");
  const range = (r) => {
    if (!r.len) return "-";
    if (r.start === r.end) return fmtDate(r.start);
    const sameYear = r.start.slice(0, 4) === r.end.slice(0, 4);
    return `${sameYear ? short(r.start) : fmtDate(r.start)} - ${fmtDate(r.end)}`;
  };
  const col = (cx, big, label, sub, color, extra = "") => `
<g class="fade" style="animation-delay:${cx}ms">
  ${extra}
  <text x="${cx}" y="112" text-anchor="middle" style="fill:${color};font-size:30px;font-weight:700">${fmt(big)}</text>
  <text x="${cx}" y="150" text-anchor="middle" class="l">${esc(label)}</text>
  <text x="${cx}" y="170" text-anchor="middle" class="m">${esc(sub)}</text>
</g>`;
  const ring = `<circle cx="270" cy="101" r="38" fill="none" stroke="${T.title}" stroke-width="4" stroke-dasharray="239" stroke-dashoffset="239" style="animation:draw 1.2s ease-out forwards"/>
  <text x="270" y="58" text-anchor="middle" style="font-size:18px;animation:pulse 1.6s ease-in-out infinite">🔥</text>`;
  const body = `
<line x1="180" y1="60" x2="180" y2="175" stroke="${T.border}"/>
<line x1="360" y1="60" x2="360" y2="175" stroke="${T.border}"/>
${col(90, s.total, "Total contributions", `${fmtDate(s.first)} - Present`, T.accent)}
${col(270, s.cur.len, "Current streak", range(s.cur), T.hot, ring)}
${col(450, s.longest.len, "Longest streak", range(s.longest), T.title)}`;
  return card(540, 195, "$ uptime --commits", body);
}

function activityCard(d) {
  const last = d.days.slice(-31);
  const W = 850, H = 300, px = 50, top = 60, bottom = 50;
  const max = Math.max(1, ...last.map((x) => x.count));
  const sx = (i) => px + (i * (W - 2 * px)) / Math.max(1, last.length - 1);
  const sy = (v) => H - bottom - (v / max) * (H - top - bottom);
  const pts = last.map((x, i) => [sx(i), sy(x.count)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${sx(last.length - 1).toFixed(1)},${H - bottom}L${px},${H - bottom}Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = Math.round(max * f), y = sy(v);
      return `<line x1="${px}" y1="${y}" x2="${W - px}" y2="${y}" stroke="${T.border}" stroke-dasharray="3 4"/>
<text x="${px - 10}" y="${y + 4}" text-anchor="end" class="m">${v}</text>`;
    })
    .join("\n");
  const labels = last
    .map((x, i) => (i % 5 === 0 || i === last.length - 1 ? `<text x="${sx(i)}" y="${H - bottom + 20}" text-anchor="middle" class="m">${x.date.slice(5)}</text>` : ""))
    .join("");
  const dots = pts
    .map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#FFFFFF" class="fade" style="animation-delay:${800 + i * 25}ms"><title>${last[i].date}: ${last[i].count}</title></circle>`)
    .join("");
  const body = `<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${T.title}" stop-opacity=".45"/><stop offset="1" stop-color="${T.area}" stop-opacity="0"/></linearGradient></defs>
${grid}
<path d="${area}" fill="url(#ag)" class="fade" style="animation-delay:600ms"/>
<path d="${line}" fill="none" stroke="${T.accent}" stroke-width="2.5" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1" style="animation:draw 1.6s ease-out forwards"/>
${dots}
${labels}`;
  return card(W, H, "$ tail -n 30 contributions.log", body);
}

// ──────────────────────────── main ──────────────────────────────

if (!MOCK && !TOKEN) {
  console.error("GITHUB_TOKEN is required (or pass --mock)");
  process.exit(1);
}
const data = MOCK ? mockData() : await fetchData();
await mkdir(OUT, { recursive: true });
const files = {
  "stats.svg": statsCard(data),
  "top-langs.svg": langsCard(data),
  "streak.svg": streakCard(data),
  "activity.svg": activityCard(data),
};
for (const [name, svg] of Object.entries(files)) await writeFile(`${OUT}/${name}`, svg);
console.log(`Wrote ${Object.keys(files).join(", ")} for ${USER}`, MOCK ? "(mock)" : "");
