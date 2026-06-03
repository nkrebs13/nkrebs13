import { mkdir, readFile, writeFile } from "node:fs/promises";

const username = "nkrebs13";
const featuredRepos = ["Squares", "kmp-template", "app-icon-banner", "PomoDaddy"];
const excludedRepos = new Set([username, `${username}-profile-preview`]);
const readmePath = new URL("../README.md", import.meta.url);
const generatedDir = new URL("../generated/", import.meta.url);
const overviewPath = new URL("../generated/overview.svg", import.meta.url);
const languagesPath = new URL("../generated/languages.svg", import.meta.url);
const apiBase = "https://api.github.com";

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function fetchJson(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} for ${path}`);
  }

  return response.json();
}

async function fetchGraphql(query, variables = {}) {
  if (!process.env.GITHUB_TOKEN) {
    return null;
  }

  const response = await fetch(`${apiBase}/graphql`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();

  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL request failed: ${body.errors.map((error) => error.message).join("; ")}`);
  }

  return body.data;
}

function repoUrl(name) {
  return `https://github.com/${username}/${name}`;
}

function cleanRepoName(fullName) {
  return fullName.replace(`${username}/`, "");
}

function eventKind(event) {
  switch (event.type) {
    case "PushEvent":
      return "pushes";
    case "PullRequestEvent":
      return "pull requests";
    case "ReleaseEvent":
      return "releases";
    case "PublicEvent":
      return "public release";
    default:
      return null;
  }
}

function summarizeEvents(events) {
  const groups = new Map();

  for (const event of events) {
    const kind = eventKind(event);

    if (!kind) {
      continue;
    }

    const repo = cleanRepoName(event.repo.name);
    const kinds = groups.get(repo) ?? new Set();
    kinds.add(kind);
    groups.set(repo, kinds);
  }

  return Array.from(groups.entries())
    .slice(0, 4)
    .map(([repo, kinds]) => `[${repo}](${repoUrl(repo)}) (${Array.from(kinds).join(", ")})`);
}

async function latestPublicActivity() {
  const events = await fetchJson(`/users/${username}/events/public?per_page=30`);

  return summarizeEvents(events);
}

async function latestReleases() {
  const releases = [];

  for (const repo of featuredRepos) {
    const repoReleases = await fetchJson(`/repos/${username}/${repo}/releases?per_page=1`);
    const latest = repoReleases?.[0];

    if (latest) {
      releases.push({
        repo,
        name: latest.name || latest.tag_name,
        url: latest.html_url,
        publishedAt: latest.published_at,
      });
    }
  }

  return releases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

async function publicRepos() {
  const repos = await fetchJson(`/users/${username}/repos?type=owner&sort=pushed&per_page=100`);

  return repos.filter((repo) => !repo.fork && !excludedRepos.has(repo.name));
}

async function publicRepoSnapshot(repos) {
  const featured = repos
    .filter((repo) => featuredRepos.includes(repo.name))
    .sort((a, b) => featuredRepos.indexOf(a.name) - featuredRepos.indexOf(b.name));

  return featured.map((repo) => {
    const language = repo.language ? `, ${repo.language}` : "";
    const license = repo.license?.spdx_id ? `, ${repo.license.spdx_id}` : "";
    return `[${repo.name}](${repo.html_url}) (${`${language}${license}`.replace(/^, /, "")})`;
  });
}

async function languageBreakdown(repos) {
  const totals = new Map();

  for (const repo of repos) {
    const languages = await fetchJson(`/repos/${username}/${repo.name}/languages`);

    for (const [language, bytes] of Object.entries(languages ?? {})) {
      totals.set(language, (totals.get(language) ?? 0) + bytes);
    }
  }

  const totalBytes = Array.from(totals.values()).reduce((sum, bytes) => sum + bytes, 0);

  return Array.from(totals.entries())
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: totalBytes ? (bytes / totalBytes) * 100 : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

async function contributionSummary() {
  const data = await fetchGraphql(
    `query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
          }
        }
      }
    }`,
    { login: username },
  );

  return data?.user?.contributionsCollection?.contributionCalendar?.totalContributions ?? null;
}

function renderPulseSection({ activity, releases, snapshot }) {
  const lines = [];

  if (activity.length > 0) {
    lines.push(`- Recent public activity: ${activity.join("; ")}.`);
  }

  if (releases.length > 0) {
    const releaseText = releases
      .map((release) => `[${release.repo} ${release.name}](${release.url})`)
      .join("; ");
    lines.push(`- Latest public releases: ${releaseText}.`);
  }

  if (snapshot.length > 0) {
    lines.push(`- Featured public repos: ${snapshot.join("; ")}.`);
  }

  return lines.join("\n");
}

function replaceGeneratedSection(readme, generated) {
  const start = "<!-- github-pulse:start -->";
  const end = "<!-- github-pulse:end -->";
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);

  if (!pattern.test(readme)) {
    throw new Error("Could not find github-pulse markers in README.md");
  }

  return readme.replace(pattern, `${start}\n${generated}\n${end}`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US").format(value);
}

function languageColor(language) {
  const colors = {
    TypeScript: "#3178c6",
    Swift: "#f05138",
    Kotlin: "#7f52ff",
    Svelte: "#ff3e00",
    PLpgSQL: "#336791",
    Shell: "#89e051",
    JavaScript: "#f1e05a",
    CSS: "#663399",
    HTML: "#e34c26",
    Python: "#3572a5",
    Ruby: "#701516",
  };

  return colors[language] ?? "#8b949e";
}

function svgShell({ width = 760, height = 190, title, subtitle, body }) {
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">${escapeXml(subtitle)}</desc>
  <style>
    .card { fill: #0d1117; stroke: #30363d; stroke-width: 1; }
    .title { fill: #f0f6fc; font: 600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .sub { fill: #8b949e; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .label { fill: #8b949e; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .value { fill: #f0f6fc; font: 600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .small { fill: #c9d1d9; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .muted { fill: #8b949e; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  </style>
  <rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8"/>
  <text class="title" x="24" y="34">${escapeXml(title)}</text>
  <text class="sub" x="24" y="56">${escapeXml(subtitle)}</text>
  ${body}
</svg>
`;
}

function renderMetric({ x, y, label, value }) {
  return `<g>
    <text class="value" x="${x}" y="${y}">${escapeXml(value)}</text>
    <text class="label" x="${x}" y="${y + 22}">${escapeXml(label)}</text>
  </g>`;
}

function renderOverviewSvg({ repos, releases, contributions, activity }) {
  const recent = activity.length > 0 ? activity.join(" · ").replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1") : "public repo updates";
  const metrics = [
    { label: "public repos", value: repos.length },
    { label: "featured repos", value: featuredRepos.length },
    { label: "public releases", value: releases.length },
    { label: "contribution graph", value: contributions },
  ];

  const body = `
  <g transform="translate(24 84)">
    ${metrics.map((metric, index) => renderMetric({
      x: index * 180,
      y: 0,
      label: metric.label,
      value: formatNumber(metric.value),
    })).join("\n")}
  </g>
  <line x1="24" y1="132" x2="736" y2="132" stroke="#21262d"/>
  <text class="small" x="24" y="158">Recent: ${escapeXml(recent)}</text>
  <text class="muted" x="24" y="176">Public GitHub proof layer for mobile, KMP, realtime web, and developer tooling.</text>`;

  return svgShell({
    title: "GitHub Snapshot",
    subtitle: "Generated from GitHub profile data",
    body,
  });
}

function renderLanguagesSvg(languages) {
  const topLanguages = languages.slice(0, 6);
  let offset = 0;
  const bar = topLanguages.map((language) => {
    const width = Math.max(language.percent * 7.12, 2);
    const segment = `<rect x="${24 + offset}" y="78" width="${width.toFixed(2)}" height="10" fill="${languageColor(language.name)}"/>`;
    offset += width;
    return segment;
  }).join("\n");

  const rows = topLanguages.map((language, index) => {
    const x = 24 + (index % 3) * 238;
    const y = 122 + Math.floor(index / 3) * 34;
    return `<g>
      <circle cx="${x}" cy="${y - 4}" r="5" fill="${languageColor(language.name)}"/>
      <text class="small" x="${x + 14}" y="${y}">${escapeXml(language.name)}</text>
      <text class="muted" x="${x + 14}" y="${y + 16}">${language.percent.toFixed(1)}%</text>
    </g>`;
  }).join("\n");

  const body = `
  <clipPath id="barClip"><rect x="24" y="78" width="712" height="10" rx="5"/></clipPath>
  <rect x="24" y="78" width="712" height="10" rx="5" fill="#21262d"/>
  <g clip-path="url(#barClip)">${bar}</g>
  ${rows}`;

  return svgShell({
    title: "Languages",
    subtitle: "By public repo file size",
    body,
  });
}

const [activity, releases, repos, contributions, readme] = await Promise.all([
  latestPublicActivity(),
  latestReleases(),
  publicRepos(),
  contributionSummary(),
  readFile(readmePath, "utf8"),
]);

const [snapshot, languages] = await Promise.all([
  publicRepoSnapshot(repos),
  languageBreakdown(repos),
]);

const generated = renderPulseSection({ activity, releases, snapshot });
const nextReadme = replaceGeneratedSection(readme, generated);

await mkdir(generatedDir, { recursive: true });
await Promise.all([
  writeFile(readmePath, nextReadme),
  writeFile(overviewPath, renderOverviewSvg({ repos, releases, contributions, activity })),
  writeFile(languagesPath, renderLanguagesSvg(languages)),
]);
