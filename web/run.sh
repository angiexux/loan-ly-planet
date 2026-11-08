#!/bin/bash
# Loan-ly Planet: build the analysis if missing, start the API (port 8770) in the background, then the site on http://127.0.0.1:5173
cd "$(dirname "$0")"
export PATH="$PWD/.tools/node-v22.23.4-darwin-arm64/bin:$PATH"
[ -f public/data/portfolio.json ] || python3 ../pipeline/generate_portfolio.py
[ -f public/data/analysis.json ] || python3 ../backend/pipeline.py
[ -d node_modules ] || node .tools/node-v22.23.4-darwin-arm64/lib/node_modules/npm/bin/npm-cli.js install --no-audit --no-fund
python3 ../backend/server.py &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
# (no exec: the shell must stay alive so the trap can stop the API when vite exits)
PORT="${PORT:-5173}" node node_modules/vite/bin/vite.js --host 127.0.0.1
