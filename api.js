// server.js
// Vercel handles .env loading, but we include it for local testing
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
const express = require('express');
const bodyParser = require('body-parser');
const processRequest = require('./processor'); 

const app = express();
const EXPECTED_SECRET = process.env.EXPECTED_SECRET;

// Vercel Serverless functions need to explicitly handle request body.
app.use(bodyParser.json({ limit: '50mb' })); 

// The main API endpoint that Vercel routes to
app.post('/api-endpoint', (req, res) => {
    const data = req.body;
    const { secret, task, round } = data;

    // 1. Verify Secret
    if (!secret || secret !== EXPECTED_SECRET) {
        console.error(`Unauthorized attempt for task ${task}, round ${round}`);
        // Log the failure but do not leak details
        return res.status(403).json({ error: "Invalid secret" });
    }

    // 2. Send HTTP 200 JSON response immediately
    res.status(200).json({ status: "Request accepted, processing in background" });

    // 3. Process Asynchronously 
    // This allows the Vercel function to terminate quickly while the task runs.
    processRequest(data).catch(err => {
        console.error(`Critical Error during async processing for task ${task}:`, err);
    });
});

// For Vercel, we export the app instance
module.exports = app;