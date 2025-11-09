#!/usr/bin/env node

const fs = require('fs');

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const ctx = JSON.parse(input || '{}');
    const payload = {
      result: {
        echoed: ctx.args?.text ?? null,
        toolName: ctx.toolName,
        callId: ctx.callId
      }
    };
    process.stdout.write(JSON.stringify(payload));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
});
