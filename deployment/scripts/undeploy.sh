#!/bin/bash

# Monad Validator Analytics - Undeployment Script
# Completely removes the deployment and cleans up all resources

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

# Stop and disable service
stop_service() {
    log_info "Stopping and disabling service..."

    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null || sudo systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        if [[ $EUID -eq 0 ]]; then
            systemctl stop "$SERVICE_NAME"
            systemctl disable "$SERVICE_NAME"
        else
            sudo systemctl stop "$SERVICE_NAME"
            sudo systemctl disable "$SERVICE_NAME"
        fi
        log_success "Service stopped and disabled"
    else
        log_warning "Service is not running"
    fi
}

# Remove systemd service file
remove_service_file() {
    log_info "Removing systemd service file..."

    if [[ -f "/etc/systemd/system/$SERVICE_NAME.service" ]]; then
        if [[ $EUID -eq 0 ]]; then
            rm -f "/etc/systemd/system/$SERVICE_NAME.service"
            systemctl daemon-reload
        else
            sudo rm -f "/etc/systemd/system/$SERVICE_NAME.service"
            sudo systemctl daemon-reload
        fi
        log_success "Systemd service file removed"
    else
        log_warning "Systemd service file not found"
    fi
}

# Remove nginx configuration
remove_nginx() {
    log_info "Removing nginx configuration..."

    if [[ -f "/etc/nginx/sites-enabled/monad-analytics.conf" ]]; then
        if [[ $EUID -eq 0 ]]; then
            rm -f "/etc/nginx/sites-enabled/monad-analytics.conf"
            rm -f "/etc/nginx/sites-available/monad-analytics.conf"
            systemctl reload nginx 2>/dev/null || true
        else
            sudo rm -f "/etc/nginx/sites-enabled/monad-analytics.conf"
            sudo rm -f "/etc/nginx/sites-available/monad-analytics.conf"
            sudo systemctl reload nginx 2>/dev/null || true
        fi
        log_success "Nginx configuration removed"
    else
        log_warning "Nginx configuration not found"
    fi
}

# Remove log rotation
remove_logrotate() {
    log_info "Removing log rotation configuration..."

    if [[ -f "/etc/logrotate.d/monad-analytics" ]]; then
        if [[ $EUID -eq 0 ]]; then
            rm -f "/etc/logrotate.d/monad-analytics"
        else
            sudo rm -f "/etc/logrotate.d/monad-analytics"
        fi
        log_success "Log rotation configuration removed"
    else
        log_warning "Log rotation configuration not found"
    fi
}

# Remove cron job
remove_cron() {
    log_info "Removing cron jobs..."

    # Remove cron jobs containing monad-analytics or health-monitor
    crontab -l 2>/dev/null | grep -v "monad-analytics\|health-monitor" | crontab - 2>/dev/null || true

    log_success "Cron jobs removed"
}

# Stop Docker containers
stop_docker() {
    log_info "Stopping Docker containers..."

    if command -v docker &> /dev/null; then
        if docker compose version &> /dev/null 2>&1; then
            if [[ $EUID -eq 0 ]]; then
                docker compose down 2>/dev/null || true
            else
                sudo docker compose down 2>/dev/null || true
            fi
            log_success "Docker containers stopped"
        else
            log_warning "Docker Compose not available"
        fi
    else
        log_warning "Docker not found"
    fi
}

# Clean up build artifacts (optional)
clean_build() {
    log_info "Cleaning build artifacts..."

    local current_dir=$(pwd)

    if [[ -d "$current_dir/dist" ]]; then
        rm -rf "$current_dir/dist"
        log_success "Removed dist directory"
    fi

    if [[ -d "$current_dir/node_modules" ]]; then
        log_warning "node_modules directory found. Remove it? (y/n)"
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            rm -rf "$current_dir/node_modules"
            log_success "Removed node_modules directory"
        fi
    fi
}

# Main undeployment function
main() {
    log_info "Starting Monad Validator Analytics Undeployment"
    echo "================================================"
    echo ""
    log_warning "This will completely remove the deployment"
    log_warning "Press Ctrl+C to cancel, or Enter to continue..."
    read -r
    echo ""

    stop_service
    remove_service_file
    remove_nginx
    remove_logrotate
    remove_cron
    stop_docker
    clean_build

    echo ""
    log_success "🎉 Undeployment completed successfully!"
    echo ""
    log_info "Note: The following were NOT removed (manual cleanup if needed):"
    echo "  - Application source code"
    echo "  - Log files in logs/"
    echo "  - Data files in data/"
    echo "  - ClickHouse and Redis data volumes"
    echo "  - .env files"
    echo ""
    log_info "To remove Docker volumes, run:"
    echo "  sudo docker volume ls"
    echo "  sudo docker volume rm <volume_name>"
    echo ""
    log_info "To remove the entire project directory:"
    echo "  cd .. && rm -rf monad-tool"
}

# Run main function
main "$@"
