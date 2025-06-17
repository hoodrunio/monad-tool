#!/bin/bash

# Monad Analytics Service Startup Script
# This script ensures NVM environment is loaded before starting the Node.js application

# Set working directory to script location
cd "$(dirname "$0")/.."

# Source NVM if it exists
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
fi

# Alternative: Add NVM bin directory to PATH
if [[ -d "$HOME/.nvm/versions/node" ]]; then
    # Find the current/default Node.js version
    NODE_VERSION=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)
    if [[ -n "$NODE_VERSION" && -d "$HOME/.nvm/versions/node/$NODE_VERSION/bin" ]]; then
        export PATH="$HOME/.nvm/versions/node/$NODE_VERSION/bin:$PATH"
    fi
fi

# Verify node is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js not found in PATH"
    exit 1
fi

# Log the node version and path for debugging
echo "Starting Monad Analytics with Node.js $(node --version) from $(which node)"

# Start the application
exec node dist/index.js 