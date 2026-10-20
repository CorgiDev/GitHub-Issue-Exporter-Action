# Issue Exporter Workflow

This is independent of the GitHub Pages app. No existing Pages files or PAT
settings need to change.

## Run and download

1. Add this `.github` directory to the repository whose issues you want to export.
   The workflow must be on its default branch to appear in the manual-run UI.
2. Open **Actions > Export issues > Run workflow**.
3. Enter a required GitHub issue search query, for example:

   ```text
   label:Severity-1,Severity-2 label:service:npm -label:project:npm_cli
   ```

4. Open the successful run and select its **issue-export-...** artifact, or use
   the download link in the run summary.
5. Extract the downloaded ZIP and open `index.html`.

The artifact contains an index, individual issue pages with descriptions and all
issue comments, a stylesheet, and `issues.json`. Issue text and comments work
offline. Media remains linked to its original location: images, videos, and other
external resources are not downloaded and can require internet access and GitHub
authorization. The exporter itself calls only GitHub's API.

Artifacts are stored by GitHub Actions, not committed or published to Pages.
They expire after **7 days**, can be deleted earlier, and count toward Actions
storage allowances. Downloads require GitHub sign-in and repository read access.
Exports can contain sensitive issue data; anyone with access to the downloaded
ZIP can read it.

## Search behavior

- The repository and owner come from `GITHUB_REPOSITORY`, not user inputs.
- `is:issue` is always applied. Pull-request queries are rejected.
- If no `state:` qualifier is supplied, `state:open` is added. Use `state:closed`
  for closed issues. In particular, `is:closed` alone does not suppress this
  default; use `state:closed` instead.
- Use GitHub's search syntax for other filters. Multiple `label:` qualifiers
  require all labels; comma-separated alternatives match any listed label.
- Multi-word labels must be quoted: `label:"help wanted"`.
  Alternatives can also be quoted separately: `label:"help wanted","good first issue"`.
  A comma inside a quoted name is literal: `label:"priority, high"`.
- All positive and excluded label names are checked, case-insensitively, against
  the complete repository label list before searching. Unknown labels fail the
  run with an error listing each invalid option. Empty label values also fail.
- `repo:`, `org:`, and `user:` qualifiers are rejected to keep the export scoped
  to the repository running the workflow. Parentheses and OR expressions are
  grouped inside that repository scope, using GitHub's advanced search mode.
- GitHub search indexing can lag behind issue updates. Incomplete searches and
  queries matching more than GitHub's 1,000-result search limit fail rather than
  silently export a partial result. Narrow large queries, for example by date.
- A valid query with no matches still produces an empty index and JSON export.

GitHub reports invalid search syntax and access errors in the workflow logs.
No artifact is uploaded when validation or API requests fail.

## Authentication and permissions

The workflow uses the automatically generated `GITHUB_TOKEN`, with only
`contents: read` and `issues: read`. No PAT or app registration is needed.
The token only grants access within the workflow's repository; installing this
workflow in a fork does not grant access to a private upstream repository.
Running it manually requires write access to the repository and Actions enabled.

The workflow executes the exporter and its tests from the selected branch.
Only run trusted branches. It uses GitHub-hosted Ubuntu runners and Node.js 22,
with no npm dependencies.

## Tests

```sh
node --test .github/scripts/export-issues.test.mjs
```

Tests mock GitHub responses; they do not use credentials or make network requests.
