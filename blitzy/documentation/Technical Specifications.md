# Technical Specification

# 0. Agent Action Plan

## 0.1 Executive Summary

Based on the bug description, the Blitzy platform understands that the bug is a **comprehensive robustness deficiency in `server.js`** — the sole functional runtime component of the `hao-backprop-test` Node.js repository. The 14-line HTTP server, built on Node.js's built-in `http` module and bound to `127.0.0.1:3000`, lacks five critical categories of defensive programming:

- **Missing Error Handling** — No `server.on('error', ...)` listener exists. When port 3000 is already occupied, the process crashes with an unhandled `EADDRINUSE` error that propagates as an uncaught exception. No `process.on('uncaughtException')` or `process.on('unhandledRejection')` safety nets are present. No `clientError` event handler exists for malformed HTTP requests.

- **No Graceful Shutdown** — No `process.on('SIGTERM', ...)` or `process.on('SIGINT', ...)` signal handlers are registered. When the process receives a termination signal (e.g., Ctrl+C or `kill`), it terminates immediately without draining in-flight connections, logging the shutdown event, or performing any cleanup.

- **No Input Validation** — The request callback at line 6 receives `(req, res)` but never inspects `req.method`, `req.url`, `req.headers`, or any request properties. Every request — regardless of HTTP method, path, or payload — unconditionally receives an HTTP 200 with a static body. There is no differentiation between valid and invalid requests.

- **No Resource Cleanup** — Open connections are not tracked, `server.close()` is never called programmatically, and no cleanup hooks exist for releasing resources upon shutdown. There is no timeout configuration on the server (e.g., `server.timeout`, `server.keepAliveTimeout`, `server.headersTimeout`).

- **Non-Robust HTTP Request Processing** — The server has no `req.on('error', ...)` handler for request-stream errors, no `res.on('error', ...)` handler for response-stream errors, and no centralized error-handling mechanism. The server relies entirely on Node.js's default behavior for all error scenarios.

The user's requirement translates to adding targeted, minimal error-handling patterns — signal handlers, server-error listeners, request-level error handling, graceful shutdown logic, connection tracking, and timeout configuration — directly to `server.js`, while preserving the existing "Hello, World!" response behavior for all requests.

## 0.2 Root Cause Identification

Based on research, there are **five distinct root causes** in `server.js`, all located within the same 14-line file. Each root cause stems from the absence of a defensive programming pattern that Node.js's built-in `http` module expects the developer to supply.

### 0.2.1 Root Cause 1: No Server Error Event Handler

- **Located in:** `server.js`, line 6 (server creation) and line 12 (listen call)
- **Triggered by:** Port 3000 being already in use, or any other TCP binding failure
- **Evidence:** Running `node server.js` when port 3000 is occupied produces an unhandled `EADDRINUSE` error that crashes the process with a full stack trace:
  ```
  Error: listen EADDRINUSE: address already in use 127.0.0.1:3000
  ```
- **This conclusion is definitive because:** Node.js's `http.Server` inherits from `net.Server`, which emits an `'error'` event on binding failures. Without an explicit `server.on('error', ...)` listener, Node.js's `EventEmitter` throws the error as an uncaught exception, terminating the process.

### 0.2.2 Root Cause 2: No Graceful Shutdown Handlers

- **Located in:** `server.js` — absent entirely (no `process.on(...)` calls exist)
- **Triggered by:** Receiving `SIGTERM` (e.g., `kill <pid>`) or `SIGINT` (e.g., Ctrl+C)
- **Evidence:** Sending `kill -SIGTERM <pid>` to the running server causes immediate process termination with no log output, no connection draining, and no `server.close()` call. In-flight HTTP requests are abruptly severed.
- **This conclusion is definitive because:** Node.js's default signal behavior for `SIGTERM` is immediate process termination. Without explicit signal handlers calling `server.close()`, the HTTP server cannot finish serving active connections before exiting.

### 0.2.3 Root Cause 3: No Request/Response Error Handling

- **Located in:** `server.js`, lines 6–9 (request callback)
- **Triggered by:** Client-side connection resets, malformed HTTP requests, or write errors on the response stream
- **Evidence:** The callback `(req, res) => { ... }` never attaches `req.on('error', ...)` or `res.on('error', ...)` listeners. A `clientError` event on the server is also unhandled. If the client aborts mid-request or sends malformed headers, the default Node.js behavior may emit warnings or silently drop the error.
- **This conclusion is definitive because:** The `req` (IncomingMessage) and `res` (ServerResponse) objects are readable/writable streams that can emit `'error'` events. Without listeners, stream errors propagate to Node.js's default handler, which can crash the process for uncaught errors.

### 0.2.4 Root Cause 4: No Process-Level Safety Nets

- **Located in:** `server.js` — absent entirely
- **Triggered by:** Any unhandled exception or unhandled promise rejection during server operation
- **Evidence:** `grep` analysis confirms zero occurrences of `uncaughtException`, `unhandledRejection`, `try`, `catch`, or `throw` in `server.js`. If any unexpected runtime error occurs (e.g., from a future code modification), the process will crash without logging or recovery.
- **This conclusion is definitive because:** Node.js terminates the process by default on unhandled exceptions. Without `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)`, there is no last-resort error capture.

### 0.2.5 Root Cause 5: No Timeout or Connection Management

- **Located in:** `server.js`, lines 6 and 12 (server creation and listen)
- **Triggered by:** Slow clients, idle keep-alive connections, or Slowloris-style attacks
- **Evidence:** No calls to `server.timeout`, `server.keepAliveTimeout`, `server.headersTimeout`, or `server.requestTimeout` exist. The server relies entirely on Node.js's default timeout values (e.g., `server.timeout` defaults to 0, meaning no timeout). Connections can remain open indefinitely.
- **This conclusion is definitive because:** Without explicit timeout configuration, the server is vulnerable to resource exhaustion from clients that open connections but never complete requests or that hold connections open indefinitely.

## 0.3 Diagnostic Execution

### 0.3.1 Code Examination Results

- **File analyzed:** `server.js` (14 lines, the sole functional component in the repository)
- **Problematic code block:** Lines 1–14 (the entire file)
- **Specific failure points:**
  - Line 6: `http.createServer((req, res) => {` — callback never inspects `req`, never handles errors on `req` or `res`
  - Line 12: `server.listen(port, hostname, () => {` — no `server.on('error', ...)` registered before or after `.listen()`
  - Lines 1–14 (entirety): No `process.on(...)` calls for signals or uncaught errors

- **Execution flow leading to bug (EADDRINUSE scenario):**
  - Step 1: `node server.js` is executed; `http.createServer()` creates server object (line 6)
  - Step 2: `server.listen(3000, '127.0.0.1', callback)` attempts TCP bind (line 12)
  - Step 3: Port 3000 is already occupied → Node.js's `net.Server` emits `'error'` event with `EADDRINUSE`
  - Step 4: No `.on('error')` listener exists on the server → `EventEmitter` throws the error
  - Step 5: No `process.on('uncaughtException')` exists → process crashes with unhandled error stack trace

- **Execution flow leading to bug (Abrupt termination scenario):**
  - Step 1: Server is running and processing requests on `127.0.0.1:3000`
  - Step 2: `SIGTERM` signal received (e.g., from `kill <pid>` or container orchestrator)
  - Step 3: No `process.on('SIGTERM')` handler registered → Node.js default behavior invoked
  - Step 4: Process terminates immediately; in-flight requests are severed without response

### 0.3.2 Repository Analysis Findings

| Tool Used | Command Executed | Finding | File:Line |
|-----------|-----------------|---------|-----------|
| grep | `grep -n "error\|EADDRINUSE\|on(" server.js` | Zero matches — no error handling code exists | `server.js`: none |
| grep | `grep -n "SIGTERM\|SIGINT\|process.on\|graceful" server.js` | Zero matches — no signal handlers exist | `server.js`: none |
| grep | `grep -n "uncaughtException\|unhandledRejection" server.js` | Zero matches — no process-level error handlers | `server.js`: none |
| grep | `grep -n "req\.\|req\.url\|req\.method" server.js` | Zero matches — request object is never inspected | `server.js`: none |
| grep | `grep -n "server.on\|\.on('error'" server.js` | Zero matches — no server event listeners | `server.js`: none |
| grep | `grep -n "try\|catch\|throw" server.js` | Zero matches — no try-catch blocks | `server.js`: none |
| grep | `grep -n "timeout\|keepAlive\|headersTimeout" server.js` | Zero matches — no timeout configuration | `server.js`: none |
| node | `node server.js` (port occupied) | Unhandled EADDRINUSE crash with full stack trace | `server.js`:12 |
| kill | `kill -SIGTERM <pid>` | Immediate termination, no graceful shutdown log | `server.js`: N/A |
| curl | `curl -X POST http://127.0.0.1:3000/` | Returns 200 OK for all methods — no validation | `server.js`:6-9 |
| curl | `curl http://127.0.0.1:3000/nonexistent` | Returns 200 OK for all paths — no routing | `server.js`:6-9 |

### 0.3.3 Web Search Findings

- **Search queries executed:**
  - "Node.js http server error handling best practices"
  - "Node.js graceful shutdown http server SIGTERM"
  - "Node.js http createServer common vulnerabilities missing error handling"

- **Web sources referenced:**
  - Node.js Official Security Best Practices (nodejs.org) — documents DoS vulnerability when servers lack error handlers
  - Express.js Health Checks and Graceful Shutdown guide (expressjs.com) — `process.on('SIGTERM')` + `server.close()` pattern
  - RisingStack Engineering — graceful shutdown with `server.close()` + resource cleanup + `process.exit()`
  - DEV Community — SIGTERM/SIGINT handling with forced timeout fallback
  - Cobalt.io — Node.js server vulnerabilities including DoS from missing error handling and missing timeout configuration
  - Lagoon Documentation — Node.js default behavior kills active connections on SIGTERM without custom handlers

- **Key findings incorporated:**
  - Node.js `http.Server` requires explicit `server.on('error', ...)` to prevent crashes on port conflicts
  - Graceful shutdown requires both `SIGTERM` and `SIGINT` handlers that call `server.close()` with a forced-exit timeout
  - The `clientError` event should be handled to prevent crashes from malformed HTTP requests
  - `process.on('uncaughtException')` and `process.on('unhandledRejection')` are essential last-resort safety nets
  - Server timeout properties (`server.keepAliveTimeout`, `server.headersTimeout`) should be explicitly configured for robustness

### 0.3.4 Fix Verification Analysis

- **Steps followed to reproduce bug:**
  - Started `node server.js` successfully on port 3000
  - Attempted a second `node server.js` instance → confirmed unhandled EADDRINUSE crash
  - Sent `SIGTERM` to running server → confirmed immediate termination without graceful shutdown
  - Sent POST, arbitrary paths, and unusual methods via `curl` → confirmed no input differentiation (all return 200)
  - Searched all 14 lines for any error handling, signal handling, or timeout configuration → confirmed total absence

- **Confirmation tests to verify the fix:**
  - Start server → start second instance → verify graceful error message instead of crash
  - Start server → send `SIGTERM` → verify "shutting down" log message and connection draining
  - Start server → verify `server.on('error')`, `process.on('uncaughtException')`, `process.on('unhandledRejection')` are registered
  - Verify `server.keepAliveTimeout` and `server.headersTimeout` are set to non-zero values
  - Verify all existing test behavior is preserved (200 OK + "Hello, World!\n" for all requests)

- **Boundary conditions and edge cases covered:**
  - EADDRINUSE when port is occupied
  - SIGTERM vs. SIGINT signal handling
  - Malformed HTTP requests (clientError)
  - Connection timeout for idle/slow clients
  - Forced exit timeout when graceful shutdown exceeds threshold
  - Request and response stream errors

- **Verification confidence level:** 95%
  - High confidence because all root causes are definitively identified through direct code inspection and reproduced through bash commands. The fix patterns are well-established Node.js idioms documented in official sources.

## 0.4 Bug Fix Specification

### 0.4.1 The Definitive Fix

- **File to modify:** `server.js`
- **Current implementation (lines 1–14):**

```javascript
const http = require('http');
const hostname = '127.0.0.1';
const port = 3000;
const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});
```

- **This fixes the root causes by:**
  - Adding `server.on('error', ...)` to handle `EADDRINUSE` and other binding errors gracefully instead of crashing
  - Adding `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` for graceful shutdown with `server.close()` and a forced-exit timeout
  - Adding `server.on('clientError', ...)` to handle malformed HTTP requests without crashing
  - Adding `req.on('error', ...)` and `res.on('error', ...)` within the request callback for stream-level error handling
  - Adding `process.on('uncaughtException', ...)` and `process.on('unhandledRejection', ...)` as last-resort safety nets
  - Setting `server.keepAliveTimeout` and `server.headersTimeout` for connection management
  - Tracking open connections for proper cleanup during shutdown

### 0.4.2 Change Instructions

- **MODIFY** lines 1–14 of `server.js`: Replace the entire file content with the robust version described below. Always include detailed comments explaining the motive behind each change.

**Change 1 — Server error handler (addresses Root Cause 1):**
- INSERT after line 10 (after server creation, before `.listen()`): A `server.on('error', ...)` handler that catches `EADDRINUSE` and other server errors, logs them to `console.error`, and exits with code 1 instead of crashing with a stack trace.

```javascript
server.on('error', (err) => {
  // Handles EADDRINUSE and other server binding errors gracefully
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
```

**Change 2 — Client error handler (addresses Root Cause 3):**
- INSERT after the server error handler: A `server.on('clientError', ...)` handler that destroys the offending socket and sends a 400 Bad Request response for malformed HTTP requests.

```javascript
server.on('clientError', (err, socket) => {
  // Handles malformed HTTP requests to prevent crashes
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});
```

**Change 3 — Request/response error handling (addresses Root Cause 3):**
- MODIFY lines 6–9 (the request callback): Add `req.on('error', ...)` and `res.on('error', ...)` listeners inside the callback to handle stream-level errors.

```javascript
const server = http.createServer((req, res) => {
  // Handle request stream errors
  req.on('error', (err) => {
    console.error(`Request error: ${err.message}`);
  });
  // Handle response stream errors
  res.on('error', (err) => {
    console.error(`Response error: ${err.message}`);
  });
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});
```

**Change 4 — Timeout configuration (addresses Root Cause 5):**
- INSERT after the server creation: Set `server.keepAliveTimeout` and `server.headersTimeout` to explicit non-zero values.

```javascript
// Configure timeouts for connection management
server.keepAliveTimeout = 5000;
server.headersTimeout = 60000;
```

**Change 5 — Connection tracking for cleanup (addresses Root Cause 4):**
- INSERT after server creation: Track open connections in a `Set` for proper cleanup during shutdown.

```javascript
const connections = new Set();
server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});
```

**Change 6 — Graceful shutdown handlers (addresses Root Cause 2):**
- INSERT before `server.listen()`: Register `SIGTERM` and `SIGINT` signal handlers that call `server.close()`, destroy remaining connections, and include a forced-exit timeout.

```javascript
function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Destroy remaining connections
  for (const socket of connections) {
    socket.destroy();
  }
  // Force exit if shutdown takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

**Change 7 — Process-level safety nets (addresses Root Cause 4):**
- INSERT at the end of the file: Add `uncaughtException` and `unhandledRejection` handlers as last-resort error capture.

```javascript
process.on('uncaughtException', (err) => {
  console.error(`Uncaught exception: ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});
```

### 0.4.3 Fix Validation

- **Test command to verify fix (EADDRINUSE):**
  ```
  node server.js &
  node server.js 2>&1
  ```
  - **Expected output:** `Server error: listen EADDRINUSE: address already in use 127.0.0.1:3000` (clean log, no stack trace crash)

- **Test command to verify fix (graceful shutdown):**
  ```
  node server.js &
  kill -SIGTERM $!
  ```
  - **Expected output:** `SIGTERM received. Shutting down gracefully...` followed by `Server closed.`

- **Test command to verify fix (existing behavior preserved):**
  ```
  node server.js &
  curl http://127.0.0.1:3000/
  ```
  - **Expected output:** `Hello, World!` (unchanged)

- **Confirmation method:** Run all three verification sequences. Confirm no stack traces appear in stderr, graceful shutdown messages appear in stdout, and the "Hello, World!" response remains identical.

## 0.5 Scope Boundaries

### 0.5.1 Changes Required (Exhaustive List)

| Action | File | Lines | Specific Change |
|--------|------|-------|-----------------|
| MODIFIED | `server.js` | 1–14 (entire file) | Add server error handler, client error handler, request/response error handling, timeout configuration, connection tracking, graceful shutdown handlers, and process-level safety nets while preserving the existing "Hello, World!" response behavior |

- **`server.js`** — The request callback is enhanced with `req.on('error')` and `res.on('error')` listeners. A `server.on('error')` handler is added for EADDRINUSE and other binding errors. A `server.on('clientError')` handler is added for malformed requests. `server.keepAliveTimeout` and `server.headersTimeout` are configured. A connection-tracking `Set` with `server.on('connection')` is added. Signal handlers for `SIGTERM` and `SIGINT` are registered with `server.close()` and a forced-exit timeout. `process.on('uncaughtException')` and `process.on('unhandledRejection')` are added as last-resort safety nets.
- **No other files require modification.**

**Files summary:**

| File Path | Status |
|-----------|--------|
| `server.js` | MODIFIED |

### 0.5.2 Explicitly Excluded

- **Do not modify:** `server - Copy.js` — This is a byte-identical copy of `server.js` used for duplicate-file detection testing (F-004). Modifying it would break the duplicate detection test requirement.
- **Do not modify:** `package.json` — No new dependencies are being added. All changes use only Node.js's built-in `http` module and `process` global, which are already available.
- **Do not modify:** `package-lock.json` — No dependency changes.
- **Do not modify:** `README.md` — The governance directive ("Do not touch!") is preserved; `server.js` changes are explicitly within the scope of the user's request.
- **Do not modify:** `LoginTest.java`, `LoginTest - Copy.java`, `industry.csv`, `industry - Copy.csv`, `test.py.txt`, `test.py - Copy.txt`, `test.blitzyignore.txt`, `test1.blitzyignore.txt` — These are static test artifacts unrelated to the HTTP server.
- **Do not refactor:** The CommonJS module system (`require()`) or the hard-coded hostname/port constants — these are working as designed and are outside the bug fix scope.
- **Do not add:** Express.js, external error-handling libraries, logging frameworks, or any new npm dependencies — the zero-dependency constraint (C-001) must be preserved.
- **Do not add:** HTTP routing, request body parsing, or method-based branching — the static "Hello, World!" response to all requests is the intended functional behavior (F-001-RQ-002).
- **Do not add:** New files or directories — the flat 13-file structure is a repository constraint (C-003).
- **Do not create:** Test files — the `npm test` script is a deliberate failure stub (F-002-RQ-004), and adding test files would violate the file count constraint.

## 0.6 Verification Protocol

### 0.6.1 Bug Elimination Confirmation

- **Execute (EADDRINUSE):**
  ```
  node server.js &
  sleep 1
  node server.js 2>&1
  ```
  - **Verify output matches:** `Server error: listen EADDRINUSE: address already in use 127.0.0.1:3000` — a clean, human-readable error message with no unhandled error stack trace
  - **Confirm:** Process exits with code 1 (not a crash)

- **Execute (Graceful Shutdown — SIGTERM):**
  ```
  node server.js &
  SERVER_PID=$!
  sleep 1
  kill -SIGTERM $SERVER_PID
  ```
  - **Verify output contains:** `SIGTERM received. Shutting down gracefully...` followed by `Server closed.`
  - **Confirm:** Process exits with code 0 (clean shutdown)

- **Execute (Graceful Shutdown — SIGINT):**
  ```
  node server.js &
  SERVER_PID=$!
  sleep 1
  kill -SIGINT $SERVER_PID
  ```
  - **Verify output contains:** `SIGINT received. Shutting down gracefully...` followed by `Server closed.`
  - **Confirm:** Process exits with code 0 (clean shutdown)

- **Execute (Existing Behavior Preserved):**
  ```
  node server.js &
  sleep 1
  curl -s http://127.0.0.1:3000/
  curl -s -X POST http://127.0.0.1:3000/
  curl -sI http://127.0.0.1:3000/
  ```
  - **Verify:** All requests return HTTP 200 with `Content-Type: text/plain` and body `Hello, World!\n`
  - **Confirm:** Response body is exactly 14 bytes, matching F-001-RQ-004

- **Validate functionality with (Timeout Configuration):**
  ```
  node -e "const s = require('./server.js'); console.log(s.keepAliveTimeout, s.headersTimeout);"
  ```
  - **Verify:** `server.keepAliveTimeout` and `server.headersTimeout` are set to non-zero values

### 0.6.2 Regression Check

- **Run existing test suite:**
  ```
  npm test 2>&1
  ```
  - **Expected output:** `Error: no test specified` with exit code 1 — this is the deliberate failure stub and must remain unchanged (F-002-RQ-004)

- **Verify unchanged behavior in:**
  - HTTP response status code (200 for all requests)
  - HTTP response header (`Content-Type: text/plain`)
  - HTTP response body (`Hello, World!\n` — exactly 14 bytes)
  - Server startup log message (`Server running at http://127.0.0.1:3000/`)
  - Loopback-only binding (`127.0.0.1`, not `0.0.0.0`)
  - Port number (3000, hard-coded)
  - Zero external dependencies (no new entries in `package.json`)
  - File count (13 files in flat structure)

- **Confirm performance metrics:**
  ```
  time curl -s http://127.0.0.1:3000/
  ```
  - **Verify:** Response time remains sub-millisecond for the static response — the added error handlers have near-zero overhead for normal requests

- **Verify duplicate pair consistency:**
  - `server.js` and `server - Copy.js` will now intentionally differ (as `server - Copy.js` is excluded from modification). This is acceptable because the change is explicitly requested by the user. However, if maintaining byte-identity is required, `server - Copy.js` should also be flagged for separate review.

## 0.7 Rules

The following rules and development guidelines are acknowledged and will be strictly observed:

- **Make the exact specified change only** — Modifications are limited to adding error handling, graceful shutdown, input validation awareness, resource cleanup, and robust HTTP request processing to `server.js`. No unrelated refactoring, feature additions, or structural changes are made.

- **Zero modifications outside the bug fix** — Only `server.js` is modified. All other 12 files in the repository remain untouched. No new files or directories are created.

- **Zero external dependencies** — All fixes use only Node.js's built-in `http` module, `process` global, and `Set` data structure. No npm packages are added. The `package.json` and `package-lock.json` remain unchanged, preserving constraint C-001.

- **Preserve existing functional behavior** — The "Hello, World!\n" response (HTTP 200, `Content-Type: text/plain`, 14-byte body) is preserved for all requests regardless of method, path, or headers, per requirements F-001-RQ-002 through F-001-RQ-004.

- **Preserve loopback-only binding** — The server continues to bind exclusively to `127.0.0.1:3000`, per constraint C-004.

- **Preserve CommonJS module system** — The `require('http')` pattern is maintained. No conversion to ES modules.

- **Use Node.js v20.x compatible APIs** — All added code uses APIs available in Node.js v20.20.0 (the runtime installed in the environment). `server.keepAliveTimeout`, `server.headersTimeout`, `process.on('SIGTERM')`, `process.on('uncaughtException')`, and `server.on('clientError')` are all stable APIs in Node.js v20.x.

- **Follow existing code conventions** — The fix adheres to the existing code style: `const` declarations, arrow functions, template literals for `console.log`, and 2-space indentation.

- **Flat directory structure** — No subdirectories are created. The total file count remains at 13, per constraint C-003.

- **Extensive testing to prevent regressions** — All verification steps in the Verification Protocol (Section 0.6) must pass before the fix is considered complete. The existing `npm test` deliberate failure stub must remain unchanged.

## 0.8 References

### 0.8.1 Repository Files and Folders Analyzed

| File Path | Purpose | Relevance |
|-----------|---------|-----------|
| `server.js` | Sole functional HTTP server (14 lines) | **Primary target** — all five root causes located here |
| `server - Copy.js` | Byte-identical copy of `server.js` | Reviewed to confirm duplicate status; explicitly excluded from modification |
| `package.json` | NPM manifest (`hello_world` v1.0.0, MIT, zero deps) | Confirmed zero-dependency constraint (C-001) |
| `package-lock.json` | Lock file (lockfileVersion 3, root package only) | Confirmed no external dependencies |
| `README.md` | Project identity and governance directive | Confirmed "Do not touch!" governance; server.js changes are within user's explicit request |
| `LoginTest.java` | Java stub for `com.blitzyTest` package | Reviewed and excluded — not related to HTTP server |
| `LoginTest - Copy.java` | Duplicate of Java stub | Reviewed and excluded |
| `industry.csv` | 43-row industry taxonomy data | Reviewed and excluded |
| `industry - Copy.csv` | Duplicate of CSV | Reviewed and excluded |
| `test.py.txt` | Zero-byte Python placeholder | Reviewed and excluded |
| `test.py - Copy.txt` | Zero-byte duplicate placeholder | Reviewed and excluded |
| `test.blitzyignore.txt` | Zero-byte sentinel file | Reviewed — confirmed no ignore patterns |
| `test1.blitzyignore.txt` | Zero-byte sentinel file | Reviewed — confirmed no ignore patterns |

### 0.8.2 Technical Specification Sections Referenced

| Section | Content | Usage |
|---------|---------|-------|
| 1.1 Executive Summary | Project overview as Backprop test scaffold | Understood project purpose and immutability requirements |
| 2.2 Functional Requirements | F-001 through F-005 requirements | Confirmed HTTP response behavior must be preserved |
| 3.1 Technology Stack Overview | Node.js + built-in `http` module only | Confirmed zero-dependency constraint applies to fixes |
| 4.5 Error Handling Flowcharts | Documented all absent error handling patterns | Identified all missing mechanisms that this fix addresses |
| 5.2 Component Details | server.js as sole functional component | Used as primary reference for component analysis |
| 6.1 Core Services Architecture | Single-component runtime model | Confirmed no service architecture; fixes must stay within single-file scope |

### 0.8.3 Web Sources Referenced

| Source | URL | Key Finding |
|--------|-----|-------------|
| Node.js Official Security Best Practices | https://nodejs.org/en/learn/getting-started/security-best-practices | Server without error handler is vulnerable to DoS |
| Express.js Graceful Shutdown Guide | https://expressjs.com/en/advanced/healthcheck-graceful-shutdown.html | `process.on('SIGTERM')` + `server.close()` pattern |
| RisingStack Engineering | https://blog.risingstack.com/graceful-shutdown-node-js-kubernetes/ | Graceful shutdown with resource cleanup and forced-exit timeout |
| DEV Community — Graceful Shutdown Guide | https://dev.to/yusadolat/nodejs-graceful-shutdown-a-beginners-guide-40b6 | SIGINT + SIGTERM handlers with `server.close()` |
| Cobalt.io — Node.js Vulnerabilities | https://www.cobalt.io/blog/node-js-vulnerabilities | DoS from missing error handling and timeout configuration |
| Lagoon Documentation | https://docs.lagoon.sh/using-lagoon-advanced/nodejs/ | Node.js kills active connections on SIGTERM without custom handlers |
| W3Schools — Node.js Error Handling | https://www.w3schools.com/nodejs/nodejs_error_handling.asp | `uncaughtException` and `unhandledRejection` patterns |
| Toptal — Node.js Error Handling | https://www.toptal.com/developers/nodejs/node-js-error-handling | Centralized error handling with custom error classes |

### 0.8.4 Attachments

No attachments were provided for this project.

