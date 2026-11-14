FROM ghcr.io/m1k1o/neko/google-chrome:latest

USER root

RUN mkdir -p /var/run/pulse && chown -R neko:neko /var/run/pulse

COPY default.pa /etc/pulse/default.pa
COPY supervisord.conf /etc/neko/supervisord/google-chrome.conf
COPY policies.json /etc/opt/chrome/policies/managed/policies.json
COPY preferences.json /etc/neko/chrome-preferences.seed.json
COPY start-chrome.sh /etc/neko/start-chrome.sh
RUN chmod +x /etc/neko/start-chrome.sh

ENV PULSE_SERVER=unix:/var/run/pulse/pulseaudio.socket
