# Chakravyuh - Raspberry Pi firewall system

This project is split into:

- `backend/` - Node.js HTTP/WebSocket server that runs Wi-Fi monitor and admin commands
- `frontend/` - React + Tailwind frontend with login, station controls, and site blocking

## 1. Install prerequisites on Raspberry Pi

```bash
sudo apt update
sudo apt install -y nodejs npm iw iptables iproute2 dnsmasq
```

The backend executes admin actions with `sudo`. For unattended use, allow the command set your panel needs in sudoers, for example `iptables`, `iw`, `tc`, `tee`, and `systemctl restart dnsmasq`.

## 2. Install app dependencies

```bash
cd backend
npm install

cd ../frontend
npm install
```

## 3. Run backend

```bash
cd backend
ADMIN_PASSWORD='your-password' npm start
```

Default backend address:

```text
ws://<raspberry-pi-ip>:3001
```

## 4. Run frontend

In another terminal:

```bash
cd frontend
npm run dev
```

Then open:

```text
http://<raspberry-pi-ip>:5173
```

## Configuration

Backend:

```bash
ADMIN_PASSWORD='your-password' WIFI_INTERFACE=wlan0 PORT=3001 POLL_INTERVAL_MS=1000 npm start
```

Admin features:

- Block a connected client by MAC using an `iptables` FORWARD drop rule and disconnect it with `iw`.
- Limit a connected client using `tc htb` and a `flower dst_mac` filter.
- Limit total Wi-Fi access by setting a maximum number of connected users; extra clients are automatically blocked.
- Block a domain by writing dnsmasq rules to `/etc/dnsmasq.d/pi-panel-blocklist.conf` and restarting dnsmasq.

Backend options:

```bash
ADMIN_PASSWORD=your-password
SUDO_PATH=sudo
DNSMASQ_BLOCKLIST=/etc/dnsmasq.d/pi-panel-blocklist.conf
```

Frontend:

```bash
VITE_WS_URL=ws://<raspberry-pi-ip>:3001 npm run dev
```

If `VITE_WS_URL` is not set, the frontend uses the current browser hostname with port `3001`.

## Useful checks

Check Wi-Fi interfaces:

```bash
iw dev
```

Check the command manually:

```bash
iw dev wlan0 station dump
```

Check backend health:

```text
http://<raspberry-pi-ip>:3001/health
```
