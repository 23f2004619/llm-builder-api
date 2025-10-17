const { Octokit } = require('octokit');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

// REMOVED GLOBAL INITIALIZATION: const octokit = new Octokit({ auth: GITHUB_PAT });
// REMOVED GLOBAL INITIALIZATION: const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY }); 

const GITHUB_PAT = process.env.GITHUB_PAT;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Standard MIT License text
const MIT_LICENSE = `Permission is hereby granted... (FULL MIT LICENSE TEXT)`; // Ensure this is the full text

// --- Notification Helper (Unchanged) ---
async function postWithRetry(url, payload, retries = 5) {
    // ... (keep the existing postWithRetry function here)
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' }
            });
            console.log(`Successfully notified evaluation API (Round ${payload.round}). Status: ${response.status}`);
            return response;
        } catch (error) {
            const delay = Math.pow(2, i) * 1000; 
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            if (i === retries - 1) throw new Error(`Failed to notify evaluation API after ${retries} attempts.`);
        }
    }
}

// --- Utility helpers ---
function slugifyTask(task) {
    if (!task) return `task-${Date.now().toString(36)}`;
    // lower-case, keep alnum and - , replace others with -
    const s = String(task).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (s.length === 0) return `task-${Date.now().toString(36)}`;
    return s.length > 50 ? `${s.slice(0, 40)}-${Date.now().toString(36).slice(0,6)}` : s;
}

function redactSecretsInContent(content) {
    if (!content || typeof content !== 'string') return content;
    // very small heuristic-based redaction to avoid committing obvious secrets
    return content
        .replace(/(GITHUB_PAT|GEMINI_API_KEY|EXPECTED_SECRET|SECRET)\s*[:=]\s*['\"]?\w+['\"]?/gi, '[REDACTED]')
        .replace(/(ghp_[A-Za-z0-9_\-]+)/g, '[REDACTED]')
        .replace(/(sk_live_[A-Za-z0-9_\-]+)/g, '[REDACTED]');
}

async function ghRetry(fn, attempts = 3, delayMs = 1000) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const wait = delayMs * Math.pow(2, i);
            console.warn(`GitHub call failed (attempt ${i+1}): ${e.message}. Retrying in ${wait}ms...`);
            await new Promise(r => setTimeout(r, wait));
        }
    }
    throw lastErr;
}

function safeParseLLMResponse(response) {
    if (!response) throw new Error('Empty LLM response');
    // Try common fields
    if (typeof response === 'string') {
        try { return JSON.parse(response); } catch (e) { throw new Error('LLM returned non-JSON string'); }
    }
    if (response.text) {
        try { return JSON.parse(response.text.trim()); } catch (e) { /* continue */ }
    }
    if (response.data && typeof response.data === 'string') {
        try { return JSON.parse(response.data); } catch (e) { /* continue */ }
    }
    // Last resort: if an array of parts with text exists
    if (Array.isArray(response.contents) && response.contents[0] && response.contents[0].text) {
        try { return JSON.parse(response.contents[0].text); } catch (e) { /* continue */ }
    }
    throw new Error('Unrecognized LLM response format');
}

// --- LLM Interaction Helper (Gemini) ---
async function generateAppCode(aiInstance, brief, attachments, round, existingCode = {}) { // NOW ACCEPTS AI INSTANCE
    // 1. Create a detailed, structured prompt for Gemini.
    const systemInstruction = `You are an expert web developer tasked with creating a minimal, functional web application hosted on GitHub Pages. You must satisfy all constraints in the brief. The output MUST be a single JSON object.`;

    const userContent = `
Task Round: ${round}
Application Brief: "${brief}"
Attached Files (handle these data URIs if necessary): ${attachments.map(a => `${a.name} (${a.url.substring(0, 30)}...)`).join(', ')}
Evaluation Checks to Satisfy: [List the checks from the request JSON here, if available]

${round === 2 ? `Existing Codebase:\n\nindex.html:\n${existingCode['index.html'] || 'N/A'}\n\nscript.js:\n${existingCode['script.js'] || 'N/A'}` : ''}

Generate ONLY the JSON object with the required files.
Output JSON Format (mandatory):
{
    "index.html": "...",
    "script.js": "...",
    "README.md": "..."
}
`;

    // 2. Call the Gemini API using JSON mode.
    try {
        const response = await aiInstance.models.generateContent({ // USE PASSED INSTANCE
            model: "gemini-2.5-flash", 
            contents: [{ role: "user", parts: [{ text: userContent }] }],
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json", 
                responseSchema: {
                    type: "object",
                    properties: {
                        "index.html": { "type": "string" },
                        "script.js": { "type": "string" },
                        "README.md": { "type": "string" }
                    },
                    required: ["index.html", "README.md"]
                }
            }
        });

        const codeJson = JSON.parse(response.text.trim());
        return codeJson;

    } catch (error) {
        console.error("Gemini Code Generation Failed:", error.message);
        throw new Error("Failed to generate application code using Gemini.");
    }
}

// --- Main Processor (The Orchestrator) ---
async function processRequest(data) {
    const { email, task, round, nonce, brief, attachments, evaluation_url } = data;
    
    // 🎯 NEW: LAZY INITIALIZATION INSIDE THE FUNCTION
    const octokit = new Octokit({ auth: GITHUB_PAT });
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    // This prevents the global crash and confirms variables are loaded before use.
    
    const repoName = `project-${slugifyTask(task)}`;
    const GITHUB_PAGES_USERNAME = GITHUB_USERNAME.toLowerCase(); 
    const repoUrl = `https://github.com/${GITHUB_USERNAME}/${repoName}`;
    const pagesUrl = `https://${GITHUB_PAGES_USERNAME}.github.io/${repoName}/`;
    let commitSha = '';

    console.log(`Starting ${round === 1 ? 'Build' : 'Revision'} for task: ${task}`);

    // A. CODE GENERATION/REVISION
    // For round 2, attempt to fetch existing files to provide context to the LLM
    let existingCode = {};
    if (round === 2) {
        try {
            const possibleFiles = ['index.html', 'script.js', 'README.md'];
            for (const p of possibleFiles) {
                try {
                    const contentRes = await octokit.rest.repos.getContent({ owner: GITHUB_USERNAME, repo: repoName, path: p, ref: 'main' });
                    const fileData = Array.isArray(contentRes.data) ? contentRes.data[0] : contentRes.data;
                    if (fileData && fileData.content) {
                        existingCode[p] = Buffer.from(fileData.content, 'base64').toString('utf8');
                    }
                } catch (e) {
                    // File may not exist yet — ignore
                }
            }
        } catch (e) {
            console.warn('Could not fetch existing code for round 2:', e.message);
        }
    }

    // Call LLM and parse safely
    let llmResp;
    try {
        llmResp = await generateAppCode(ai, brief, attachments || [], round, existingCode);
    } catch (e) {
        console.error('LLM generation failed:', e.message);
        throw e;
    }
    let codeFiles = llmResp;
    if (round === 1) {
        codeFiles['LICENSE'] = MIT_LICENSE;
    }
    
    // B. GITHUB BUILD/DEPLOY (Now uses locally initialized Octokit instance)
    try {
        if (round === 1) {
            // 1. Create Repository (with retries)
            await ghRetry(() => octokit.rest.repos.createForAuthenticatedUser({ name: repoName, private: false, description: `LLM-generated app for task: ${task}` }));
            console.log(`Repo created: ${repoUrl}`);
        }
        
        // 2. Commit and Push logic 
        const commitMessage = round === 1 ? 'Initial build via LLM' : `Round 2 Revision: ${brief.substring(0, 50)}...`;
        let baseSha = undefined;
        
        if (round === 2) {
             const branch = await octokit.rest.repos.getBranch({ owner: GITHUB_USERNAME, repo: repoName, branch: 'main' });
             baseSha = branch.data.commit.sha;
        }

        // Prepare files to commit, handling attachments and binary content.
        function parseDataUri(uri) {
            const m = uri.match(/^data:([^;]+)(;base64)?,(.+)$/);
            if (!m) return null;
            return { mime: m[1], isBase64: !!m[2], data: m[3] };
        }

        // Merge attachments into codeFiles (do not overwrite files from LLM unless same name)
        if (attachments && Array.isArray(attachments)) {
            for (const att of attachments) {
                if (!att || !att.name || !att.url) continue;
                const parsed = parseDataUri(att.url);
                if (!parsed) continue;
                const lowerMime = parsed.mime.split('/')[0];
                if (parsed.isBase64 && (lowerMime === 'image' || lowerMime === 'audio' || lowerMime === 'video')) {
                    // binary — keep base64 and mark for blob creation
                    codeFiles[att.name] = { __binary: true, content: parsed.data }; // base64
                } else {
                    // text or non-binary — decode to utf8 and include
                    const text = parsed.isBase64 ? Buffer.from(parsed.data, 'base64').toString('utf8') : decodeURIComponent(parsed.data);
                    // Only set file if LLM didn't already provide it
                    if (!codeFiles[att.name]) codeFiles[att.name] = text;
                }
            }
        }

        // Build tree entries — for binary files create blobs first and reference by sha
        const filesToCommit = [];
        // First, create blobs for binary attachments
        for (const [path, value] of Object.entries(codeFiles)) {
            // redact obvious secrets from text content
            if (value && typeof value === 'string') {
                codeFiles[path] = redactSecretsInContent(value);
            }
            if (value && typeof value === 'object' && value.__binary) {
                // create a base64-encoded blob
                const blob = await ghRetry(() => octokit.rest.git.createBlob({ owner: GITHUB_USERNAME, repo: repoName, content: value.content, encoding: 'base64' }));
                filesToCommit.push({ path, mode: '100644', type: 'blob', sha: blob.data.sha });
            } else {
                // text content
                const text = typeof value === 'string' ? value : String(value);
                filesToCommit.push({ path, mode: '100644', type: 'blob', content: text });
            }
        }

        // Create tree; omit base_tree for initial commit
        const treeParams = { owner: GITHUB_USERNAME, repo: repoName, tree: filesToCommit };
        if (baseSha) treeParams.base_tree = baseSha;
    const tree = await ghRetry(() => octokit.rest.git.createTree(treeParams));

    const newCommit = await ghRetry(() => octokit.rest.git.createCommit({ owner: GITHUB_USERNAME, repo: repoName, message: commitMessage, tree: tree.data.sha, parents: baseSha ? [baseSha] : [] }));

        // If this is the first commit (no existing branch), create the ref. Otherwise update.
        const refName = 'refs/heads/main';
        if (!baseSha) {
            await ghRetry(() => octokit.rest.git.createRef({ owner: GITHUB_USERNAME, repo: repoName, ref: refName, sha: newCommit.data.sha }));
        } else {
            await ghRetry(() => octokit.rest.git.updateRef({ owner: GITHUB_USERNAME, repo: repoName, ref: 'heads/main', sha: newCommit.data.sha }));
        }

        commitSha = newCommit.data.sha;
        console.log(`Code committed. SHA: ${commitSha}`);
        
        if (round === 1) {
            // 3. Enable GitHub Pages using the REST API (PUT /repos/{owner}/{repo}/pages)
            await ghRetry(() => octokit.request('PUT /repos/{owner}/{repo}/pages', {
                owner: GITHUB_USERNAME,
                repo: repoName,
                source: { branch: 'main' }
            }));
            console.log("GitHub Pages enabled (requested).");
        }

        // 4. Wait / Poll for Pages Deployment (CRITICAL)
        // Poll the pages URL until it returns 200 or until timeout (default 5 minutes)
        const pollIntervalMs = 8000; // 8s between attempts
        const maxWaitMs = 5 * 60 * 1000; // 5 minutes
        const start = Date.now();
        let pagesOk = false;
        console.log(`Polling ${pagesUrl} for up to ${Math.round(maxWaitMs / 1000)}s...`);
        while (Date.now() - start < maxWaitMs) {
            try {
                const r = await axios.get(pagesUrl, { timeout: 5000, validateStatus: null });
                if (r.status === 200) { pagesOk = true; break; }
                console.log(`Pages not ready yet (status ${r.status}). Retrying in ${pollIntervalMs / 1000}s...`);
            } catch (e) {
                console.log(`Pages fetch attempt failed: ${e.message}. Retrying in ${pollIntervalMs / 1000}s...`);
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        if (!pagesOk) console.warn(`Pages did not become ready within the timeout. pages_url: ${pagesUrl}`);
        
    } catch (error) {
        console.error("GitHub/Deployment Error:", error.message);
        console.error("GitHub API Error Details:", error.response?.data);
        throw new Error("Failed during GitHub operations or deployment wait.");
    }

    // C. NOTIFY EVALUATION API
    const payload = { email, task, round, nonce, repo_url: repoUrl, commit_sha: commitSha, pages_url: pagesUrl };
    await postWithRetry(evaluation_url, payload);

    console.log(`✅ Task ${task}, Round ${round} complete and notified.`);
}

module.exports = processRequest;
