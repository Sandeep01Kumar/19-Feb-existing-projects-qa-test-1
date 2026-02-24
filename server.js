const http = require('http');

const hostname = '127.0.0.1';
const port = 3000;

// CHANGE 2 — Enhanced request callback with stream error handling
// Addresses Root Cause 3: No Request/Response Error Handling
// The request callback now includes error listeners on both the request
// and response streams to handle client aborts and write failures gracefully.
const server = http.createServer((req, res) => {
  // Handle request stream errors (e.g., client aborts mid-request)
  req.on('error', (err) => {
    console.error(`Request error: ${err.message}`);
  });
  // Handle response stream errors (e.g., write failures)
  res.on('error', (err) => {
    console.error(`Response error: ${err.message}`);
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

// CHANGE 3 — Timeout configuration
// Addresses Root Cause 5: No Timeout or Connection Management
// Explicitly set non-zero timeout values to prevent resource exhaustion
// from slow clients, idle keep-alive connections, or Slowloris-style attacks.
server.keepAliveTimeout = 5000;   // Close idle keep-alive connections after 5 seconds
server.headersTimeout = 60000;    // Allow 60 seconds to receive complete request headers

// CHANGE 4 — Server error handler
// Addresses Root Cause 1: No Server Error Event Handler
// Without this listener, EADDRINUSE and other binding errors propagate as
// uncaught exceptions, crashing the process with a raw stack trace.
server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

// CHANGE 5 — Client error handler
// Addresses Root Cause 3: No Request/Response Error Handling
// Handles malformed HTTP requests (e.g., invalid headers, protocol errors)
// by sending a proper 400 Bad Request response instead of crashing.
server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// CHANGE 6 — Connection tracking for cleanup
// Addresses Root Cause 5: No Timeout or Connection Management
// Tracks all open connections in a Set for O(1) add/delete operations.
// Connections are automatically removed when they close naturally.
// This enables proper cleanup during graceful shutdown.
const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

// CHANGE 7 — Graceful shutdown handlers
// Addresses Root Cause 2: No Graceful Shutdown Handlers
// Without these signal handlers, SIGTERM and SIGINT cause immediate process
// termination, severing in-flight HTTP requests without draining connections.
function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Destroy remaining connections to speed up shutdown
  for (const socket of connections) {
    socket.destroy();
  }
  // Force exit if graceful shutdown takes too long (5 second timeout)
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// CHANGE 8 — Preserved server.listen() call
// Binds the server to the loopback address on port 3000 and logs the startup message.
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

// CHANGE 9 — Process-level safety nets
// Addresses Root Cause 4: No Process-Level Safety Nets
// These are last-resort handlers that catch any uncaught exceptions or
// unhandled promise rejections during server operation. They log the error
// and exit with code 1 to prevent silent failures or undefined behavior.
process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});
