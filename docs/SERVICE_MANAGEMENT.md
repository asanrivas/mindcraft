# Mindcraft Andy Service Management

The Mindcraft Andy bot is now running as a systemd service that automatically starts on boot.

## Service Commands

### Check Status
```bash
sudo systemctl status mindcraft-andy
```

### Start Service
```bash
sudo systemctl start mindcraft-andy
```

### Stop Service
```bash
sudo systemctl stop mindcraft-andy
```

### Restart Service
```bash
sudo systemctl restart mindcraft-andy
```

### Enable Auto-Start on Boot (already enabled)
```bash
sudo systemctl enable mindcraft-andy
```

### Disable Auto-Start on Boot
```bash
sudo systemctl disable mindcraft-andy
```

## View Logs

### Real-time Log Monitoring
```bash
tail -f /home/azureuser/mindcraft/logs/andy-service.log
```

### View Systemd Journal Logs
```bash
sudo journalctl -u mindcraft-andy -f
```

### View Last 100 Lines
```bash
tail -n 100 /home/azureuser/mindcraft/logs/andy-service.log
```

## Service Configuration

**Service File Location**: `/etc/systemd/system/mindcraft-andy.service`

**Working Directory**: `/home/azureuser/mindcraft`

**Log File**: `/home/azureuser/mindcraft/logs/andy-service.log`

**Auto-Restart**: Enabled (restarts automatically if it crashes, with 10 second delay)

## Editing the Service

If you need to modify the service configuration:

1. Edit the service file:
```bash
sudo nano /etc/systemd/system/mindcraft-andy.service
```

2. Reload systemd:
```bash
sudo systemctl daemon-reload
```

3. Restart the service:
```bash
sudo systemctl restart mindcraft-andy
```

## Environment Variables

The service is configured with:
- `NODE_ENV=production`
- `MINDSERVER_PORT=8080`
- Full PATH including Node.js and Bun

## Troubleshooting

### Service won't start
```bash
sudo systemctl status mindcraft-andy
sudo journalctl -u mindcraft-andy -n 50
```

### Check if ports are available
```bash
sudo netstat -tlnp | grep -E ':(8080|3000|25565)'
```

### Manual test (stop service first)
```bash
sudo systemctl stop mindcraft-andy
cd /home/azureuser/mindcraft
bun main.js
```

## Benefits of Service vs nohup

- ✅ Auto-starts on server reboot
- ✅ Automatic restart on crash
- ✅ Better log management
- ✅ Standard systemctl commands
- ✅ Proper process management
- ✅ Integrated with system monitoring
