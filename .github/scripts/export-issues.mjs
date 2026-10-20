import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function tokenize(query) {
  const tokens = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  let depth = 0;
  const flush = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (const character of query) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quoted) {
      token += character;
      escaped = true;
    } else if (character === '"') {
      token += character;
      quoted = !quoted;
    } else if (!quoted && (character === '(' || character === ')')) {
      flush();
      depth += character === '(' ? 1 : -1;
      if (depth < 0) throw new Error('Search query contains unmatched parentheses.');
      tokens.push(character);
    } else if (!quoted && /\s/.test(character)) {
      flush();
    } else {
      token += character;
    }
  }
  if (quoted) throw new Error('Search query contains an unclosed quotation mark.');
  if (depth !== 0) throw new Error('Search query contains unmatched parentheses.');
  flush();
  return tokens;
}

function labelValues(value) {
  const values = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\' && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  if (values.some((label) => !label.trim())) {
    throw new Error('Each label: qualifier must contain nonempty label names.');
  }
  return values;
}

export function prepareQuery(input, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) {
    throw new Error('GITHUB_REPOSITORY must identify the workflow repository (owner/repo).');
  }
  const query = input?.trim();
  if (!query) throw new Error('A nonempty GitHub search query is required.');
  const tokens = tokenize(query);
  const labels = new Set();
  let hasState = false;
  for (const token of tokens) {
    const qualifier = token.match(/^(-?)([a-z_-]+):(.*)$/i);
    if (!qualifier) continue;
    const [, negative, name, value] = qualifier;
    const key = name.toLowerCase();
    if (['repo', 'org', 'user'].includes(key)) {
      throw new Error('Do not include repo:, org:, or user: qualifiers; the workflow searches its own repository.');
    }
    if (['is', 'type'].includes(key)) {
      const type = value.replaceAll('"', '').toLowerCase();
      if ((!negative && ['pr', 'pull-request'].includes(type)) || (negative && type === 'issue')) {
        throw new Error('This exporter supports issues only; remove conflicting issue/PR qualifiers.');
      }
    }
    if (key === 'state') hasState = true;
    if (key === 'label') {
      for (const label of labelValues(value)) labels.add(label);
    }
  }
  return {
    query: `repo:${repository} is:issue ${hasState ? '' : 'state:open '}(${query})`,
    labels: [...labels],
  };
}

export function validateLabels(requested, available) {
  const names = new Set(available.map((label) => label.name.toLowerCase()));
  const invalid = requested.filter((label) => !names.has(label.toLowerCase()));
  if (invalid.length) {
    throw new Error(`Invalid label options (not found in this repository): ${invalid.map((label) => JSON.stringify(label)).join(', ')}`);
  }
}

export function createApi(token, apiUrl = 'https://api.github.com') {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  const base = new URL(apiUrl);
  if (base.protocol !== 'https:') throw new Error('The GitHub API URL must use HTTPS.');
  return async (endpoint) => {
    const url = new URL(`${base.href.replace(/\/$/, '')}${endpoint}`);
    if (url.origin !== base.origin) throw new Error('Refusing to send credentials outside the GitHub API.');
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.full+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status}) for ${endpoint}: ${await response.text()}`);
    }
    return response.json();
  };
}

async function paginate(api, endpoint) {
  const collected = [];
  for (let page = 1; ; page++) {
    const items = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    collected.push(...items);
    if (items.length < 100) return collected;
  }
}

export async function collectIssues(api, repository, prepared) {
  const root = `/repos/${repository}`;
  const labels = await paginate(api, `${root}/labels`);
  validateLabels(prepared.labels, labels);
  const issues = [];
  for (let page = 1; ; page++) {
    // Legacy search can silently miss grouped qualifiers without advanced mode.
    const result = await api(`/search/issues?advanced_search=true&q=${encodeURIComponent(prepared.query)}&per_page=100&page=${page}`);
    if (result.incomplete_results) throw new Error('GitHub returned incomplete search results. Narrow the query and retry.');
    if (result.total_count > 1000) {
      throw new Error(`The query matched ${result.total_count} issues. GitHub search exposes at most 1,000 results; narrow the query.`);
    }
    for (const item of result.items) {
      if (item.pull_request || item.repository_url?.toLowerCase() !== `https://api.github.com${root}`.toLowerCase()) {
        throw new Error('Search returned a pull request or an issue outside this repository; no export was generated.');
      }
      issues.push(item);
    }
    if (issues.length >= result.total_count) break;
    if (!result.items.length || page >= 10) {
      throw new Error('Search pagination ended before all matching issues were returned. Retry the export.');
    }
  }
  const detailed = [];
  for (const issue of issues) {
    const detail = await api(`${root}/issues/${issue.number}`);
    const comments = await paginate(api, `${root}/issues/${issue.number}/comments`);
    detailed.push({ ...detail, comments });
    console.log(`Exported issue #${issue.number} (${comments.length} comments).`);
  }
  return detailed;
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const labelsHtml = (labels) => labels.map((label) => `<span class="label">${escapeHtml(label.name)}</span>`).join(' ');
const bodyHtml = (item) => item.body_html ?? `<pre>${escapeHtml(item.body)}</pre>`;

function documentHtml(title, content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src https: data:; media-src https: data:; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="styles.css">
</head><body><main>${content}</main></body></html>`;
}

export async function writeExport(directory, repository, query, issues) {
  await mkdir(directory, { recursive: true });
  const rows = issues.map((issue) => `<tr><td>${issue.number}</td>
<td><a href="issue-${issue.number}.html">${escapeHtml(issue.title)}</a></td>
<td>${escapeHtml(issue.created_at)}</td><td>${escapeHtml(issue.state)}</td>
<td>${labelsHtml(issue.labels)}</td></tr>`).join('\n');
  await writeFile(path.join(directory, 'index.html'), documentHtml(`${repository} issues`, `
<h1>${escapeHtml(repository)} issues</h1>
<p>Exported ${escapeHtml(new Date().toISOString())}. ${issues.length} issue(s).</p>
<h2>Search query</h2><pre>${escapeHtml(query)}</pre>
<p>Issue text and comments are available offline. Images, videos, and external links may require internet access and GitHub authorization.</p>
<table><thead><tr><th>ID</th><th>Title</th><th>Created</th><th>State</th><th>Labels</th></tr></thead><tbody>${rows}</tbody></table>`));
  for (const issue of issues) {
    const comments = issue.comments.map((comment) => `<article>
<h3>${escapeHtml(comment.user?.login ?? 'Unknown')} - ${escapeHtml(comment.created_at)}</h3>
${bodyHtml(comment)}</article>`).join('\n');
    await writeFile(path.join(directory, `issue-${issue.number}.html`), documentHtml(`#${issue.number}: ${issue.title}`, `
<a href="index.html">Back to issues</a><h1>#${issue.number}: ${escapeHtml(issue.title)}</h1>
<p>Author: ${escapeHtml(issue.user?.login ?? 'Unknown')} | State: ${escapeHtml(issue.state)} | Created: ${escapeHtml(issue.created_at)}</p>
<p><a href="${escapeHtml(issue.html_url)}" rel="noreferrer">Original GitHub issue</a></p>
<details open><summary>Labels</summary>${labelsHtml(issue.labels)}</details>
<h2>Description</h2><article>${bodyHtml(issue)}</article>
<details open><summary>Comments (${issue.comments.length})</summary>${comments || '<p>No comments.</p>'}</details>`));
  }
  await writeFile(path.join(directory, 'styles.css'), `
:root { font-family: system-ui, sans-serif; color: #24292f; background: #f6f8fa; }
body { margin: 0; padding: 2rem; line-height: 1.6; }
main { max-width: 1100px; margin: auto; padding: 2rem; background: white; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .75rem; border-bottom: 1px solid #d0d7de; }
a { color: #0969da; } article { border: 1px solid #d0d7de; padding: 1rem; margin: 1rem 0; }
.label { display: inline-block; border-radius: 1rem; padding: .1rem .5rem; background: #ddf4ff; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; } img, video { max-width: 100%; }
`);
  await writeFile(path.join(directory, 'issues.json'), JSON.stringify({ repository, query, issues }, null, 2));
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const prepared = prepareQuery(process.env.EXPORT_QUERY, repository);
  const directory = process.env.EXPORT_DIRECTORY;
  if (!directory) throw new Error('EXPORT_DIRECTORY is required.');
  console.log(`Search query: ${JSON.stringify(prepared.query)}`);
  const issues = await collectIssues(createApi(process.env.GITHUB_TOKEN), repository, prepared);
  await writeExport(directory, repository, prepared.query, issues);
  console.log(`Export complete: ${issues.length} issues.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Issue export\n\nExported ${issues.length} issues from ${repository}.\n`, { flag: 'a' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
