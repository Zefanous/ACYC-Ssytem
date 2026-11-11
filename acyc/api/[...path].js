'use strict';
// Vercel entry point: every /api/* request is served by the same app that runs locally.
// Static files (public/) are served by Vercel itself; security headers for them are set in vercel.json.
const { createApp } = require('../src/server');
let app;
module.exports = (req, res) => {
  if (!app) {
    if (process.env.VERCEL && process.env.STORAGE !== 'sheets') {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Server is not configured: set STORAGE=sheets and the Google variables in Vercel.' }));
    }
    app = createApp();
  }
  app.server.emit('request', req, res);
};
