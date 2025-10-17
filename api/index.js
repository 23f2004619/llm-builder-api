// api/index.js (This file handles the immediate request and dispatch)

// Vercel handles .env loading from the dashboard secrets
// We keep this check for local testing using `vercel dev`
if (process.env.NODE_ENV !== 'production') {
    // FIX: Use try/catch to prevent bundling crashes in production
    try {
        require('dotenv').config();
    } catch (e) {
        // Fail silently if dotenv module isn't found in cloud environment,
        // as Vercel handles ENV variables directly.
    }
}

const express = require('express');
const bodyParser = require('body-parser');

// Require the processor file from the parent directory
const processRequest = require('../processor'); 

const app = express();
const EXPECTED_SECRET = process.env.EXPECTED_SECRET;

app.use(bodyParser.json({ limit: '50mb' })); 

// 🎯 CRITICAL FIX: The Express route must be '/'
app.post('/', (req, res) => {
// ... (The rest of the code logic is exactly correct and remains unchanged)

    const data = req.body;
    const { secret, task, round } = data;

    // 1. Verify Secret
    if (!secret || secret !== EXPECTED_SECRET) {
        console.error(`Unauthorized attempt for task ${task}, round ${round}`);
        // Return 403 Forbidden
        return res.status(403).json({ error: "Invalid secret provided." });
    }

    // 2. Send HTTP 200 JSON response immediately
    res.status(200).json({ status: "Request accepted and processing asynchronously." });

    // 3. Process Asynchronously 
    processRequest(data).catch(err => {
        console.error(`Critical Error during async processing for task ${task}:`, err);
    });
});

// CRITICAL: Export the Express app instance as the Serverless Function handler
module.exports = app;
