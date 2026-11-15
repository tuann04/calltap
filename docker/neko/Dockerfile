FROM ghcr.io/m1k1o/neko/google-chrome:latest

USER root

RUN mkdir -p /var/run/pulse /home/neko/.config/calltap-chrome \
    && chown -R neko:neko /var/run/pulse /home/neko/.config/calltap-chrome

COPY default.pa /etc/pulse/default.pa
COPY supervisord.conf /etc/neko/supervisord/google-chrome.conf
COPY policies.json /etc/opt/chrome/policies/managed/policies.json
COPY preferences.json /etc/neko/chrome-preferences.seed.json
COPY start-chrome.sh /etc/neko/start-chrome.sh
COPY cdp-proxy.py /etc/neko/cdp-proxy.py
COPY mobile-fix.css /var/www/mobile-fix.css
RUN chmod +x /etc/neko/start-chrome.sh /etc/neko/cdp-proxy.py \
    && python3 -c "from pathlib import Path; p = Path('/var/www/index.html'); h = p.read_text('utf-8').replace('content=\"width=device-width,initial-scale=1.0\"', 'content=\"width=device-width,initial-scale=1.0,maximum-scale=1.0,viewport-fit=cover\"'); h = h if 'mobile-fix.css' in h else h.replace('</head>', '    <link rel=\"stylesheet\" href=\"./mobile-fix.css\">\n  </head>'); p.write_text(h, 'utf-8')"

ENV PULSE_SERVER=unix:/var/run/pulse/pulseaudio.socket
