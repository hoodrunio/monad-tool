#!/bin/bash

# Monad Validator Analytics - Production Deployment Script
# Automates the complete production deployment process

set -euo pipefail

# Configuration
DEPLOY_USER="monad"
DEPLOY_GROUP="monad"
INSTALL_DIR="/opt/monad-analytics"
SERVICE_NAME="monad-analytics"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root or target user
check_user() {
    local current_user=$(whoami)
    
    if [[ "$current_user" == "$DEPLOY_USER" ]]; then
        log_info "Running as target user '$DEPLOY_USER' - skipping sudo operations"
        export RUNNING_AS_TARGET_USER=true
        export SKIP_USER_SETUP=true
    elif [[ $EUID -eq 0 ]]; then
        log_info "Running as root - will create/manage user '$DEPLOY_USER'"
        export RUNNING_AS_TARGET_USER=false
        export SKIP_USER_SETUP=false
    else
        log_error "This script must be run as root (use sudo) or as user '$DEPLOY_USER'"
        exit 1
    fi
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Find Node.js installation (even when running with sudo)
    local node_path=""
    local npm_path=""
    
    # Try to find node in common locations and preserve original user's PATH
    if [[ -n "${SUDO_USER:-}" ]]; then
        # Running with sudo, try to get original user's node path
        node_path=$(sudo -u "$SUDO_USER" which node 2>/dev/null || echo "")
        npm_path=$(sudo -u "$SUDO_USER" which npm 2>/dev/null || echo "")
    fi
    
    # Fallback to current PATH
    if [[ -z "$node_path" ]]; then
        node_path=$(which node 2>/dev/null || echo "")
    fi
    if [[ -z "$npm_path" ]]; then
        npm_path=$(which npm 2>/dev/null || echo "")
    fi
    
    # Additional fallback locations
    if [[ -z "$node_path" ]]; then
        for path in "/usr/bin/node" "/usr/local/bin/node" "/snap/bin/node" "$HOME/.nvm/versions/node/*/bin/node"; do
            if [[ -x "$path" ]]; then
                node_path="$path"
                break
            fi
        done
    fi
    
    if [[ -z "$npm_path" ]]; then
        for path in "/usr/bin/npm" "/usr/local/bin/npm" "/snap/bin/npm" "$HOME/.nvm/versions/node/*/bin/npm"; do
            if [[ -x "$path" ]]; then
                npm_path="$path"
                break
            fi
        done
    fi
    
    # Check if we found node and npm
    if [[ -z "$node_path" || ! -x "$node_path" ]]; then
        log_error "Node.js not found. Please install Node.js 18.0.0 or higher"
        exit 1
    fi
    
    if [[ -z "$npm_path" || ! -x "$npm_path" ]]; then
        log_error "npm not found. Please install npm"
        exit 1
    fi
    
    # Export paths for use in other functions
    export NODE_PATH="$node_path"
    export NPM_PATH="$npm_path"
    
    log_info "Found Node.js at: $node_path"
    log_info "Found npm at: $npm_path"
    
    # Check for other required commands
    local required_commands=("systemctl" "git" "curl")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            log_error "Required command '$cmd' not found"
            exit 1
        fi
    done
    
    # Check Node.js version
    local node_version=$("$node_path" --version | sed 's/v//')
    local required_version="18.0.0"
    if ! printf '%s\n' "$required_version" "$node_version" | sort -V -C; then
        log_error "Node.js version $required_version or higher required (found $node_version)"
        exit 1
    fi
    
    log_success "System requirements check passed (Node.js $node_version)"
}

# Install system dependencies
install_dependencies() {
    log_info "Installing system dependencies..."
    
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        # Update package list
        sudo apt-get update
        
        # Install required packages
        sudo apt-get install -y \
            curl \
            git \
            systemd \
            logrotate \
            htop \
            iotop \
            nethogs
    else
        # Update package list
        apt-get update
        
        # Install required packages
        apt-get install -y \
            curl \
            git \
            systemd \
            logrotate \
            htop \
            iotop \
            nethogs
    fi
    
    log_success "System dependencies installed"
}

# Create user and directories
setup_user() {
    if [[ "$SKIP_USER_SETUP" == "true" ]]; then
        log_info "Skipping user setup (already running as target user)"
        
        # Still need to create directories
        mkdir -p "$INSTALL_DIR"/{logs,data,backup}
        chmod 755 "$INSTALL_DIR"
        
        log_success "Directories configured"
        return
    fi
    
    log_info "Setting up deployment user and directories..."
    
    # Create user if it doesn't exist
    if ! id "$DEPLOY_USER" &>/dev/null; then
        useradd --system --shell /bin/bash --home-dir "$INSTALL_DIR" --create-home "$DEPLOY_USER"
        log_success "Created user: $DEPLOY_USER"
    else
        log_info "User $DEPLOY_USER already exists"
    fi
    
    # Create directories
    mkdir -p "$INSTALL_DIR"/{logs,data,backup}
    chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
    chmod 755 "$INSTALL_DIR"
    
    log_success "User and directories configured"
}

# Deploy application
deploy_application() {
    log_info "Deploying application..."
    
    # Get current script directory (where we're running from)
    local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
    log_info "Deploying from current directory: $script_dir"
    
    # Stop service if running
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
            sudo systemctl stop "$SERVICE_NAME"
        else
            systemctl stop "$SERVICE_NAME"
        fi
        log_info "Stopped existing service"
    fi
    
    # Backup existing installation
    if [[ -d "$INSTALL_DIR/src" && "$INSTALL_DIR" != "$script_dir" ]]; then
        backup_dir="$INSTALL_DIR/backup/$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$backup_dir"
        cp -r "$INSTALL_DIR"/{src,package*.json,dist} "$backup_dir/" 2>/dev/null || true
        log_info "Created backup: $backup_dir"
    fi
    
    # Copy files to install directory (only if different from current location)
    if [[ "$INSTALL_DIR" != "$script_dir" ]]; then
        log_info "Copying files from $script_dir to $INSTALL_DIR"
        
        # Create install directory if it doesn't exist
        mkdir -p "$INSTALL_DIR"
        
        # Copy all files except .git, node_modules, and dist
        rsync -av --exclude='.git' --exclude='node_modules' --exclude='dist' \
              "$script_dir/" "$INSTALL_DIR/"
        
        if [[ "$RUNNING_AS_TARGET_USER" == "false" ]]; then
            chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
        fi
        
        log_info "Files copied to install directory"
    else
        log_info "Already in install directory, skipping file copy"
    fi
    
    # Install dependencies and build
    cd "$INSTALL_DIR"
    
    # Clean previous build
    rm -rf dist node_modules
    
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        "$NPM_PATH" ci --production
        "$NPM_PATH" run build
    else
        sudo -u "$DEPLOY_USER" "$NPM_PATH" ci --production
        sudo -u "$DEPLOY_USER" "$NPM_PATH" run build
    fi
    
    log_success "Application deployed"
}

# Configure environment
configure_environment() {
    log_info "Configuring environment..."
    
    # Copy production environment file
    if [[ -f "$INSTALL_DIR/.env.production" ]]; then
        cp "$INSTALL_DIR/.env.production" "$INSTALL_DIR/.env"
        chown "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR/.env"
        chmod 640 "$INSTALL_DIR/.env"
        log_success "Production environment configured"
    else
        log_warning "No .env.production file found, using defaults"
        cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
        chown "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR/.env"
        chmod 640 "$INSTALL_DIR/.env"
    fi
}

# Install systemd service
install_service() {
    log_info "Installing systemd service..."
    
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        # Copy service file
        sudo cp "$INSTALL_DIR/deployment/systemd/monad-analytics.service" "/etc/systemd/system/"
        
        # Reload systemd
        sudo systemctl daemon-reload
        
        # Enable service
        sudo systemctl enable "$SERVICE_NAME"
    else
        # Copy service file
        cp "$INSTALL_DIR/deployment/systemd/monad-analytics.service" "/etc/systemd/system/"
        
        # Reload systemd
        systemctl daemon-reload
        
        # Enable service
        systemctl enable "$SERVICE_NAME"
    fi
    
    log_success "Systemd service installed and enabled"
}

# Setup log rotation
setup_log_rotation() {
    log_info "Setting up log rotation..."
    
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        sudo tee /etc/logrotate.d/monad-analytics > /dev/null << 'EOF'
    else
        cat > /etc/logrotate.d/monad-analytics << 'EOF'
    fi
/opt/monad-analytics/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 monad monad
    postrotate
        /bin/systemctl reload monad-analytics > /dev/null 2>&1 || true
    endscript
}
EOF
    
    log_success "Log rotation configured"
}

# Setup monitoring
setup_monitoring() {
    log_info "Setting up monitoring..."
    
    # Create monitoring script
    cat > "$INSTALL_DIR/scripts/health-monitor.sh" << 'EOF'
#!/bin/bash
# Health monitoring script for Monad Analytics

INSTALL_DIR="/opt/monad-analytics"
LOG_FILE="$INSTALL_DIR/logs/health-monitor.log"

# Check service status
check_service() {
    if ! systemctl is-active --quiet monad-analytics; then
        echo "$(date): Service is not running, attempting restart" >> "$LOG_FILE"
        systemctl restart monad-analytics
    fi
}

# Check API health
check_api() {
    if ! curl -s -f http://localhost:3000/health > /dev/null; then
        echo "$(date): API health check failed" >> "$LOG_FILE"
    fi
}

check_service
check_api
EOF
    
    chmod +x "$INSTALL_DIR/scripts/health-monitor.sh"
    chown "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR/scripts/health-monitor.sh"
    
    # Add cron job for monitoring
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        echo "*/5 * * * * /opt/monad-analytics/scripts/health-monitor.sh" | crontab -
    else
        echo "*/5 * * * * /opt/monad-analytics/scripts/health-monitor.sh" | crontab -u "$DEPLOY_USER" -
    fi
    
    log_success "Monitoring setup completed"
}

# Start services
start_services() {
    log_info "Starting services..."
    
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        sudo systemctl start "$SERVICE_NAME"
    else
        systemctl start "$SERVICE_NAME"
    fi
    
    # Wait for service to start
    sleep 5
    
    # Check service status (works for both sudo and root)
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        log_success "Service started successfully"
    else
        log_error "Service failed to start"
        if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
            sudo systemctl status "$SERVICE_NAME"
        else
            systemctl status "$SERVICE_NAME"
        fi
        exit 1
    fi
}

# Verify deployment
verify_deployment() {
    log_info "Verifying deployment..."
    
    # Check service status
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        log_success "✓ Service is running"
    else
        log_error "✗ Service is not running"
        return 1
    fi
    
    # Check API health
    sleep 10  # Give API time to start
    if curl -s -f http://localhost:3000/health > /dev/null; then
        log_success "✓ API health check passed"
    else
        log_error "✗ API health check failed"
        return 1
    fi
    
    # Check logs for errors
    local service_status=""
    if [[ "$RUNNING_AS_TARGET_USER" == "true" ]]; then
        service_status=$(sudo systemctl status "$SERVICE_NAME" 2>/dev/null || echo "")
    else
        service_status=$(systemctl status "$SERVICE_NAME" 2>/dev/null || echo "")
    fi
    
    if echo "$service_status" | grep -q "active (running)"; then
        log_success "✓ Service status is healthy"
    else
        log_warning "⚠ Service status needs attention"
    fi
    
    log_success "Deployment verification completed"
}

# Display deployment information
show_deployment_info() {
    log_info "Deployment Information:"
    echo "=========================="
    echo "Service Name: $SERVICE_NAME"
    echo "Install Directory: $INSTALL_DIR"
    echo "User: $DEPLOY_USER"
    echo "API URL: http://localhost:3000"
    echo "Health Check: http://localhost:3000/health"
    echo ""
    echo "Monad Services Configuration:"
    echo "  BFT Service: monad-bft.service"
    echo "  Ledger Service: monad-ledger-tail.service"
    echo ""
    echo "Useful Commands:"
    echo "  sudo systemctl status $SERVICE_NAME"
    echo "  sudo systemctl restart $SERVICE_NAME"
    echo "  sudo journalctl -u $SERVICE_NAME -f"
    echo "  sudo journalctl -u monad-bft -f"
    echo "  sudo journalctl -u monad-ledger-tail -f"
    echo "  tail -f $INSTALL_DIR/logs/*.log"
}

# Main deployment function
main() {
    log_info "Starting Monad Validator Analytics Production Deployment"
    echo "========================================================="
    
    check_user
    check_requirements
    install_dependencies
    setup_user
    deploy_application
    configure_environment
    install_service
    setup_log_rotation
    setup_monitoring
    start_services
    verify_deployment
    
    echo ""
    log_success "🎉 Deployment completed successfully!"
    echo ""
    show_deployment_info
}

# Run main function
main "$@" 