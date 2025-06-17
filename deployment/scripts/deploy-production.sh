#!/bin/bash

# Monad Validator Analytics - Production Deployment Script
# Automates the complete production deployment process

set -euo pipefail

# Configuration
DEPLOY_USER="monad"
DEPLOY_GROUP="monad"
INSTALL_DIR="/opt/monad-analytics"
SERVICE_NAME="monad-analytics"
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/hoodrunio/monad-tool.git}"
BRANCH="${BRANCH:-main}"

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

# Check if running as root
check_root() {
    if [[ $EUID -ne 0 ]]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Check for required commands
    local required_commands=("systemctl" "git" "node" "npm" "curl")
    for cmd in "${required_commands[@]}"; do
        if ! command -v "$cmd" &> /dev/null; then
            log_error "Required command '$cmd' not found"
            exit 1
        fi
    done
    
    # Check Node.js version
    local node_version=$(node --version | sed 's/v//')
    local required_version="18.0.0"
    if ! printf '%s\n' "$required_version" "$node_version" | sort -V -C; then
        log_error "Node.js version $required_version or higher required (found $node_version)"
        exit 1
    fi
    
    log_success "System requirements check passed"
}

# Install system dependencies
install_dependencies() {
    log_info "Installing system dependencies..."
    
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
    
    log_success "System dependencies installed"
}

# Create user and directories
setup_user() {
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
    
    # Stop service if running
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        systemctl stop "$SERVICE_NAME"
        log_info "Stopped existing service"
    fi
    
    # Backup existing installation
    if [[ -d "$INSTALL_DIR/src" ]]; then
        backup_dir="$INSTALL_DIR/backup/$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$backup_dir"
        cp -r "$INSTALL_DIR"/{src,package*.json,dist} "$backup_dir/" 2>/dev/null || true
        log_info "Created backup: $backup_dir"
    fi
    
    # Clone or update repository
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        cd "$INSTALL_DIR"
        sudo -u "$DEPLOY_USER" git fetch origin
        sudo -u "$DEPLOY_USER" git reset --hard "origin/$BRANCH"
        log_info "Updated existing repository"
    else
        cd /tmp
        git clone -b "$BRANCH" "$REPOSITORY_URL" monad-analytics-deploy
        cp -r monad-analytics-deploy/* "$INSTALL_DIR/"
        chown -R "$DEPLOY_USER:$DEPLOY_GROUP" "$INSTALL_DIR"
        rm -rf monad-analytics-deploy
        log_info "Cloned repository"
    fi
    
    # Install dependencies and build
    cd "$INSTALL_DIR"
    sudo -u "$DEPLOY_USER" npm ci --production
    sudo -u "$DEPLOY_USER" npm run build
    
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
    
    # Copy service file
    cp "$INSTALL_DIR/deployment/systemd/monad-analytics.service" "/etc/systemd/system/"
    
    # Reload systemd
    systemctl daemon-reload
    
    # Enable service
    systemctl enable "$SERVICE_NAME"
    
    log_success "Systemd service installed and enabled"
}

# Setup log rotation
setup_log_rotation() {
    log_info "Setting up log rotation..."
    
    cat > /etc/logrotate.d/monad-analytics << 'EOF'
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
    echo "*/5 * * * * /opt/monad-analytics/scripts/health-monitor.sh" | crontab -u "$DEPLOY_USER" -
    
    log_success "Monitoring setup completed"
}

# Start services
start_services() {
    log_info "Starting services..."
    
    systemctl start "$SERVICE_NAME"
    
    # Wait for service to start
    sleep 5
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        log_success "Service started successfully"
    else
        log_error "Service failed to start"
        systemctl status "$SERVICE_NAME"
        exit 1
    fi
}

# Verify deployment
verify_deployment() {
    log_info "Verifying deployment..."
    
    # Check service status
    if systemctl is-active --quiet "$SERVICE_NAME"; then
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
    if systemctl status "$SERVICE_NAME" | grep -q "active (running)"; then
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
    
    check_root
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