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
    
    const repoName = `project-${task}`;
    const GITHUB_PAGES_USERNAME = GITHUB_USERNAME.toLowerCase(); 
    const repoUrl = `https://github.com/${GITHUB_USERNAME}/${repoName}`;
    const pagesUrl = `https://${GITHUB_PAGES_USERNAME}.github.io/${repoName}/`;
    let commitSha = '';

    console.log(`Starting ${round === 1 ? 'Build' : 'Revision'} for task: ${task}`);

    // A. CODE GENERATION/REVISION
    let codeFiles = await generateAppCode(ai, brief, attachments, round); // PASS AI INSTANCE
    if (round === 1) {
        codeFiles['LICENSE'] = MIT_LICENSE; 
    }
    
    // B. GITHUB BUILD/DEPLOY (Now uses locally initialized Octokit instance)
    try {
        if (round === 1) {
            // 1. Create Repository
            await octokit.rest.repos.createForAuthenticatedUser({ name: repoName, private: false, description: `LLM-generated app for task: ${task}` });
            console.log(`Repo created: ${repoUrl}`);
        }
        
        // 2. Commit and Push logic 
        const commitMessage = round === 1 ? 'Initial build via LLM' : `Round 2 Revision: ${brief.substring(0, 50)}...`;
        let baseSha = undefined;
        
        if (round === 2) {
             const branch = await octokit.rest.repos.getBranch({ owner: GITHUB_USERNAME, repo: repoName, branch: 'main' });
             baseSha = branch.data.commit.sha;
        }

        const filesToCommit = Object.keys(codeFiles).map(path => ({ path, mode: '100644', type: 'blob', content: codeFiles[path] }));
        
        const tree = await octokit.rest.git.createTree({ owner: GITHUB_USERNAME, repo: repoName, base_tree: baseSha, tree: filesToCommit });

        const newCommit = await octokit.rest.git.createCommit({ owner: GITHUB_USERNAME, repo: repoName, message: commitMessage, tree: tree.data.sha, parents: baseSha ? [baseSha] : [] });

        await octokit.rest.git.updateRef({ owner: GITHUB_USERNAME, repo: repoName, ref: 'heads/main', sha: newCommit.data.sha });

        commitSha = newCommit.data.sha;
        console.log(`Code committed. SHA: ${commitSha}`);
        
        if (round === 1) {
            // 3. Enable GitHub Pages
            await octokit.rest.repos.enablePagesOnGitHubPages({
                owner: GITHUB_USERNAME,
                repo: repoName,
                source: { branch: 'main' }
            });
            console.log("GitHub Pages enabled.");
        }

        // 4. Wait for Pages Deployment (CRITICAL)
        console.log("Waiting 45 seconds for Pages deployment...");
        await new Promise(resolve => setTimeout(resolve, 45000));
        
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
