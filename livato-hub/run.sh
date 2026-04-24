#!/usr/bin/with-contenv bashio

export LIVATO_SERVER=$(bashio::config 'livato_server')
export LIVATO_TOKEN=$(bashio::config 'livato_token')
export SCAN_INTERVAL=$(bashio::config 'scan_interval')
export NETWORK_SUBNET=$(bashio::config 'network_subnet')

bashio::log.info "Starting Livato Hub..."
bashio::log.info "Server: ${LIVATO_SERVER}"
bashio::log.info "Subnet: ${NETWORK_SUBNET}.x"
bashio::log.info "Scan interval: ${SCAN_INTERVAL}s"

node /app/hub.js
