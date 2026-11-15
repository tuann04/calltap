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
COPY patch-neko-ui.py /tmp/patch-neko-ui.py
RUN chmod +x /etc/neko/start-chrome.sh /etc/neko/cdp-proxy.py \
    && python3 /tmp/patch-neko-ui.py \
    && rm -f /tmp/patch-neko-ui.py

ENV PULSE_SERVER=unix:/var/run/pulse/pulseaudio.socket
