FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

ARG TARGETARCH
ARG MICROMAMBA_VERSION=2.3.3-0
ARG MICROMAMBA_SHA256_ARM64=0289350c2c89f7410554041e25b444cce30df326b227e70ead3e4a1e0b316286
ARG MICROMAMBA_SHA256_AMD64=9496f94a8b78c536573c93d946ec9bba74bd9ff79ee55aaa4b546e30db8f511b

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bzip2 ca-certificates curl fd-find file git jq less nano procps python3 python3-pip \
      python3-venv ripgrep unzip wget xz-utils zip \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
      matplotlib==3.9.3 openpyxl==3.1.5 pandas==2.2.3 pypdf==5.1.0 python-docx==1.1.2 \
      python-pptx==1.0.2 reportlab==4.2.5

RUN case "$TARGETARCH" in \
      arm64) asset=linux-aarch64; sum="$MICROMAMBA_SHA256_ARM64" ;; \
      amd64) asset=linux-64; sum="$MICROMAMBA_SHA256_AMD64" ;; \
      *) echo "unsupported $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/micromamba \
      "https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}/micromamba-${asset}" \
 && echo "$sum  /usr/local/bin/micromamba" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/micromamba

RUN mkdir -p /opt/himawari-browser \
 && cd /opt/himawari-browser \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund --save-exact playwright-core@1.62.1 \
 && chrome="$(find /ms-playwright -path '*chromium-*' -type f -name chrome -perm -u+x | head -n 1)" \
 && test -n "$chrome" \
 && ln -s "$chrome" /usr/local/bin/himawari-chromium \
 && rm -rf /ms-playwright/firefox-* /ms-playwright/webkit-*

COPY himawari-browser.mjs /opt/himawari-browser/himawari-browser.mjs
COPY himawari-browser /usr/local/bin/himawari-browser
RUN chmod 0755 /usr/local/bin/himawari-browser

ENV HOME=/home/himawari \
    HIMAWARI_BROWSER_EXECUTABLE=/usr/local/bin/himawari-chromium \
    MAMBA_ROOT_PREFIX=/home/himawari/.micromamba \
    PIP_USER=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_PREFIX=/home/himawari/.local \
    PATH=/home/himawari/.local/bin:/home/himawari/.micromamba/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /home/himawari
