import { readFile, writeFile } from "node:fs/promises";

const username = "nkrebs13";
const featuredRepos = ["Squares", "kmp-template", "app-icon-banner", "PomoDaddy"];
const readmePath = new URL("../README.md", import.meta.url);
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

async function publicRepoSnapshot() {
  const repos = await fetchJson(`/users/${username}/repos?type=owner&sort=pushed&per_page=100`);
  const featured = repos
    .filter((repo) => featuredRepos.includes(repo.name))
    .sort((a, b) => featuredRepos.indexOf(a.name) - featuredRepos.indexOf(b.name));

  return featured.map((repo) => {
    const language = repo.language ? `, ${repo.language}` : "";
    const license = repo.license?.spdx_id ? `, ${repo.license.spdx_id}` : "";
    return `[${repo.name}](${repo.html_url}) (${`${language}${license}`.replace(/^, /, "")})`;
  });
}

function renderSection({ activity, releases, snapshot }) {
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

const [activity, releases, snapshot, readme] = await Promise.all([
  latestPublicActivity(),
  latestReleases(),
  publicRepoSnapshot(),
  readFile(readmePath, "utf8"),
]);

const generated = renderSection({ activity, releases, snapshot });
const nextReadme = replaceGeneratedSection(readme, generated);

await writeFile(readmePath, nextReadme);
