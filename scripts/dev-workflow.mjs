import { execSync, spawn } from "node:child_process";
import process from "node:process";

function killPort4000IfBusy() {
    try {
        if (process.platform === "win32") {
            // Kill only userland processes bound to dev ports to prevent stale servers.
            execSync(
                "powershell -NoProfile -Command \"$ports = @(4000,5173); $procIds = foreach ($port in $ports) { Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique }; $procIds = $procIds | Where-Object { $_ -gt 4 } | Select-Object -Unique; foreach ($procId in $procIds) { try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {} }\"",
                { stdio: "inherit" },
            );
            return;
        }

        execSync("lsof -ti :4000,:5173 | xargs kill -9", { stdio: "ignore" });
    } catch {
        // No process on port 4000 or kill command unavailable.
    }
}

function spawnCommand(command, args, name) {
    const child = spawn(command, args, {
        stdio: "inherit",
        shell: process.platform === "win32",
        env: process.env,
    });

    child.on("exit", (code) => {
        if (code !== 0) {
            console.error(`${name} exited with code ${code ?? "unknown"}`);
            process.exit(code ?? 1);
        }
    });

    return child;
}

killPort4000IfBusy();

const backend = spawnCommand("node", ["--watch", "backend/server.js"], "backend");
const frontend = spawnCommand("node", ["node_modules/vite/bin/vite.js"], "frontend");

function shutdown() {
    backend.kill();
    frontend.kill();
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
