llm-builder-api

This repository implements a student-side automated builder API for the assignment: it receives task requests (JSON), uses an LLM to generate or revise a small web app, creates a GitHub repository, enables GitHub Pages, and notifies an evaluation endpoint.

Summary (submission-ready checklist)
- API endpoint: POST / (served from `api/index.js`) behind Vercel rewrite `/api-endpoint` → `/api/index.js`
- Secret verification: checks `secret` in incoming JSON against `EXPECTED_SECRET` env var
- GitHub integration: uses `octokit` with `GITHUB_PAT` and `GITHUB_USERNAME` to create public repos, commit files and enable Pages
- LLM integration: scaffolding present for Gemini (`@google/genai`), with safer parsing and retries
- Attachments: handles data-URI attachments (text and binary) and includes them in commits
- Pages verification: polls the resulting Pages URL for HTTP 200 up to a timeout

Required environment variables (set these in Vercel or locally before testing):
- EXPECTED_SECRET — secret used to validate instructor requests
- GITHUB_PAT — personal access token with repo + pages permissions
- GITHUB_USERNAME — the GitHub account used to create repos
- GEMINI_API_KEY — (optional) API key for the Gemini/LLM integration (if not present, LLM calls will fail)

Sample request (instructor flow)
Use this curl to test (replace values):

```powershell
$body = @{
	email = 'student@example.com'
	secret = 'your_expected_secret'
	task = 'sample-task-123'
	round = 1
	nonce = 'nonce-abc-123'
	brief = 'Publish a static page that shows Hello World in #hello'
	checks = @()
	evaluation_url = 'https://example.com/notify'
} | ConvertTo-Json -Depth 10

curl -X POST "https://new-sandy-mu-96.vercel.app/api-endpoint" -H "Content-Type: application/json" -d $body
```

What I changed to make this submission-ready
- Added MIT license and README
- Improved `processor.js` to:
	- sanitize `task` to a safe repo name
	- fetch existing files for round 2 and pass them to the LLM
	- parse data-URI attachments and create blobs for binary attachments
	- poll Pages URL instead of a fixed sleep
	- redact obvious secret patterns from files before committing
	- add small retry wrapper for critical GitHub calls

What you must verify on Vercel before submitting
1. Environment variables are set in the Vercel dashboard (EXPECTED_SECRET, GITHUB_PAT, GITHUB_USERNAME, GEMINI_API_KEY if used).
2. The `${GITHUB_PAT}` has scopes: repo (public repo creation) and pages (or repo + workflow if needed).
3. Push these repo changes to GitHub and let Vercel build/deploy. Confirm the API path responds to POST requests.
4. Use the sample curl above to send a test round-1 request. Confirm the API responds 200 and later the evaluation endpoint receives a POST with repo_url/commit_sha/pages_url.

Recommended follow-ups (optional but improve score)
- Add a preflight secret scanner using a specialized tool (gitleaks) if allowed.
- Expand README with examples of round 2 and more elaborate briefs.
- Provide a small `scripts/send_sample_request.js` to automate instructor-style request creation (I can add this).

If you'd like, I will now:
- Add a small test script to send a sample request and print the evaluation callback result.
- Add a Playwright smoke test to validate the generated site.

If you're ready, push these changes, set the env vars on Vercel, then run the sample curl above. If you want me to push further improvements, tell me which of the recommended follow-ups to prioritize.
