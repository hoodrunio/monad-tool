#!/bin/bash

# Monad Validator Analytics - Production Deployment Script
# Automates the complete production deployment process

set -euo pipefail

# Configuration
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



# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Find Node.js installation
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
    
    # Configure npm to allow root user and disable security warnings
    export npm_config_unsafe_perm=true
    export npm_config_user=root
    export npm_config_cache=/tmp/.npm
    
    log_info "Found Node.js at: $node_path"
    log_info "Found npm at: $npm_path"
    log_info "Configured npm to allow root user execution"
    
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
    
    # Update package list (use sudo if not root)
    if [[ $EUID -eq 0 ]]; then
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
    else
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
    fi
    
    log_success "System dependencies installed"
}

# Create directories
setup_directories() {
    log_info "Setting up directories..."
    
    # Create log and data directories in current project
    mkdir -p logs data
    chmod 755 logs data
    
    log_success "Directories configured"
}

# Deploy application
deploy_application() {
    log_info "Installing dependencies and building application..."
    
    # Stop service if running
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        if [[ $EUID -eq 0 ]]; then
            systemctl stop "$SERVICE_NAME"
        else
            sudo systemctl stop "$SERVICE_NAME"
        fi
        log_info "Stopped existing service"
    fi
    
    # Clean previous build
    rm -rf dist node_modules
    
    # Install dependencies and build
    "$NPM_PATH" install
    "$NPM_PATH" run build
    
    log_success "Application deployed"
}

# Configure environment
configure_environment() {
    log_info "Configuring environment..."
    
    # Copy production environment file
    if [[ -f ".env.production" ]]; then
        cp ".env.production" ".env"
        chmod 640 ".env"
        log_success "Production environment configured"
    else
        log_warning "No .env.production file found, using defaults"
        cp ".env.example" ".env"
        chmod 640 ".env"
    fi
}

# Install systemd service
install_service() {
    log_info "Installing systemd service..."
    
    if [[ $EUID -eq 0 ]]; then
        # Copy service file
        cp "deployment/systemd/monad-analytics.service" "/etc/systemd/system/"
        
        # Reload systemd
        systemctl daemon-reload
        
        # Enable service
        systemctl enable "$SERVICE_NAME"
    else
        # Copy service file
        sudo cp "deployment/systemd/monad-analytics.service" "/etc/systemd/system/"
        
        # Reload systemd
        sudo systemctl daemon-reload
        
        # Enable service
        sudo systemctl enable "$SERVICE_NAME"
    fi
    
    log_success "Systemd service installed and enabled"
}

# Setup log rotation
setup_log_rotation() {
    log_info "Setting up log rotation..."
    
    local current_dir=$(pwd)
    
    if [[ $EUID -eq 0 ]]; then
        cat > /etc/logrotate.d/monad-analytics << EOF
$current_dir/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 root root
    postrotate
        /bin/systemctl reload monad-analytics > /dev/null 2>&1 || true
    endscript
}
EOF
    else
        sudo tee /etc/logrotate.d/monad-analytics > /dev/null << EOF
$current_dir/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 0644 root root
    postrotate
        /bin/systemctl reload monad-analytics > /dev/null 2>&1 || true
    endscript
}
EOF
    fi
    
    log_success "Log rotation configured"
}

# Setup monitoring
setup_monitoring() {
    log_info "Setting up monitoring..."
    
    local current_dir=$(pwd)
    
    # Create monitoring script
    cat > "scripts/health-monitor.sh" << EOF
#!/bin/bash
# Health monitoring script for Monad Analytics

INSTALL_DIR="$current_dir"
LOG_FILE="\$INSTALL_DIR/logs/health-monitor.log"

# Check service status
check_service() {
    if ! systemctl is-active --quiet monad-analytics; then
        echo "\$(date): Service is not running, attempting restart" >> "\$LOG_FILE"
        systemctl restart monad-analytics
    fi
}

# Check API health
check_api() {
    if ! curl -s -f http://localhost:3000/health > /dev/null; then
        echo "\$(date): API health check failed" >> "\$LOG_FILE"
    fi
}

check_service
check_api
EOF
    
    chmod +x "scripts/health-monitor.sh"
    
    # Add cron job for monitoring
    echo "*/5 * * * * $current_dir/scripts/health-monitor.sh" | crontab -
    
    log_success "Monitoring setup completed"
}

# Start services
start_services() {
    log_info "Starting services..."
    
    if [[ $EUID -eq 0 ]]; then
        systemctl start "$SERVICE_NAME"
    else
        sudo systemctl start "$SERVICE_NAME"
    fi
    
    # Wait for service to start
    sleep 5
    
    # Check service status (works for both sudo and root)
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        log_success "Service started successfully"
    else
        log_error "Service failed to start"
        if [[ $EUID -eq 0 ]]; then
            systemctl status "$SERVICE_NAME"
        else
            sudo systemctl status "$SERVICE_NAME"
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
    if [[ $EUID -eq 0 ]]; then
        service_status=$(systemctl status "$SERVICE_NAME" 2>/dev/null || echo "")
    else
        service_status=$(sudo systemctl status "$SERVICE_NAME" 2>/dev/null || echo "")
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
    local current_dir=$(pwd)
    
    log_info "Deployment Information:"
    echo "=========================="
    echo "Service Name: $SERVICE_NAME"
    echo "Install Directory: $current_dir"
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
    echo "  tail -f $current_dir/logs/*.log"
}

# Main deployment function
main() {
    log_info "Starting Monad Validator Analytics Production Deployment"
    echo "========================================================="
    
    check_requirements
    install_dependencies
    setup_directories
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