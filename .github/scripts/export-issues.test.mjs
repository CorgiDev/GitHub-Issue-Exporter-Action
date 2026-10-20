import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectIssues, createApi, prepareQuery, tokenize, validateLabels, writeExport,
} from './export-issues.mjs';

const repository = 'example/project';
const issue = {
  number: 42,
  title: 'An <issue> & title',
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/example/project/issues/42',
  repository_url: 'https://api.github.com/repos/example/project',
  labels: [{ name: 'bug' }],
  user: { login: 'author' },
  body: 'Markdown fallback <script>alert(1)</script>',
  body_html: '<p>Rendered description</p>',
};

test('requires a query and workflow repository', () => {
  for (const query of ['', '  ', undefined]) {
    assert.throws(() => prepareQuery(query, repository), /required/);
  }
  assert.throws(() => prepareQuery('bug', ''), /GITHUB_REPOSITORY/);
});

test('applies issue and open defaults outside the complete input expression', () => {
  const result = prepareQuery('label:Severity-1,Severity-2 label:service:npm -label:project:npm_cli', repository);
  assert.equal(result.query, 'repo:example/project is:issue state:open (label:Severity-1,Severity-2 label:service:npm -label:project:npm_cli)');
  assert.deepEqual(result.labels, ['Severity-1', 'Severity-2', 'service:npm', 'project:npm_cli']);
  assert.equal(prepareQuery('bug OR regression', repository).query,
    'repo:example/project is:issue state:open (bug OR regression)');
});

test('detects actual state qualifiers, not quoted search text', () => {
  assert.equal(prepareQuery('state:closed label:bug', repository).query,
    'repo:example/project is:issue (state:closed label:bug)');
  assert.match(prepareQuery('"state:closed" label:bug', repository).query, /state:open/);
  assert.doesNotMatch(prepareQuery('-state:closed', repository).query, /state:open/);
});

test('parses excluded labels, quoted alternatives, commas, colons and escaped quotes', () => {
  const result = prepareQuery('label:"help wanted","good first issue" -label:"priority, high" label:service:npm label:"say \\"hello\\""', repository);
  assert.deepEqual(result.labels, ['help wanted', 'good first issue', 'priority, high', 'service:npm', 'say "hello"']);
  assert.deepEqual(prepareQuery('"label:fake" label:bug', repository).labels, ['bug']);
});

test('rejects malformed quotes, parentheses and empty label alternatives', () => {
  for (const query of ['label:"bug', 'bug)', '(bug', 'label:', '-label:', 'label:bug,', 'label:""']) {
    assert.throws(() => prepareQuery(query, repository));
  }
  assert.deepEqual(tokenize('(label:bug OR label:"good first issue")'), ['(', 'label:bug', 'OR', 'label:"good first issue"', ')']);
});

test('rejects scope overrides and conflicting pull request qualifiers', () => {
  for (const query of ['repo:elsewhere/project', 'OR org:elsewhere', '-user:someone', 'is:pr', 'type:pr', '-is:issue', 'IS:"pr"']) {
    assert.throws(() => prepareQuery(query, repository));
  }
  assert.doesNotThrow(() => prepareQuery('-is:pr label:bug', repository));
});

test('validates all labels case-insensitively and lists every invalid option', () => {
  assert.doesNotThrow(() => validateLabels(['BUG'], [{ name: 'bug' }]));
  assert.throws(() => validateLabels(['bug', 'missing', 'also missing'], [{ name: 'bug' }]),
    /Invalid label options.*"missing", "also missing"/);
});

test('label validation fails before search or issue export', async () => {
  const calls = [];
  await assert.rejects(collectIssues(async (endpoint) => {
    calls.push(endpoint);
    return [{ name: 'bug' }];
  }, repository, prepareQuery('label:missing -label:also-missing', repository)), /"missing", "also-missing"/);
  assert.deepEqual(calls, ['/repos/example/project/labels?per_page=100&page=1']);
});

test('paginates labels and comments and fetches complete issue detail', async (context) => {
  context.mock.method(console, 'log', () => {});
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint.includes('/labels?')) {
      return endpoint.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, index) => ({ name: `label-${index}` }))
        : [{ name: 'bug' }];
    }
    if (endpoint.startsWith('/search/issues?')) return { total_count: 1, incomplete_results: false, items: [issue] };
    if (endpoint.endsWith('/issues/42')) return issue;
    if (endpoint.includes('/comments?')) {
      return endpoint.endsWith('page=1')
        ? Array.from({ length: 100 }, () => ({ body: 'comment' }))
        : [{ body_html: '<p>Last comment</p>' }];
    }
    assert.fail(`Unexpected request: ${endpoint}`);
  };
  const results = await collectIssues(api, repository, prepareQuery('label:bug', repository));
  assert.equal(results.length, 1);
  assert.equal(results[0].comments.length, 101);
  assert.ok(calls.some((endpoint) => endpoint.startsWith('/search/issues?advanced_search=true&')));
  assert.ok(calls.includes('/repos/example/project/labels?per_page=100&page=2'));
  assert.ok(calls.includes('/repos/example/project/issues/42/comments?per_page=100&page=2'));
});

test('paginates search results', async (context) => {
  context.mock.method(console, 'log', () => {});
  const results = await collectIssues(async (endpoint) => {
    if (endpoint.includes('/labels?') || endpoint.includes('/comments?')) return [];
    if (endpoint.startsWith('/search/issues?')) {
      return { total_count: 101, incomplete_results: false, items: endpoint.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, number) => ({ ...issue, number: number + 1 }))
        : [{ ...issue, number: 101 }] };
    }
    return { ...issue, number: Number(endpoint.split('/').at(-1)) };
  }, repository, prepareQuery('state:open', repository));
  assert.equal(results.length, 101);
  assert.equal(results.at(-1).number, 101);
});

test('fails on truncation, incomplete results, out-of-scope results and PRs', async () => {
  for (const [result, message] of [
    [{ total_count: 1001, items: [] }, /at most 1,000/],
    [{ total_count: 0, incomplete_results: true, items: [] }, /incomplete/],
    [{ total_count: 1, items: [] }, /pagination/],
    [{ total_count: 1, items: [{ ...issue, pull_request: {} }] }, /pull request/],
    [{ total_count: 1, items: [{ ...issue, repository_url: 'https://api.github.com/repos/other/repo' }] }, /outside/],
  ]) {
    await assert.rejects(collectIssues(async (endpoint) => endpoint.includes('/labels?') ? [] : result,
      repository, prepareQuery('state:open', repository)), message);
  }
});

test('propagates API failures and accepts zero matches', async () => {
  await assert.rejects(collectIssues(async () => { throw new Error('API denied'); },
    repository, prepareQuery('bug', repository)), /API denied/);
  assert.deepEqual(await collectIssues(async (endpoint) => endpoint.includes('/labels?') ? []
    : { total_count: 0, items: [] }, repository, prepareQuery('bug', repository)), []);
});

test('API uses authenticated GitHub requests and surfaces failures', async (context) => {
  let request;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ message: 'denied' }), { status: 403 });
  });
  assert.throws(() => createApi(''), /GITHUB_TOKEN/);
  assert.throws(() => createApi('token', 'http://example.com'), /HTTPS/);
  await assert.rejects(createApi('test-token')('/user'), /403.*denied/);
  assert.equal(request.url.origin, 'https://api.github.com');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
  assert.equal(request.options.redirect, 'error');
});

test('CLI exits unsuccessfully and lists invalid included and excluded labels', () => {
  const script = fileURLToPath(new URL('./export-issues.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    globalThis.fetch = async () => new Response(JSON.stringify([{ name: 'bug' }]));
    process.argv[1] = ${JSON.stringify(script)};
    await import(${JSON.stringify(new URL('./export-issues.mjs', import.meta.url).href)});
  `], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_TOKEN: 'test-token',
      GITHUB_REPOSITORY: repository,
      EXPORT_QUERY: 'label:missing -label:also-missing',
      EXPORT_DIRECTORY: os.tmpdir(),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Export failed: Invalid label options.*"missing", "also-missing"/);
  assert.doesNotMatch(result.stdout, /Export complete/);
});

test('writes navigable HTML, rendered content, escaped text and complete JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'issue-export-test-'));
  try {
    const issues = [{ ...issue, comments: [{ user: { login: '<commenter>' }, body: '<unsafe>', created_at: 'now' }] }];
    await writeExport(directory, repository, 'label:bug "<query>"', issues);
    assert.deepEqual((await readdir(directory)).sort(), ['index.html', 'issue-42.html', 'issues.json', 'styles.css']);
    const index = await readFile(path.join(directory, 'index.html'), 'utf8');
    const detail = await readFile(path.join(directory, 'issue-42.html'), 'utf8');
    assert.match(index, /href="issue-42.html"/);
    assert.match(index, /An &lt;issue&gt; &amp; title/);
    assert.match(index, /&lt;query&gt;/);
    assert.match(detail, /href="index.html"/);
    assert.match(detail, /<p>Rendered description<\/p>/);
    assert.match(detail, /&lt;commenter&gt;/);
    assert.match(detail, /&lt;unsafe&gt;/);
    assert.match(detail, /Content-Security-Policy/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'issues.json'), 'utf8')).issues, issues);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('zero-match exports still contain an index and JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'issue-export-test-'));
  try {
    await writeExport(directory, repository, 'state:open', []);
    assert.match(await readFile(path.join(directory, 'index.html'), 'utf8'), /0 issue\(s\)/);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'issues.json'), 'utf8')).issues, []);
  } finally {
    await rm(directory, { recursive: true });
  }
});
