FROM golang:1.26-alpine AS build

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/infchat-pocketbase ./cmd/server

FROM alpine:3.22

RUN apk add --no-cache ca-certificates ffmpeg

WORKDIR /app

COPY --from=build /out/infchat-pocketbase /app/infchat-pocketbase

EXPOSE 8090

CMD ["/app/infchat-pocketbase", "serve", "--http=0.0.0.0:8090"]
