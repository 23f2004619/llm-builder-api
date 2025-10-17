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

// Do NOT require the processor at module load time. Lazy-require inside the handler
// to avoid module-load crashes in the serverless environment and to allow health checks.

const app = express();
const EXPECTED_SECRET = process.env.EXPECTED_SECRET;

app.use(bodyParser.json({ limit: '50mb' }));

// Health check route for GET requests (helps debugging and prevents 500 on browser visits)
app.get('/', (req, res) => {
    return res.status(200).json({ status: 'ok', message: 'API endpoint is up. POST to this endpoint with the task JSON.' });
});

// 🎯 CRITICAL: The Express route must be '/'
app.post('/', (req, res) => {
    // Lazy-require the processor to avoid crashes at module import time.
    let processRequest;
    try {
        processRequest = require('../processor');
    } catch (e) {
        console.error('Failed to load processor module:', e);
        // Return 500 so the caller knows there's an internal setup problem
        return res.status(500).json({ error: 'Processor module failed to load.' });
    }

    const data = req.body;
    const { secret, task, round } = data || {};

    // 1. Verify Secret
    if (!secret || secret !== EXPECTED_SECRET) {
        console.error(`Unauthorized attempt for task ${task}, round ${round}`);
        // Return 403 Forbidden
        return res.status(403).json({ error: "Invalid secret provided." });
    }

    // 2. Send HTTP 200 JSON response immediately
    res.status(200).json({ status: "Request accepted and processing asynchronously." });

    // 3. Process Asynchronously 
    Promise.resolve().then(() => processRequest(data)).catch(err => {
        console.error(`Critical Error during async processing for task ${task}:`, err);
    });
});

// Basic error handler to avoid uncaught exceptions from crashing the function
app.use((err, req, res, next) => {
    console.error('Unhandled error in Express app:', err);
    try {
        if (!res.headersSent) res.status(500).json({ error: 'internal_server_error' });
    } catch (e) {
        // ignore
    }
});

// CRITICAL: Export the Express app instance as the Serverless Function handler
module.exports = app;
