// Run packages/core's pytest suite under Pyodide (Python 3.14, the Cloudflare Python Worker's runtime).
//
//   cd scripts && npm install && npm run test:pyodide
//
// Async tests need JSPI (node --experimental-wasm-jspi, set in package.json): pytest's anyio runner
// blocks on the event loop, which Pyodide only allows through JavaScript Promise Integration.
// The core suite has no httpx tests (HttpxTransport is exercised by the MCPB's tests), so it runs as is.
import { loadPyodide } from "pyodide";
import { fileURLToPath } from "node:url";
import path from "node:path";

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/core");

const py = await loadPyodide();
await py.loadPackage("micropip");
await py.pyimport("micropip").install(["pytest", "anyio"]);

py.FS.mkdirTree("/core");
py.FS.mount(py.FS.filesystems.NODEFS, { root: core }, "/core");

const code = await py.runPythonAsync(`
import sys
sys.path.insert(0, "/core/src")
import pytest
int(pytest.main(["-q", "-p", "no:cacheprovider", "/core/tests"]))
`);
process.exit(code);
