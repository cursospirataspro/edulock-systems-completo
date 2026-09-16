'use strict';
const fs = require('fs');
let src = fs.readFileSync('server.js', 'utf8');
const original = src;

// Step 1: Add 'await' before all db.method( calls that don't already have await
// We process line by line to be safe
const lines = src.split('\n');
const result = lines.map(line => {
    // Skip lines that already have await db.
    // For lines with db.something( but no await before it, add await
    // but only inside function bodies (indented), skip property-access patterns
    return line.replace(/(?<![.\w$'"`])db\.([a-zA-Z_][a-zA-Z0-9_]*)\(/g, (match, fn, offset) => {
        // Check what's before in the line
        const before = line.substring(0, offset);
        // Skip if already awaited
        if (/\bawait\s*$/.test(before)) return match;
        // Skip if it's a property access like obj.db.fn or require
        if (/\.\s*$/.test(before)) return match;
        // Skip typeof/instanceof checks
        if (/\b(typeof|instanceof)\s+$/.test(before)) return match;
        return 'await db.' + fn + '(';
    });
});
src = result.join('\n');

// Step 2: Convert route handler arrow functions to async
// Pattern: (req, res) => { in route registrations
// app.get('/path', middleware, (req, res) => {   →   app.get('/path', middleware, async (req, res) => {
// app.get('/path', (req, res) => {   →   app.get('/path', async (req, res) => {
src = src.replace(/(\(req,\s*res\)\s*=>)/g, 'async (req, res) =>');

// Also handle: , (req, res, next) =>
src = src.replace(/(\(req,\s*res,\s*next\)\s*=>)/g, 'async (req, res, next) =>');

// Fix double async if any were already async
src = src.replace(/\basync\s+async\b/g, 'async');

// Verify
const dbCallsWithoutAwait = (src.match(/(?<![.\w$'"`await\s])db\.[a-zA-Z]+\(/g) || []).length;
const awaitCalls = (src.match(/\bawait\s+db\.[a-zA-Z]+\(/g) || []).length;
console.log('db calls with await now:', awaitCalls);
console.log('db calls possibly missing await:', dbCallsWithoutAwait);

fs.writeFileSync('server.js', src, 'utf8');
console.log('Done - server.js updated');
