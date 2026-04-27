FROM alpine:3.22

ARG POCKETBASE_VERSION=0.37.4
ARG TARGETARCH

RUN apk add --no-cache ca-certificates unzip wget \
  && case "$TARGETARCH" in \
    amd64) PB_ARCH=amd64 ;; \
    arm64) PB_ARCH=arm64 ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && wget -O /tmp/pocketbase.zip "https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/pocketbase_${POCKETBASE_VERSION}_linux_${PB_ARCH}.zip" \
  && unzip /tmp/pocketbase.zip -d /app \
  && rm /tmp/pocketbase.zip \
  && chmod +x /app/pocketbase

WORKDIR /app

EXPOSE 8090

CMD ["/app/pocketbase", "serve", "--http=0.0.0.0:8090"]
